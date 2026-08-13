// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-runtime performance evidence for the GoForge component path.
 *
 * Each portable operation is measured twice — once through the verified WebAssembly component and
 * once through the closest native Deno implementation — so the cost of the WASM boundary is
 * explicit rather than assumed. Pair these figures with `forge-go-private/portable`'s `go test
 * -bench` output to compare Go native, Go in WebAssembly, and native Deno.
 *
 * The release bundle ships separately from the JSR package, so every component benchmark is skipped
 * when the bundle is absent. Set `GOFORGE_COMPONENT_BUNDLE` to measure a bundle elsewhere.
 *
 * @module
 */

import { encodeBase64 } from "@std/encoding/base64";
import { createGeneratedComponentFactory } from "../wasm/component.ts";
import { GoforgeWasmRuntime } from "../wasm/runtime.ts";
import { locateProductionBundle } from "../wasm/test_support.ts";
import { createDeniedWasiImports } from "../wasm/wasi.ts";

const bundle = await locateProductionBundle();
const ignore = bundle === undefined;

// The component intermittently traps during Go garbage collection under sustained load — the
// blocker reproduced by research/component-gc-soak/soak.ts. A benchmark issues far more dispatches
// than any test, so collection is deferred here purely to keep these measurements runnable.
//
// This is a measurement workaround, NOT a supported configuration: GOGC=off trades the trap for
// unbounded guest memory growth. The latency figures below are therefore best-case steady-state
// costs that exclude collection, and must be read alongside that blocker.
const wasiImports = createDeniedWasiImports();
wasiImports["wasi:cli/environment"] = {
  getArguments: (): string[] => [],
  getEnvironment: (): Array<[string, string]> => [["GOGC", "off"]],
  initialCwd: (): undefined => undefined,
};

const runtime = bundle
  ? new GoforgeWasmRuntime({
    bundle: bundle.locator,
    compatibility: bundle.compatibility,
    readArtifact: bundle.readArtifact,
    factory: createGeneratedComponentFactory({ wasiImports }),
    poolSize: 4,
  })
  : undefined;
if (runtime) await runtime.preload();

const kilobyte = new Uint8Array(1024).map((_value, index) => index & 0xff);
const kilobyteBase64 = encodeBase64(kilobyte);
const hmacKey = new Uint8Array(32).fill(7);
const hmacKeyBase64 = encodeBase64(hmacKey);
const nativeHmacKey = await crypto.subtle.importKey(
  "raw",
  hmacKey,
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
const aesKeyBase64 = encodeBase64(new Uint8Array(32).fill(3));
const nonceBase64 = encodeBase64(new Uint8Array(12).fill(9));
const nativeAesKey = await crypto.subtle.importKey(
  "raw",
  new Uint8Array(32).fill(3),
  { name: "AES-GCM" },
  false,
  ["encrypt"],
);

Deno.bench({
  name: "wasm/component: crypto.sha256 1 KiB",
  group: "sha256",
  baseline: true,
  ignore,
  async fn() {
    await runtime!.invoke("crypto.sha256", { data: kilobyteBase64 });
  },
});

Deno.bench({
  name: "wasm/native: WebCrypto SHA-256 1 KiB",
  group: "sha256",
  async fn() {
    await crypto.subtle.digest("SHA-256", kilobyte);
  },
});

Deno.bench({
  name: "wasm/component: crypto.hmac-sha256 1 KiB",
  group: "hmac",
  baseline: true,
  ignore,
  async fn() {
    await runtime!.invoke("crypto.hmac-sha256", { key: hmacKeyBase64, data: kilobyteBase64 });
  },
});

Deno.bench({
  name: "wasm/native: WebCrypto HMAC-SHA-256 1 KiB",
  group: "hmac",
  async fn() {
    await crypto.subtle.sign("HMAC", nativeHmacKey, kilobyte);
  },
});

Deno.bench({
  name: "wasm/component: crypto.aes-gcm.encrypt 1 KiB",
  group: "aes-gcm",
  baseline: true,
  ignore,
  async fn() {
    await runtime!.invoke("crypto.aes-gcm.encrypt", {
      key: aesKeyBase64,
      nonce: nonceBase64,
      aad: "",
      plaintext: kilobyteBase64,
    });
  },
});

Deno.bench({
  name: "wasm/native: WebCrypto AES-GCM encrypt 1 KiB",
  group: "aes-gcm",
  async fn() {
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: new Uint8Array(12).fill(9) },
      nativeAesKey,
      kilobyte,
    );
  },
});

Deno.bench({
  name: "wasm/component: text.normalize",
  group: "normalize",
  baseline: true,
  ignore,
  async fn() {
    await runtime!.invoke("text.normalize", {
      value: "  Mixed   CASE\tinput\n",
      trim: true,
      collapse_whitespace: true,
      lowercase_ascii: true,
    });
  },
});

Deno.bench({
  name: "wasm/native: equivalent JavaScript normalization",
  group: "normalize",
  fn() {
    "  Mixed   CASE\tinput\n".trim().replace(/\s+/g, " ").toLowerCase();
  },
});

Deno.bench({
  name: "wasm/component: encoding.base64.encode",
  group: "base64",
  baseline: true,
  ignore,
  async fn() {
    await runtime!.invoke("encoding.base64.encode", { text: "GoForge" });
  },
});

Deno.bench({
  name: "wasm/native: @std/encoding base64",
  group: "base64",
  fn() {
    encodeBase64(new TextEncoder().encode("GoForge"));
  },
});

Deno.bench({
  name: "wasm/component: 32 concurrent dispatches across a 4-instance pool",
  group: "throughput",
  ignore,
  async fn() {
    await Promise.all(
      Array.from({ length: 32 }, () => runtime!.invoke("crypto.sha256", { data: kilobyteBase64 })),
    );
  },
});

globalThis.addEventListener("unload", () => {
  void runtime?.close();
});
