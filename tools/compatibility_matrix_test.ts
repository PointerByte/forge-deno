// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "@std/assert";
import { buildMatrix } from "./compatibility_matrix.ts";

Deno.test("compatibility matrix represents exact matches and explicit exceptions", () => {
  const matrix = buildMatrix({
    schemaVersion: "1",
    apis: [
      {
        id: "example/encrypt.Hash",
        package: "example/encrypt",
        directory: "encrypt/local",
        file: "encrypt/hash.go",
        line: 1,
        name: "Hash",
        kind: "function",
        classification: "Stable",
        documented: true,
        tested: true,
        benchmarked: true,
        portability: "portable-candidate",
      },
      {
        id: "example/config.Serve",
        package: "example/config",
        directory: "config/server/grpc",
        file: "config/server.go",
        line: 2,
        name: "Serve",
        kind: "function",
        classification: "Stable",
        documented: true,
        tested: true,
        benchmarked: false,
        portability: "host-dependent",
      },
    ],
  }, {
    schemaVersion: "1",
    apis: [{
      id: "./encrypt:hash",
      specifier: "./encrypt",
      name: "hash",
      kind: "function",
      source: "encrypt/hash.ts",
      line: 1,
      documented: true,
    }],
  }, "2026-08-02T00:00:00Z");

  assertEquals(matrix.summary.goPublicApis, 2);
  assertEquals(matrix.summary.represented, 2);
  assertEquals(matrix.summary.representationCoveragePercent, 100);
  assertEquals(matrix.summary.exactNativeEquivalents, 1);
  assertEquals(matrix.summary.documentedExceptions, 1);
  assertEquals(matrix.rows.find((row) => row.goApi.endsWith(".Hash"))?.wasmClass, "A");
  assertEquals(matrix.rows.find((row) => row.goApi.endsWith(".Serve"))?.wasmClass, "D");
});
