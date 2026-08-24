// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/** Verify that the committed Deno API inventory matches current exports. */

import { generate } from "./api_inventory.ts";

const committed =
  "openspec/changes/tinygo-wasip2-goforge-integration/research/evidence/deno-api-inventory.json";
const directory = await Deno.makeTempDir({ prefix: "denoforge-inventory-check-" });
const generated = `${directory}/deno-api-inventory.json`;

try {
  await generate([
    "--generated-at",
    "2026-08-02T00:00:00Z",
    "--json",
    generated,
  ]);
  const [expected, actual] = await Promise.all([
    Deno.readTextFile(committed),
    Deno.readTextFile(generated),
  ]);
  if (actual !== expected) {
    console.error("forge-deno API inventory drifted; run `deno task inventory` and review it.");
    Deno.exit(1);
  }
  console.log("forge-deno API inventory is current.");
} finally {
  await Deno.remove(directory, { recursive: true });
}
