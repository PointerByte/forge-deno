// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Measures per-dispatch latency for the TinyGo and componentize-go builds side by side.
 *
 * Endurance and parity decide whether the compiler *can* be switched; this decides what the switch
 * costs. Both components run the same operations on the same host in the same process.
 *
 * componentize-go traps under sustained default-GC load, so it is measured with collection deferred
 * — its best case. TinyGo is measured under its normal configuration. The comparison is therefore
 * conservative against TinyGo.
 *
 * ```
 * deno run -A research/component-gc-soak/tinygo_throughput.ts
 * ```
 *
 * @module
 */

import { loadTinyGoOperations, UNCHECKED_STATE } from "./tinygo_component.ts";
import { createGeneratedComponentFactory } from "../../wasm/component.ts";
import { verifyWasmBundle } from "../../wasm/manifest.ts";
import { locateProductionBundle } from "../../wasm/test_support.ts";
import { createDeniedWasiImports } from "../../wasm/wasi.ts";
import type { WasmComponentInstance } from "../../wasm/runtime.ts";

const ITERATIONS = 2_000;
const KIB = "a".repeat(1024);

const WORKLOADS: ReadonlyArray<{ label: string; request: Record<string, unknown> }> = [
  { label: "crypto.sha256", request: { operation: "crypto.sha256", payload: { data: btoa(KIB) } } },
  {
    label: "crypto.hmac-sha256",
    request: {
      operation: "crypto.hmac-sha256",
      payload: { key: btoa("key"), data: btoa(KIB) },
    },
  },
  {
    label: "text.normalize",
    request: { operation: "text.normalize", payload: { value: KIB, trim: true } },
  },
  {
    label: "encoding.base64.encode",
    request: { operation: "encoding.base64.encode", payload: { data: btoa(KIB) } },
  },
];

const tinygo = await loadTinyGoOperations();
if (!tinygo) {
  console.log("SKIP (no transpiled TinyGo component)");
  Deno.exit(0);
}

const bundle = await locateProductionBundle();
let componentize: WasmComponentInstance | null = null;
if (bundle) {
  const verified = await verifyWasmBundle(
    bundle.locator,
    bundle.compatibility,
    bundle.readArtifact,
  );
  // Collection deferred: the default-GC configuration cannot survive this many dispatches.
  const wasiImports = createDeniedWasiImports();
  wasiImports["wasi:cli/environment"] = {
    getArguments: (): string[] => [],
    getEnvironment: (): Array<[string, string]> => [["GOGC", "off"]],
    initialCwd: (): undefined => undefined,
  };
  componentize = await createGeneratedComponentFactory({ wasiImports }).create(verified, {
    instanceId: 1,
    signal: new AbortController().signal,
  });
}

console.log(`${ITERATIONS} dispatches per operation, 1 KiB payloads\n`);
console.log("| Operation | TinyGo | componentize-go (GOGC=off) | TinyGo speedup |");
console.log("|---|---|---|---|");

for (const workload of WORKLOADS) {
  const request = JSON.stringify({ abi: "goforge.abi.v1", id: "bench", ...workload.request });
  const tinygoMicros = measure(() => tinygo.dispatch(request, UNCHECKED_STATE));
  const componentizeMicros = componentize
    ? measure(() =>
      synchronous(componentize.dispatch(request, {
        clockChecked: false,
        nowUnixMilliseconds: 0,
        cancellationChecked: false,
        cancellationToken: "",
        cancellationRequested: false,
      }))
    )
    : Number.NaN;
  const speedup = componentizeMicros / tinygoMicros;
  console.log(
    `| \`${workload.label}\` | ${tinygoMicros.toFixed(1)} µs | ${
      componentizeMicros.toFixed(1)
    } µs | ${speedup.toFixed(1)}× |`,
  );
}

/**
 * Narrows a component response to the synchronous case.
 *
 * `WasmComponentInstance.dispatch` is declared as possibly asynchronous so the runtime can host
 * future factories. Awaiting inside the timing loop would measure microtask scheduling as well as
 * the guest, so this asserts the shape instead of silently timing something else.
 */
function synchronous(result: string | Promise<string>): string {
  if (typeof result !== "string") {
    throw new TypeError("the component dispatched asynchronously; this harness times sync calls");
  }
  return result;
}

/** Times `run` over {@link ITERATIONS} calls after a short warm-up, in microseconds per call. */
function measure(run: () => string): number {
  for (let index = 0; index < 200; index++) run();
  const started = performance.now();
  for (let index = 0; index < ITERATIONS; index++) run();
  return ((performance.now() - started) * 1000) / ITERATIONS;
}
