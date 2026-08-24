// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@std/assert";
import { generate } from "./api_inventory.ts";

Deno.test("API inventory covers every configured package export deterministically", async () => {
  const directory = await Deno.makeTempDir({ prefix: "denoforge-api-inventory-" });
  const output = `${directory}/inventory.json`;
  try {
    await generate(["--generated-at", "2026-08-02T00:00:00Z", "--json", output]);
    const inventory = JSON.parse(await Deno.readTextFile(output)) as {
      generatedAt: string;
      summary: { entrypoints: number; apis: number };
      exports: Array<{ specifier: string }>;
    };
    const config = JSON.parse(await Deno.readTextFile("deno.json")) as {
      exports: Record<string, string>;
    };
    assertEquals(inventory.generatedAt, "2026-08-02T00:00:00Z");
    assertEquals(inventory.summary.entrypoints, Object.keys(config.exports).length);
    assertEquals(
      inventory.exports.map((item) => item.specifier),
      Object.keys(config.exports),
    );
    assert(inventory.summary.apis > 0);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
