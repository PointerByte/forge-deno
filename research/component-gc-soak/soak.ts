// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reproduction harness for the GoForge component's garbage-collector trap.
 *
 * Under sustained `operations.dispatch` load the Go runtime inside the production component
 * intermittently traps, surfacing to the host as `RangeError: Maximum call stack size exceeded`
 * with a guest stack of
 * `runtime.morestack -> runtime.badmorestackg0 -> runtime.switchToCrashStack -> runtime.usleep`.
 *
 * The trap is intermittent and its threshold varies widely between otherwise identical cold
 * processes, so it cannot be pinned by an assertion in the main test suite without making that
 * suite flaky. This harness runs the experiment across many cold processes and reports the rate.
 *
 * Deferring collection removes the trap, which is what identifies the collector as the trigger.
 * `GOGC=off` is diagnostic only — it trades the trap for unbounded guest memory growth.
 *
 * Usage:
 * ```
 * deno run -A research/component-gc-soak/soak.ts               # one run, default GC
 * deno run -A research/component-gc-soak/soak.ts --gogc=off    # one run, collection deferred
 * deno run -A research/component-gc-soak/soak.ts --runs=10     # spawn 10 cold child processes
 * ```
 *
 * @module
 */

import { createGeneratedComponentFactory } from "../../wasm/component.ts";
import { verifyWasmBundle } from "../../wasm/manifest.ts";
import { locateProductionBundle } from "../../wasm/test_support.ts";
import { createDeniedWasiImports } from "../../wasm/wasi.ts";

const flags = new Map(
  Deno.args.filter((argument) => argument.startsWith("--")).map((argument) => {
    const [name, value = "true"] = argument.slice(2).split("=");
    return [name, value];
  }),
);
const dispatches = Number(flags.get("dispatches") ?? 20_000);
const gogc = flags.get("gogc");
const runs = Number(flags.get("runs") ?? 0);

if (runs > 0) {
  await spawnColdRuns();
} else {
  console.log(await measure());
}

/** Runs one soak in this process and reports where it stopped. */
async function measure(): Promise<string> {
  const bundle = await locateProductionBundle();
  if (!bundle) return "SKIP (no release bundle; build it with component/scripts/build.sh)";

  const verified = await verifyWasmBundle(
    bundle.locator,
    bundle.compatibility,
    bundle.readArtifact,
  );
  const wasiImports = createDeniedWasiImports();
  if (gogc !== undefined) {
    wasiImports["wasi:cli/environment"] = {
      getArguments: (): string[] => [],
      getEnvironment: (): Array<[string, string]> => [["GOGC", gogc]],
      initialCwd: (): undefined => undefined,
    };
  }
  const instance = await createGeneratedComponentFactory({ wasiImports }).create(verified, {
    instanceId: 1,
    signal: new AbortController().signal,
  });
  const request = JSON.stringify({
    abi: "goforge.abi.v1",
    id: "soak",
    operation: "crypto.sha256",
    payload: { data: "" },
  });
  const state = {
    clockChecked: false,
    nowUnixMilliseconds: 0,
    cancellationChecked: false,
    cancellationToken: "",
    cancellationRequested: false,
  };

  let completed = 0;
  try {
    for (; completed < dispatches; completed++) instance.dispatch(request, state);
    return `OK ${completed}`;
  } catch {
    return `TRAP ${completed}`;
  } finally {
    await instance.close?.();
  }
}

/** Spawns cold child processes so each measurement starts from a fresh isolate. */
async function spawnColdRuns(): Promise<void> {
  const childArguments = [
    "run",
    "-A",
    new URL(import.meta.url).pathname,
    `--dispatches=${dispatches}`,
  ];
  if (gogc !== undefined) childArguments.push(`--gogc=${gogc}`);

  const results: string[] = [];
  for (let run = 0; run < runs; run++) {
    const { stdout } = await new Deno.Command(Deno.execPath(), {
      args: childArguments,
      stdout: "piped",
      stderr: "null",
    }).output();
    results.push(new TextDecoder().decode(stdout).trim());
  }
  const traps = results.filter((result) => result.startsWith("TRAP"));
  console.log(`GOGC=${gogc ?? "default"} dispatches=${dispatches} runs=${runs}`);
  for (const result of results) console.log(`  ${result}`);
  console.log(`trap rate: ${traps.length}/${runs}`);
  if (traps.length > 0) {
    const counts = traps.map((result) => Number(result.split(" ")[1])).sort((a, b) => a - b);
    console.log(`trap thresholds: ${counts.join(", ")}`);
  }
}
