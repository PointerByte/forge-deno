// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { GOFORGE_ABI_V1_OPERATIONS } from "./contracts.ts";
import type { AbiRequestV1, AbiResponseV1 } from "./contracts.ts";
import { WasmAdapterError } from "./errors.ts";

const adapterNamePattern = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;
const portableOperations = new Set<string>(GOFORGE_ABI_V1_OPERATIONS);

/** Cancellation and attempt metadata supplied to a native adapter. */
export interface NativeAdapterContext {
  /** Combined caller, deadline, and runtime-shutdown signal. */
  signal: AbortSignal;
  /** One-based attempt number. */
  attempt: number;
  /** Absolute Unix epoch deadline in milliseconds, when configured. */
  deadlineUnixMs?: number;
}

/**
 * An explicitly configured Deno implementation of a host-bound GoForge contract.
 *
 * Native adapters are never selected as fallback. The call target, manifest operation allowlist,
 * adapter operation allowlist, and parity qualification must all agree before invocation.
 */
export interface NativeWasmAdapter {
  /** Stable adapter name referenced by the component manifest. */
  readonly name: string;
  /** Operations implemented with the same ABI contract. */
  readonly operations: readonly string[];
  /** Whether shared parity vectors qualified this exact adapter implementation. */
  readonly parityQualified: boolean;
  /** Executes an already encoded ABI request and returns an encoded ABI response. */
  invoke(request: Readonly<AbiRequestV1>, context: NativeAdapterContext): Promise<AbiResponseV1>;
  /** Releases native SDK clients or other adapter-owned resources. */
  close?(): void | Promise<void>;
}

/**
 * Adapters whose parity qualification was actually performed.
 *
 * `parityQualified` is a plain interface field, so any object literal can claim
 * it. That is not good enough for a flag that decides whether cryptography runs
 * outside the verified guest, so the flag alone is not trusted: an adapter must
 * also be present in this ledger, which only {@link recordParityQualification}
 * can add to. A forged copy — `{ ...adapter, parityQualified: true }` — is a
 * different object and is therefore absent from the ledger.
 */
const qualificationLedger = new WeakSet<NativeWasmAdapter>();

/**
 * Records that `adapter` has passed parity qualification against GoForge's shared vectors.
 *
 * Call this only from code that has just run the vectors and compared the results. It is the
 * single admission point for {@link NativeAdapterRegistry}; declaring `parityQualified: true`
 * without it is rejected at registration.
 *
 * @param adapter The adapter that just passed qualification.
 * @returns The same adapter, for chaining.
 * @throws {WasmAdapterError} When the adapter does not declare `parityQualified: true`.
 */
export function recordParityQualification<T extends NativeWasmAdapter>(adapter: T): T {
  if (adapter.parityQualified !== true) {
    throw new WasmAdapterError(
      `native adapter ${JSON.stringify(adapter.name)} cannot be recorded as qualified ` +
        "because it does not declare parityQualified: true",
    );
  }
  qualificationLedger.add(adapter);
  return adapter;
}

/**
 * Reports whether `adapter` was recorded as parity-qualified by {@link recordParityQualification}.
 *
 * This is the authoritative check. The `parityQualified` field is only a declaration.
 *
 * @param adapter The adapter to test.
 */
export function isParityQualified(adapter: NativeWasmAdapter): boolean {
  return qualificationLedger.has(adapter);
}

/** Registry used only for explicit, manifest-approved native adapter routing. */
export class NativeAdapterRegistry {
  readonly #adapters = new Map<string, NativeWasmAdapter>();
  #closed = false;

  /** Registers one adapter and rejects ambiguous duplicate names. */
  register(adapter: NativeWasmAdapter): this {
    if (this.#closed) throw new WasmAdapterError("native adapter registry is closed");
    validateAdapter(adapter);
    if (this.#adapters.has(adapter.name)) {
      throw new WasmAdapterError(
        `native adapter ${JSON.stringify(adapter.name)} is already registered`,
      );
    }
    this.#adapters.set(adapter.name, adapter);
    return this;
  }

  /** Removes an adapter before runtime shutdown. */
  unregister(name: string): boolean {
    if (this.#closed) throw new WasmAdapterError("native adapter registry is closed");
    return this.#adapters.delete(name);
  }

  /** Lists registered names in deterministic order without exposing adapter objects. */
  names(): string[] {
    return [...this.#adapters.keys()].sort();
  }

  /** Resolves a parity-qualified adapter allowed by both registry and manifest. */
  resolve(
    name: string,
    operation: string,
    manifestAllowlist: readonly string[],
  ): NativeWasmAdapter {
    if (this.#closed) throw new WasmAdapterError("native adapter registry is closed");
    const adapter = this.#adapters.get(name);
    if (!adapter) {
      throw new WasmAdapterError(`native adapter ${JSON.stringify(name)} is not registered`);
    }
    if (!manifestAllowlist.includes(name)) {
      throw new WasmAdapterError(
        `native adapter ${JSON.stringify(name)} is not approved for operation ${
          JSON.stringify(operation)
        }`,
      );
    }
    if (!adapter.operations.includes(operation)) {
      throw new WasmAdapterError(
        `native adapter ${JSON.stringify(name)} does not implement operation ${
          JSON.stringify(operation)
        }`,
      );
    }
    if (!adapter.parityQualified || !isParityQualified(adapter)) {
      throw new WasmAdapterError(
        `native adapter ${JSON.stringify(name)} has not passed shared parity qualification`,
      );
    }
    return adapter;
  }

  /** Idempotently closes every registered adapter. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const failures: unknown[] = [];
    for (
      const [, adapter] of [...this.#adapters.entries()].sort(([a], [b]) => a.localeCompare(b))
    ) {
      try {
        await adapter.close?.();
      } catch (cause) {
        failures.push(cause);
      }
    }
    this.#adapters.clear();
    if (failures.length > 0) {
      throw new WasmAdapterError("one or more native adapters failed to close", {
        cause: new AggregateError(failures),
      });
    }
  }
}

function validateAdapter(adapter: NativeWasmAdapter): void {
  if (!adapterNamePattern.test(adapter.name)) {
    throw new WasmAdapterError(`invalid native adapter name ${JSON.stringify(adapter.name)}`);
  }
  if (!Array.isArray(adapter.operations) || adapter.operations.length === 0) {
    throw new WasmAdapterError(`native adapter ${JSON.stringify(adapter.name)} has no operations`);
  }
  const seen = new Set<string>();
  for (const operation of adapter.operations) {
    if (!portableOperations.has(operation) || seen.has(operation)) {
      throw new WasmAdapterError(
        `native adapter ${JSON.stringify(adapter.name)} has an invalid or duplicate operation`,
      );
    }
    seen.add(operation);
  }
  if (typeof adapter.parityQualified !== "boolean" || typeof adapter.invoke !== "function") {
    throw new WasmAdapterError(`native adapter ${JSON.stringify(adapter.name)} is malformed`);
  }
  // A declaration is not evidence. Reject a claim of qualification that no
  // qualification run ever recorded, rather than letting it reach resolve().
  if (adapter.parityQualified && !qualificationLedger.has(adapter)) {
    throw new WasmAdapterError(
      `native adapter ${JSON.stringify(adapter.name)} claims parity qualification that was ` +
        "never performed; qualify it and record the result before registering it",
    );
  }
}
