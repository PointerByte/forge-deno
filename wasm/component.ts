// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Production {@link WasmComponentFactory} for jco-transpiled GoForge components.
 *
 * The factory is the seam between {@link GoforgeWasmRuntime}'s integrity verification and the
 * generated host glue. It only ever executes bytes the runtime already verified: the glue module is
 * imported from an in-memory blob built from `bundle.glueBytes`, and every core module is compiled
 * from `bundle.coreModuleBytes`. Nothing is re-read from disk after verification, so a file swapped
 * between digest check and instantiation cannot be executed.
 *
 * WASI imports come from {@link createDeniedWasiImports}, which withholds every capability the
 * portable contract does not need.
 *
 * @example Load a verified release bundle
 * ```ts
 * import {
 *   createFileArtifactReader,
 *   createGeneratedComponentFactory,
 *   GoforgeWasmRuntime,
 * } from "@pointerbyte/denoforge/wasm";
 *
 * const runtime = new GoforgeWasmRuntime({
 *   bundle: { manifestPath: "manifest.json", manifestSha256: trustedDigest },
 *   compatibility: { componentVersion: "0.1.0", witPackage: "pointerbyte:goforge@0.1.0" },
 *   readArtifact: createFileArtifactReader(new URL("./artifacts/", import.meta.url)),
 *   factory: createGeneratedComponentFactory(),
 * });
 * const digest = await runtime.invoke("crypto.sha256", { data: "" });
 * ```
 *
 * @module
 */

import type { AbiExecutionStateV1, VerifiedWasmBundle } from "./contracts.ts";
import { WasmCompatibilityError, WasmInvocationError } from "./errors.ts";
import type {
  WasmComponentFactory,
  WasmComponentFactoryContext,
  WasmComponentInstance,
} from "./runtime.ts";
import { createDeniedWasiImports } from "./wasi.ts";

/** WIT-generated execution-state record; field names come from the `goforge` world. */
interface GeneratedExecutionState {
  clockChecked: boolean;
  nowUnixMilliseconds: bigint;
  cancellationChecked: boolean;
  cancellationToken: string;
  cancellationRequested: boolean;
}

/** The exported `pointerbyte:goforge/operations@0.1.0` interface. */
interface GeneratedOperations {
  manifest(): string;
  dispatch(requestJson: string, state: GeneratedExecutionState): string;
}

/** Root object returned by jco's async `instantiate`. */
interface GeneratedRoot {
  operations?: GeneratedOperations;
  "pointerbyte:goforge/operations@0.1.0"?: GeneratedOperations;
}

/** Shape of the glue module produced by `jco transpile --instantiation async`. */
interface GeneratedGlueModule {
  instantiate(
    getCoreModule: (name: string) => WebAssembly.Module | Promise<WebAssembly.Module>,
    imports: unknown,
    instantiateCore?: typeof WebAssembly.instantiate,
  ): GeneratedRoot | Promise<GeneratedRoot>;
}

/** Options for {@link createGeneratedComponentFactory}. */
export interface GeneratedComponentFactoryOptions {
  /**
   * Overrides the WASI import object. The default denies every capability the portable core does
   * not need; supplying a broader object widens the guest's authority and must be justified.
   */
  wasiImports?: Record<string, Record<string, unknown>>;
  /**
   * Compiles core modules once per bundle instead of once per instance. Enabled by default: the
   * bytes are already verified and `WebAssembly.Module` objects are immutable and shareable, while
   * each instance still gets its own isolated linear memory.
   */
  cacheCompiledModules?: boolean;
}

/**
 * Creates a factory that instantiates verified jco-transpiled component bundles.
 *
 * @param options Optional WASI and compilation-cache overrides.
 */
export function createGeneratedComponentFactory(
  options: GeneratedComponentFactoryOptions = {},
): WasmComponentFactory {
  const cacheCompiledModules = options.cacheCompiledModules ?? true;
  const glueCache = new WeakMap<Readonly<VerifiedWasmBundle>, Promise<GeneratedGlueModule>>();
  const moduleCache = new WeakMap<
    Readonly<VerifiedWasmBundle>,
    Map<string, Promise<WebAssembly.Module>>
  >();

  return {
    async create(
      bundle: Readonly<VerifiedWasmBundle>,
      _context: WasmComponentFactoryContext,
    ): Promise<WasmComponentInstance> {
      let glue = glueCache.get(bundle);
      if (!glue) {
        glue = importGlue(bundle.glueBytes);
        glueCache.set(bundle, glue);
      }
      const generated = await glue;

      let compiled = moduleCache.get(bundle);
      if (!compiled) {
        compiled = new Map();
        if (cacheCompiledModules) moduleCache.set(bundle, compiled);
      }
      const getCoreModule = (name: string): Promise<WebAssembly.Module> => {
        const existing = compiled.get(name);
        if (existing) return existing;
        const bytes = bundle.coreModuleBytes.get(name);
        if (!bytes) {
          return Promise.reject(
            new WasmCompatibilityError(
              `the generated glue requested unmanifested core module ${JSON.stringify(name)}`,
            ),
          );
        }
        const module = WebAssembly.compile(Uint8Array.from(bytes).buffer);
        compiled.set(name, module);
        return module;
      };

      let root: GeneratedRoot;
      try {
        root = await generated.instantiate(
          getCoreModule,
          (options.wasiImports ?? createDeniedWasiImports()) as never,
        );
      } catch (cause) {
        if (cause instanceof WasmCompatibilityError) throw cause;
        throw new WasmInvocationError("generated component instantiation failed", { cause });
      }

      // jco strips interface versions from the runtime root in instantiation mode while its
      // declaration retains them. Accept either shape at this single documented seam.
      const operations = root.operations ?? root["pointerbyte:goforge/operations@0.1.0"];
      if (
        !operations || typeof operations.manifest !== "function" ||
        typeof operations.dispatch !== "function"
      ) {
        throw new WasmCompatibilityError(
          "the generated component does not export pointerbyte:goforge/operations@0.1.0",
        );
      }

      let closed = false;
      return {
        manifest(): string {
          assertOpen(closed);
          return operations.manifest();
        },
        dispatch(requestJson: string, state: AbiExecutionStateV1): string {
          assertOpen(closed);
          return operations.dispatch(requestJson, toGeneratedState(state));
        },
        close(): void {
          // Releasing the reference lets the isolate reclaim the instance's linear memory. The
          // component owns no host handles because every WASI capability is denied.
          closed = true;
        },
      };
    },
  };
}

async function importGlue(glueBytes: Uint8Array): Promise<GeneratedGlueModule> {
  const url = URL.createObjectURL(
    new Blob([Uint8Array.from(glueBytes)], { type: "text/javascript" }),
  );
  try {
    const module = await import(url) as Partial<GeneratedGlueModule>;
    if (typeof module.instantiate !== "function") {
      throw new WasmCompatibilityError(
        "the verified glue does not export a jco async instantiate function",
      );
    }
    return module as GeneratedGlueModule;
  } catch (cause) {
    if (cause instanceof WasmCompatibilityError) throw cause;
    throw new WasmInvocationError("the verified component glue could not be imported", { cause });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toGeneratedState(state: AbiExecutionStateV1): GeneratedExecutionState {
  return {
    clockChecked: state.clockChecked,
    nowUnixMilliseconds: BigInt(Math.trunc(state.nowUnixMilliseconds)),
    cancellationChecked: state.cancellationChecked,
    cancellationToken: state.cancellationToken,
    cancellationRequested: state.cancellationRequested,
  };
}

function assertOpen(closed: boolean): void {
  if (closed) throw new WasmInvocationError("the generated component instance is closed");
}
