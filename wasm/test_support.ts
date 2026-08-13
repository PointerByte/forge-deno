// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  GOFORGE_ABI_V1,
  GOFORGE_ABI_V1_OPERATION_CAPABILITIES,
  GOFORGE_ABI_V1_OPERATIONS,
  GOFORGE_BUNDLE_MANIFEST_SCHEMA_V1,
  GOFORGE_PORTABLE_MANIFEST_SCHEMA_V1,
  GOFORGE_PORTABLE_PACKAGE,
  GOFORGE_PORTABLE_VERSION,
} from "./contracts.ts";
import { GOFORGE_ABI_ERROR_CATALOG } from "./codec.ts";
import { createFileArtifactReader, sha256Hex, type WasmArtifactReader } from "./manifest.ts";

export interface TestBundle {
  locator: { manifestPath: string; manifestSha256: string };
  compatibility: { componentVersion: string; witPackage: string };
  files: Map<string, Uint8Array>;
  reads: string[];
  readArtifact: WasmArtifactReader;
  manifest: Record<string, unknown>;
}

export async function createTestBundle(
  update?: (manifest: Record<string, unknown>) => void,
): Promise<TestBundle> {
  const encoder = new TextEncoder();
  const files = new Map<string, Uint8Array>([
    ["artifacts/goforge.component.wasm", encoder.encode("component-source")],
    ["generated/goforge.js", encoder.encode("export const instantiate = true")],
    ["generated/goforge.core.wasm", encoder.encode("core-wasm")],
  ]);
  const source = files.get("artifacts/goforge.component.wasm")!;
  const glue = files.get("generated/goforge.js")!;
  const core = files.get("generated/goforge.core.wasm")!;
  const manifest: Record<string, unknown> = {
    schema: GOFORGE_BUNDLE_MANIFEST_SCHEMA_V1,
    abi: GOFORGE_ABI_V1,
    componentVersion: "1.2.3",
    witPackage: "pointerbyte:goforge@0.1.0",
    source: {
      path: "artifacts/goforge.component.wasm",
      sha256: await sha256Hex(source),
    },
    glue: {
      path: "generated/goforge.js",
      sha256: await sha256Hex(glue),
    },
    coreModules: {
      "goforge.core.wasm": {
        path: "generated/goforge.core.wasm",
        sha256: await sha256Hex(core),
      },
    },
    capabilities: [
      "portable.normalize",
      "portable.validate",
      "crypto.sha256",
      "crypto.hmac-sha256",
      "crypto.aes-gcm",
      "encoding.base64",
      "control.deadline",
      "control.cancellation",
    ],
    operations: {
      "text.normalize": {
        capability: "portable.normalize",
        retrySafe: true,
        securitySensitive: false,
        nativeAdapters: ["normalize-native"],
      },
      "text.validate": {
        capability: "portable.validate",
        retrySafe: false,
        securitySensitive: false,
      },
      "crypto.sha256": {
        capability: "crypto.sha256",
        retrySafe: true,
        securitySensitive: false,
      },
      "crypto.hmac-sha256": {
        capability: "crypto.hmac-sha256",
        retrySafe: false,
        securitySensitive: true,
        nativeAdapters: ["hash-native"],
      },
      "crypto.aes-gcm.encrypt": {
        capability: "crypto.aes-gcm",
        retrySafe: false,
        securitySensitive: true,
      },
      "crypto.aes-gcm.decrypt": {
        capability: "crypto.aes-gcm",
        retrySafe: true,
        securitySensitive: true,
      },
      "encoding.base64.encode": {
        capability: "encoding.base64",
        retrySafe: true,
        securitySensitive: false,
      },
      "encoding.base64.decode": {
        capability: "encoding.base64",
        retrySafe: true,
        securitySensitive: false,
      },
    },
  };
  update?.(manifest);
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  files.set("manifest.json", manifestBytes);
  const reads: string[] = [];
  return {
    locator: {
      manifestPath: "manifest.json",
      manifestSha256: await sha256Hex(manifestBytes),
    },
    compatibility: {
      componentVersion: "1.2.3",
      witPackage: "pointerbyte:goforge@0.1.0",
    },
    files,
    reads,
    readArtifact: (path) => {
      reads.push(path);
      const value = files.get(path);
      if (!value) return Promise.reject(new Error(`missing test artifact ${path}`));
      return Promise.resolve(Uint8Array.from(value));
    },
    manifest,
  };
}

/** Canonical GoForge `portable.DefaultDispatcher().ManifestJSON()` test equivalent. */
export function createPortableManifestJson(): string {
  return JSON.stringify({
    schema: GOFORGE_PORTABLE_MANIFEST_SCHEMA_V1,
    package: GOFORGE_PORTABLE_PACKAGE,
    version: GOFORGE_PORTABLE_VERSION,
    abi: GOFORGE_ABI_V1,
    encoding: {
      json: "RFC 8259; UTF-8; unique object fields; unknown fields rejected",
      binary: "RFC 4648 standard alphabet with required padding",
    },
    limits: {
      max_request_bytes: 1 << 20,
      max_response_bytes: 1 << 20,
      max_binary_bytes: 512 << 10,
      max_string_bytes: 64 << 10,
      max_id_bytes: 128,
      max_cancellation_token_bytes: 256,
      max_required_capabilities: 32,
      max_json_depth: 32,
    },
    operations: GOFORGE_ABI_V1_OPERATIONS.map((name) => ({
      name,
      capability: GOFORGE_ABI_V1_OPERATION_CAPABILITIES[name],
    })),
    capabilities: [
      { name: "portable.normalize", version: "1", host: false, operations: ["text.normalize"] },
      { name: "portable.validate", version: "1", host: false, operations: ["text.validate"] },
      { name: "crypto.sha256", version: "1", host: false, operations: ["crypto.sha256"] },
      {
        name: "crypto.hmac-sha256",
        version: "1",
        host: false,
        operations: ["crypto.hmac-sha256"],
      },
      {
        name: "crypto.aes-gcm",
        version: "1",
        host: false,
        operations: ["crypto.aes-gcm.encrypt", "crypto.aes-gcm.decrypt"],
      },
      {
        name: "encoding.base64",
        version: "1",
        host: false,
        operations: ["encoding.base64.encode", "encoding.base64.decode"],
      },
      { name: "control.deadline", version: "1", host: true },
      { name: "control.cancellation", version: "1", host: true },
    ],
    errors: Object.entries(GOFORGE_ABI_ERROR_CATALOG).map(([code, definition]) => ({
      code,
      message: definition.message,
      retryable: definition.retryable,
    })),
  });
}

/** A located production release bundle produced by `forge-go-private/component/scripts/build.sh`. */
export interface ProductionBundle {
  directory: URL;
  locator: { manifestPath: string; manifestSha256: string };
  compatibility: { componentVersion: string; witPackage: string };
  readArtifact: WasmArtifactReader;
}

/**
 * Locates the immutable production component bundle.
 *
 * The bundle is released separately from the JSR package, so its absence is expected in a
 * standalone checkout and the caller skips the integration suite. Inside the migration workspace the
 * sibling GoForge build output is used unless `GOFORGE_COMPONENT_BUNDLE` overrides it.
 */
export async function locateProductionBundle(): Promise<ProductionBundle | undefined> {
  const override = Deno.env.get("GOFORGE_COMPONENT_BUNDLE");
  const directory = override
    ? new URL(override.endsWith("/") ? override : `${override}/`, import.meta.url)
    : new URL("../../forge-go-private/component/artifacts/", import.meta.url);

  let manifestBytes: Uint8Array;
  try {
    manifestBytes = await Deno.readFile(new URL("manifest.json", directory));
  } catch {
    return undefined;
  }
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
    componentVersion: string;
    witPackage: string;
  };
  return {
    directory,
    locator: { manifestPath: "manifest.json", manifestSha256: await sha256Hex(manifestBytes) },
    compatibility: {
      componentVersion: manifest.componentVersion,
      witPackage: manifest.witPackage,
    },
    readArtifact: createFileArtifactReader(directory),
  };
}

export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (cause: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((accepted, rejected) => {
    resolve = accepted;
    reject = rejected;
  });
  return { promise, resolve, reject };
}
