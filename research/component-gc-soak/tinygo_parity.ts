// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves the TinyGo build is contract-identical to the shipped componentize-go component.
 *
 * A clean soak only matters if the guest still returns the right bytes. This harness replays every
 * shared vector through the TinyGo component and compares each response against the recorded native
 * Go response, then compares the two components' canonical manifests field by field.
 *
 * A compiler switch cannot be recommended on endurance evidence alone; this is the other half.
 *
 * ```
 * deno run -A research/component-gc-soak/tinygo_parity.ts
 * ```
 *
 * @module
 */

import { loadTinyGoOperations, UNCHECKED_STATE } from "./tinygo_component.ts";
import { locateProductionBundle } from "../../wasm/test_support.ts";

interface Vector {
  name: string;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}

const operations = await loadTinyGoOperations();
if (!operations) {
  console.log(
    "SKIP (no transpiled TinyGo component; run scripts/build.sh && scripts/transpile.sh)",
  );
  Deno.exit(0);
}

const vectorsUrl = new URL("../../wasm/testdata/vectors/v1.json", import.meta.url);
const { vectors } = JSON.parse(await Deno.readTextFile(vectorsUrl)) as { vectors: Vector[] };

let failures = 0;

for (const vector of vectors) {
  const actual = JSON.parse(operations.dispatch(JSON.stringify(vector.request), UNCHECKED_STATE));
  const expected = vector.response;
  if (canonical(actual) === canonical(expected)) {
    console.log(`  ok    ${vector.name}`);
    continue;
  }
  failures++;
  console.log(`  FAIL  ${vector.name}`);
  console.log(`        expected ${canonical(expected)}`);
  console.log(`        actual   ${canonical(actual)}`);
}

// The manifest is the contract itself: operations, capabilities, limits and the ordered error
// catalog. If the two compilers disagree here, they are not interchangeable regardless of vectors.
const bundle = await locateProductionBundle();
if (bundle) {
  const production = JSON.parse(
    new TextDecoder().decode(await bundle.readArtifact("goforge.abi.manifest.json")),
  );
  const tinygo = JSON.parse(operations.manifest());
  if (canonical(tinygo) === canonical(production)) {
    console.log("  ok    manifest identical to the componentize-go component");
  } else {
    failures++;
    console.log("  FAIL  manifest differs from the componentize-go component");
    for (const key of new Set([...Object.keys(production), ...Object.keys(tinygo)])) {
      if (canonical(production[key]) !== canonical(tinygo[key])) {
        console.log(`        field ${key}`);
      }
    }
  }
} else {
  console.log("  skip  manifest comparison (no production bundle to compare against)");
}

console.log(
  failures === 0
    ? `\nPARITY OK — ${vectors.length} shared vectors reproduced exactly by the TinyGo build.`
    : `\nPARITY FAILED — ${failures} mismatch(es).`,
);
Deno.exit(failures === 0 ? 0 : 1);

/** Serializes with sorted keys so field order never masks or invents a difference. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    return Object.fromEntries(
      Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  });
}
