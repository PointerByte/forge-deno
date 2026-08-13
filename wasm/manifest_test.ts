// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertInstanceOf, assertRejects, assertThrows } from "@std/assert";
import { WasmCompatibilityError, WasmIntegrityError, WasmManifestError } from "./errors.ts";
import {
  assertPortableContractManifest,
  createFileArtifactReader,
  sha256Hex,
  verifyWasmBundle,
} from "./manifest.ts";
import { createPortableManifestJson, createTestBundle } from "./test_support.ts";

Deno.test("bundle verifier validates manifest, source, glue, and core before factory use", async () => {
  const test = await createTestBundle();
  const bundle = await verifyWasmBundle(test.locator, test.compatibility, test.readArtifact);

  assertEquals(test.reads, [
    "manifest.json",
    "artifacts/goforge.component.wasm",
    "generated/goforge.js",
    "generated/goforge.core.wasm",
  ]);
  assertEquals(bundle.manifest.componentVersion, "1.2.3");
  assertEquals(bundle.manifest.schema, "goforge.bundle-manifest.v1");
  assertEquals(new TextDecoder().decode(bundle.sourceBytes), "component-source");
  assertEquals(bundle.coreModuleBytes.has("goforge.core.wasm"), true);
  assertEquals(Object.isFrozen(bundle.manifest), true);
});

Deno.test("bundle and portable manifests are distinct and agree on every operation", async () => {
  const test = await createTestBundle();
  const bundle = await verifyWasmBundle(test.locator, test.compatibility, test.readArtifact);
  assertPortableContractManifest(createPortableManifestJson(), bundle.manifest);

  const portable = JSON.parse(createPortableManifestJson());
  portable.operations[0].capability = "crypto.sha256";
  assertThrows(
    () => assertPortableContractManifest(JSON.stringify(portable), bundle.manifest),
    WasmCompatibilityError,
  );
  assertThrows(() =>
    assertPortableContractManifest(JSON.stringify(test.manifest), bundle.manifest)
  );
  const duplicatePortable = createPortableManifestJson().replace(
    '"abi":"goforge.abi.v1"',
    '"abi":"goforge.abi.v1","abi":"goforge.abi.v1"',
  );
  assertThrows(
    () => assertPortableContractManifest(duplicatePortable, bundle.manifest),
    WasmCompatibilityError,
  );
});

Deno.test("bundle verifier rejects duplicate JSON fields before artifact reads", async () => {
  const test = await createTestBundle();
  const duplicate = JSON.stringify(test.manifest).replace(
    '"abi":"goforge.abi.v1"',
    '"abi":"goforge.abi.v1","abi":"goforge.abi.v1"',
  );
  const bytes = new TextEncoder().encode(duplicate);
  test.files.set("manifest.json", bytes);
  test.locator.manifestSha256 = await sha256Hex(bytes);
  const error = await assertRejects(() =>
    verifyWasmBundle(test.locator, test.compatibility, test.readArtifact)
  );
  assertInstanceOf(error, WasmManifestError);
  assertEquals(test.reads, ["manifest.json"]);
});

Deno.test("bundle verifier rejects manifest checksum before parsing or artifact reads", async () => {
  const test = await createTestBundle();
  test.locator.manifestSha256 = "0".repeat(64);
  const error = await assertRejects(() =>
    verifyWasmBundle(test.locator, test.compatibility, test.readArtifact)
  );
  assertInstanceOf(error, WasmIntegrityError);
  assertEquals(test.reads, ["manifest.json"]);
});

Deno.test("bundle verifier rejects exact component and WIT mismatches before artifact reads", async () => {
  for (
    const compatibility of [
      { componentVersion: "1.2.4", witPackage: "pointerbyte:goforge@1.2.3" },
      { componentVersion: "1.2.3", witPackage: "pointerbyte:goforge@1.2.4" },
    ]
  ) {
    const test = await createTestBundle();
    const error = await assertRejects(() =>
      verifyWasmBundle(test.locator, compatibility, test.readArtifact)
    );
    assertInstanceOf(error, WasmCompatibilityError);
    assertEquals(test.reads, ["manifest.json"]);
  }
});

Deno.test("bundle verifier rejects tampering in every production artifact", async () => {
  for (
    const path of [
      "artifacts/goforge.component.wasm",
      "generated/goforge.js",
      "generated/goforge.core.wasm",
    ]
  ) {
    const test = await createTestBundle();
    test.files.set(path, new TextEncoder().encode("tampered"));
    const error = await assertRejects(() =>
      verifyWasmBundle(test.locator, test.compatibility, test.readArtifact)
    );
    assertInstanceOf(error, WasmIntegrityError);
  }
});

Deno.test("bundle verifier rejects traversal, duplicate artifacts, and unknown schema fields", async () => {
  const mutations: Array<(manifest: Record<string, unknown>) => void> = [
    (manifest) => {
      (manifest.source as Record<string, unknown>).path = "../component.wasm";
    },
    (manifest) => {
      (manifest.source as Record<string, unknown>).path = "%2e%2e/component.wasm";
    },
    (manifest) => {
      (manifest.glue as Record<string, unknown>).path =
        (manifest.source as Record<string, unknown>).path;
    },
    (manifest) => {
      manifest.unreviewed = true;
    },
    (manifest) => {
      manifest.operations = {};
    },
  ];
  for (const mutate of mutations) {
    const test = await createTestBundle(mutate);
    const error = await assertRejects(() =>
      verifyWasmBundle(test.locator, test.compatibility, test.readArtifact)
    );
    assertInstanceOf(error, WasmManifestError);
  }
});

Deno.test("file reader is limited to file URLs and package-relative paths", async () => {
  assertThrows(() => createFileArtifactReader(new URL("https://example.test/")), WasmManifestError);
  const reader = createFileArtifactReader(new URL("./", import.meta.url));
  const error = await assertRejects(() => reader("../deno.json"));
  assertInstanceOf(error, WasmManifestError);
  assertEquals((await sha256Hex(new Uint8Array())).length, 64);
});
