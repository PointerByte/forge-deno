// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs the {@link ./soak.ts | production soak workload} against the **TinyGo** build of the same
 * `pointerbyte:goforge@0.1.0` world, on the same Deno + jco host.
 *
 * `soak.ts` measures the shipped componentize-go bundle. This harness holds the host, the workload
 * and the guest source constant and varies only the compiler, which is what makes the two trap rates
 * comparable.
 *
 * Build the inputs first:
 * ```
 * cd forge-go-private/research/component-tinygo
 * ./scripts/build.sh && ./scripts/transpile.sh
 * ```
 *
 * Usage:
 * ```
 * deno run -A research/component-gc-soak/tinygo_soak.ts               # one run, default GC
 * deno run -A research/component-gc-soak/tinygo_soak.ts --gogc=off    # collection deferred
 * deno run -A research/component-gc-soak/tinygo_soak.ts --runs=10     # 10 cold child processes
 * ```
 *
 * @module
 */

import { loadTinyGoOperations, UNCHECKED_STATE } from "./tinygo_component.ts";

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
  const operations = await loadTinyGoOperations({ gogc });
  if (!operations) {
    return "SKIP (no transpiled TinyGo component; run scripts/build.sh && scripts/transpile.sh)";
  }

  const request = JSON.stringify({
    abi: "goforge.abi.v1",
    id: "soak",
    operation: "crypto.sha256",
    payload: { data: "" },
  });

  // Prove the guest speaks the canonical contract before measuring endurance; a component that
  // returns the wrong bytes would make a clean soak meaningless.
  const first = JSON.parse(operations.dispatch(request, UNCHECKED_STATE));
  if (first?.result?.digest !== "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=") {
    return `MISMATCH ${JSON.stringify(first).slice(0, 160)}`;
  }

  let completed = 0;
  try {
    for (; completed < dispatches; completed++) operations.dispatch(request, UNCHECKED_STATE);
    return `OK ${completed}`;
  } catch {
    return `TRAP ${completed}`;
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
  console.log(`TinyGo GOGC=${gogc ?? "default"} dispatches=${dispatches} runs=${runs}`);
  for (const result of results) console.log(`  ${result}`);
  console.log(`trap rate: ${traps.length}/${runs}`);
  if (traps.length > 0) {
    const counts = traps.map((result) => Number(result.split(" ")[1])).sort((a, b) => a - b);
    console.log(`trap thresholds: ${counts.join(", ")}`);
  }
}
