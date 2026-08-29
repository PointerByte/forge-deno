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
        id: "example/pkcs11.NewRepository",
        package: "example/pkcs11",
        directory: "encrypt/pkcs11",
        file: "encrypt/pkcs11/repository.go",
        line: 3,
        name: "NewRepository",
        kind: "function",
        classification: "Stable",
        documented: true,
        tested: true,
        benchmarked: false,
        portability: "host-dependent",
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

  assertEquals(matrix.summary.goPublicApis, 3);
  assertEquals(matrix.summary.represented, 3);
  assertEquals(matrix.summary.representationCoveragePercent, 100);
  assertEquals(matrix.summary.exactNativeEquivalents, 1);
  assertEquals(matrix.summary.documentedExceptions, 2);
  assertEquals(matrix.rows.find((row) => row.goApi.endsWith(".Hash"))?.wasmClass, "A");
  assertEquals(matrix.rows.find((row) => row.goApi.endsWith(".Serve"))?.wasmClass, "D");
});

Deno.test("the PKCS#11 backend is its own module, not local crypto", () => {
  const matrix = buildMatrix({
    schemaVersion: "1",
    apis: [{
      id: "example/pkcs11.NewRepository",
      package: "example/pkcs11",
      directory: "encrypt/pkcs11",
      file: "encrypt/pkcs11/repository.go",
      line: 1,
      name: "NewRepository",
      kind: "function",
      classification: "Stable",
      documented: true,
      tested: true,
      benchmarked: false,
      portability: "host-dependent",
    }],
  }, {
    schemaVersion: "1",
    apis: [{
      id: "./encrypt/pkcs11:newPkcs11Provider",
      specifier: "./encrypt/pkcs11",
      name: "newPkcs11Provider",
      kind: "function",
      source: "encrypt/pkcs11/repository.ts",
      line: 1,
      documented: true,
    }],
  }, "2026-08-02T00:00:00Z");

  const row = matrix.rows[0];
  assertEquals(row.module, "PKCS#11 HSM");
  // The row points at the focused entrypoint rather than a symbol: forge-go
  // names the constructor `NewRepository` while forge-deno names it
  // `newPkcs11Provider`, which the name matcher cannot equate — the same
  // documented exception every cloud backend constructor already carries.
  assertEquals(row.denoRepresentative, "./encrypt/pkcs11");
  assertEquals(row.currentDenoStatus, "documented-exception");
  // The vendor library can only be reached from the host, the way a cloud
  // backend's endpoint can, so the capability is hybrid rather than portable.
  assertEquals(row.wasmClass, "E");
  assertEquals(row.priority, "critical");
});
