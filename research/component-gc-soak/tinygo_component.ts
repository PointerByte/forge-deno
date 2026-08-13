// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Loads the TinyGo comparison build of `pointerbyte:goforge@0.1.0` for the research harnesses.
 *
 * The TinyGo output is a comparison artifact, not a release: it has no signed manifest, so it is
 * loaded directly instead of through {@link ../../wasm/manifest.ts | bundle verification}. Nothing
 * in the published package imports this module.
 *
 * @module
 */

import { createDeniedWasiImports } from "../../wasm/wasi.ts";

/** Where `forge-go-private/research/component-tinygo/scripts/transpile.sh` writes the host glue. */
export const TINYGO_GLUE_URL = new URL(
  "../../../forge-go-private/research/component-tinygo/artifacts/host/goforge.js",
  import.meta.url,
);

/** WIT execution-state record, as the generated glue expects it. */
export interface TinyGoExecutionState {
  clockChecked: boolean;
  nowUnixMilliseconds: bigint;
  cancellationChecked: boolean;
  cancellationToken: string;
  cancellationRequested: boolean;
}

/** The exported `pointerbyte:goforge/operations@0.1.0` interface. */
export interface TinyGoOperations {
  manifest(): string;
  dispatch(requestJson: string, state: TinyGoExecutionState): string;
}

/** Execution state with no host controls asserted, matching the soak and parity workloads. */
export const UNCHECKED_STATE: TinyGoExecutionState = Object.freeze({
  clockChecked: false,
  nowUnixMilliseconds: 0n,
  cancellationChecked: false,
  cancellationToken: "",
  cancellationRequested: false,
});

/** Options for {@link loadTinyGoOperations}. */
export interface LoadTinyGoOptions {
  /** Overrides `GOGC` in the guest environment. Diagnostic only. */
  gogc?: string;
  /** Overrides the transpiled glue location. */
  glue?: URL;
}

/**
 * Instantiates the TinyGo component, or returns `null` when it has not been built.
 *
 * @param options Optional guest environment and glue location overrides.
 */
export async function loadTinyGoOperations(
  options: LoadTinyGoOptions = {},
): Promise<TinyGoOperations | null> {
  const glueUrl = options.glue ?? TINYGO_GLUE_URL;
  let glue: {
    instantiate(
      getCoreModule: (name: string) => Promise<WebAssembly.Module>,
      imports: unknown,
    ): Promise<Record<string, unknown>>;
  };
  try {
    glue = await import(glueUrl.href);
  } catch {
    return null;
  }

  const wasiImports = createDeniedWasiImports();
  if (options.gogc !== undefined) {
    wasiImports["wasi:cli/environment"] = {
      getArguments: (): string[] => [],
      getEnvironment: (): Array<[string, string]> => [["GOGC", options.gogc as string]],
      initialCwd: (): undefined => undefined,
    };
  }

  const root = await glue.instantiate(
    async (name: string) =>
      await WebAssembly.compile(await Deno.readFile(new URL(`./${name}`, glueUrl))),
    wasiImports,
  );
  return (root["operations"] ??
    root["pointerbyte:goforge/operations@0.1.0"]) as TinyGoOperations;
}
