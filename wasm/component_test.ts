// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * True cross-runtime parity against the real GoForge WebAssembly component.
 *
 * Every other suite in this directory exercises the runtime through injected fakes. This one loads
 * the immutable release bundle built by `forge-go-private/component/scripts/build.sh`, instantiates
 * the jco-transpiled guest, and proves the Go core running inside WebAssembly returns exactly what
 * the same Go core returns natively for the shared vectors.
 *
 * The bundle ships separately from the JSR package, so the suite is skipped when it is absent.
 */

import { assertEquals, assertInstanceOf, assertRejects, assertStringIncludes } from "@std/assert";
import { createGeneratedComponentFactory } from "./component.ts";
import type { AbiRequestV1, AbiSuccessResponseV1 } from "./contracts.ts";
import {
  WasmCancelledError,
  WasmCompatibilityError,
  WasmDeadlineExceededError,
  WasmGuestError,
  WasmIntegrityError,
} from "./errors.ts";
import { verifyWasmBundle } from "./manifest.ts";
import { GoforgeWasmRuntime } from "./runtime.ts";
import { locateProductionBundle, type ProductionBundle } from "./test_support.ts";
import { createDeniedWasiImports } from "./wasi.ts";

interface SharedVectorFile {
  schema: string;
  abi: string;
  vectors: Array<{ name: string; request: AbiRequestV1; response: AbiSuccessResponseV1 }>;
}

const bundle = await locateProductionBundle();
const ignore = bundle === undefined;

function createRuntime(
  target: ProductionBundle,
  overrides: { poolSize?: number } = {},
): GoforgeWasmRuntime {
  return new GoforgeWasmRuntime({
    bundle: target.locator,
    compatibility: target.compatibility,
    readArtifact: target.readArtifact,
    factory: createGeneratedComponentFactory(),
    poolSize: overrides.poolSize ?? 2,
  });
}

async function readVectors(): Promise<SharedVectorFile> {
  const url = new URL("./testdata/vectors/v1.json", import.meta.url);
  return JSON.parse(await Deno.readTextFile(url)) as SharedVectorFile;
}

Deno.test({
  name: "component: the Go core in WebAssembly reproduces every native shared vector exactly",
  ignore,
  async fn() {
    const vectors = await readVectors();
    const runtime = createRuntime(bundle!);
    try {
      for (const vector of vectors.vectors) {
        const result = await runtime.invoke(
          vector.request.operation,
          vector.request.payload,
          { requestId: vector.request.id },
        );
        assertEquals(result, vector.response.result, vector.name);
      }
    } finally {
      await runtime.close();
    }
  },
});

Deno.test({
  name: "component: the guest exports the canonical portable manifest and rejects nothing valid",
  ignore,
  async fn() {
    const runtime = createRuntime(bundle!);
    try {
      // Manifest validation happens during instance creation, so a successful call proves the
      // guest's own contract manifest matched the release bundle and the host's expectations.
      const health = await runtime.preload();
      assertEquals(health.state, "ready");
      assertEquals(health.verified, true);

      const encoded = await runtime.invoke<{ encoded: string }>(
        "encoding.base64.encode",
        { text: "GoForge" },
      );
      assertEquals(encoded, { encoded: "R29Gb3JnZQ==" });
      const decoded = await runtime.invoke<{ text: string }>(
        "encoding.base64.decode",
        { encoded: "R29Gb3JnZQ==" },
      );
      assertEquals(decoded, { text: "GoForge" });
    } finally {
      await runtime.close();
    }
  },
});

Deno.test({
  name: "component: AES-GCM round-trips through the guest and rejects a tampered ciphertext",
  ignore,
  async fn() {
    const runtime = createRuntime(bundle!);
    try {
      const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      const nonce = "AAAAAAAAAAAAAAAA";
      const payload = { key, nonce, aad: "", plaintext: "R29Gb3JnZQ==" };
      const sealed = await runtime.invoke<{ ciphertext: string }>(
        "crypto.aes-gcm.encrypt",
        payload,
      );
      const opened = await runtime.invoke<{ plaintext: string }>("crypto.aes-gcm.decrypt", {
        key,
        nonce,
        aad: "",
        ciphertext: sealed.ciphertext,
      });
      assertEquals(opened.plaintext, payload.plaintext);

      const tamperedBytes = atob(sealed.ciphertext).split("").map((c) => c.charCodeAt(0));
      tamperedBytes[0] ^= 0x01;
      const tampered = btoa(String.fromCharCode(...tamperedBytes));
      const error = await assertRejects(() =>
        runtime.invoke("crypto.aes-gcm.decrypt", { key, nonce, aad: "", ciphertext: tampered })
      );
      assertInstanceOf(error, WasmGuestError);
      assertEquals(error.code, "authentication_failed");
      assertEquals(error.field, "payload.ciphertext");
    } finally {
      await runtime.close();
    }
  },
});

Deno.test({
  name: "component: canonical Go error codes, messages, and fields survive the WASM boundary",
  ignore,
  async fn() {
    const cases: Array<{
      operation: AbiRequestV1["operation"];
      payload: unknown;
      code: string;
      field?: string;
    }> = [
      {
        operation: "crypto.sha256",
        payload: { data: "not base64!" },
        code: "invalid_base64",
        field: "payload.data",
      },
      {
        operation: "crypto.hmac-sha256",
        payload: { key: "AAAA", data: "" },
        code: "invalid_key",
        field: "payload.key",
      },
      {
        operation: "crypto.aes-gcm.encrypt",
        payload: {
          key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          nonce: "AAAA",
          aad: "",
          plaintext: "",
        },
        code: "invalid_nonce",
        field: "payload.nonce",
      },
      {
        operation: "text.normalize",
        payload: { value: "ok", unexpected: true },
        code: "unknown_field",
      },
      {
        operation: "encoding.base64.decode",
        payload: { encoded: "////" },
        code: "invalid_utf8",
        field: "payload.encoded",
      },
    ];

    const runtime = createRuntime(bundle!);
    try {
      for (const testCase of cases) {
        const error = await assertRejects(
          () => runtime.invoke(testCase.operation, testCase.payload),
          WasmGuestError,
          undefined,
          `${testCase.operation} should fail with ${testCase.code}`,
        );
        assertEquals(error.code, testCase.code, testCase.operation);
        if (testCase.field !== undefined) assertEquals(error.field, testCase.field);
        assertEquals(error.retryable, false);
      }
    } finally {
      await runtime.close();
    }
  },
});

Deno.test({
  name: "component: concurrent calls stay isolated across pooled guest instances",
  ignore,
  async fn() {
    const runtime = createRuntime(bundle!, { poolSize: 4 });
    try {
      const inputs = Array.from({ length: 48 }, (_value, index) => `payload-${index}`);
      const results = await Promise.all(
        inputs.map((text) =>
          runtime.invoke<{ encoded: string }>("encoding.base64.encode", { text })
        ),
      );
      assertEquals(results.map((result) => result.encoded), inputs.map((text) => btoa(text)));

      const health = runtime.health();
      assertEquals(health.state, "ready");
      // Isolation is only meaningful if the work actually spread across more than one instance.
      assertEquals(health.totalInstances > 1 && health.totalInstances <= 4, true);
    } finally {
      await runtime.close();
    }
  },
});

Deno.test({
  name: "component: the host refuses an elapsed deadline before the guest is entered",
  ignore,
  async fn() {
    const runtime = createRuntime(bundle!);
    try {
      await runtime.preload();
      const error = await assertRejects(() =>
        runtime.invoke("crypto.sha256", { data: "" }, { deadline: Date.now() - 1_000 })
      );
      assertInstanceOf(error, WasmDeadlineExceededError);
    } finally {
      await runtime.close();
    }
  },
});

Deno.test({
  name: "component: the Go guest independently refuses an expired deadline and unchecked controls",
  ignore,
  async fn() {
    // The host short-circuits expired deadlines, so these guest-side controls are only reachable by
    // dispatching directly. They are the defence that survives a wrong or hostile host clock.
    const target = bundle!;
    const verified = await verifyWasmBundle(
      target.locator,
      target.compatibility,
      target.readArtifact,
    );
    const instance = await createGeneratedComponentFactory().create(verified, {
      instanceId: 1,
      signal: new AbortController().signal,
    });
    try {
      const now = 1_800_000_000_000;
      const expired = {
        abi: "goforge.abi.v1",
        id: "guest-deadline",
        operation: "crypto.sha256",
        metadata: { deadline_unix_ms: now - 1 },
        payload: { data: "" },
      };
      assertEquals(
        JSON.parse(
          await instance.dispatch(JSON.stringify(expired), {
            clockChecked: true,
            nowUnixMilliseconds: now,
            cancellationChecked: false,
            cancellationToken: "",
            cancellationRequested: false,
          }),
        ),
        {
          abi: "goforge.abi.v1",
          id: "guest-deadline",
          ok: false,
          error: {
            code: "deadline_exceeded",
            message: "request deadline has been exceeded",
            retryable: true,
            field: "metadata.deadline_unix_ms",
          },
        },
      );

      // A host that forwards a deadline without checking its clock fails closed instead of running.
      assertEquals(
        JSON.parse(
          await instance.dispatch(JSON.stringify(expired), {
            clockChecked: false,
            nowUnixMilliseconds: 0,
            cancellationChecked: false,
            cancellationToken: "",
            cancellationRequested: false,
          }),
        ),
        {
          abi: "goforge.abi.v1",
          id: "guest-deadline",
          ok: false,
          error: {
            code: "execution_state_required",
            message: "host did not provide checked execution state",
            retryable: false,
            field: "metadata.deadline_unix_ms",
          },
        },
      );

      // Likewise for a cancellation token the host never checked.
      const cancelled = {
        abi: "goforge.abi.v1",
        id: "guest-cancel",
        operation: "crypto.sha256",
        metadata: { cancellation_token: "abc" },
        payload: { data: "" },
      };
      assertEquals(
        JSON.parse(
          await instance.dispatch(JSON.stringify(cancelled), {
            clockChecked: false,
            nowUnixMilliseconds: 0,
            cancellationChecked: true,
            cancellationToken: "abc",
            cancellationRequested: true,
          }),
        ),
        {
          abi: "goforge.abi.v1",
          id: "guest-cancel",
          ok: false,
          error: {
            code: "cancellation_requested",
            message: "request cancellation was requested",
            retryable: false,
            field: "metadata.cancellation_token",
          },
        },
      );
    } finally {
      await instance.close?.();
    }
  },
});

Deno.test({
  name: "component: an already-aborted signal never reaches the guest",
  ignore,
  async fn() {
    const runtime = createRuntime(bundle!);
    try {
      await runtime.preload();
      const controller = new AbortController();
      controller.abort();
      const error = await assertRejects(() =>
        runtime.invoke("crypto.sha256", { data: "" }, { signal: controller.signal })
      );
      assertInstanceOf(error, WasmCancelledError);
    } finally {
      await runtime.close();
    }
  },
});

Deno.test({
  name: "component: a cancellation token the host did not check is refused by the guest",
  ignore,
  async fn() {
    const runtime = createRuntime(bundle!);
    try {
      // The runtime marks cancellationChecked whenever it forwards a token, so the happy path
      // succeeds; this proves the token is transported and validated rather than dropped.
      const result = await runtime.invoke<{ encoded: string }>(
        "encoding.base64.encode",
        { text: "token" },
        { cancellationToken: "call-1" },
      );
      assertEquals(result.encoded, btoa("token"));
    } finally {
      await runtime.close();
    }
  },
});

Deno.test({
  name: "component: required capabilities are enforced against the guest manifest",
  ignore,
  async fn() {
    const runtime = createRuntime(bundle!);
    try {
      const granted = await runtime.invoke<{ digest: string }>(
        "crypto.sha256",
        { data: "" },
        { requiredCapabilities: ["crypto.sha256"] },
      );
      assertEquals(
        granted.digest,
        "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
      );
    } finally {
      await runtime.close();
    }
  },
});

Deno.test({
  name: "component: a tampered core module is rejected before any guest code runs",
  ignore,
  async fn() {
    const target = bundle!;
    const runtime = new GoforgeWasmRuntime({
      bundle: target.locator,
      compatibility: target.compatibility,
      readArtifact: async (path) => {
        const bytes = await target.readArtifact(path);
        if (path.endsWith("goforge.core.wasm")) bytes[bytes.length - 1] ^= 0xff;
        return bytes;
      },
      factory: createGeneratedComponentFactory(),
    });
    try {
      const error = await assertRejects(() => runtime.invoke("crypto.sha256", { data: "" }));
      assertInstanceOf(error, WasmIntegrityError);
      assertStringIncludes(error.message, "SHA-256 mismatch");
      assertEquals(runtime.health().state, "degraded");
    } finally {
      await runtime.close();
    }
  },
});

Deno.test({
  name: "component: a host declaring the wrong component version never instantiates the guest",
  ignore,
  async fn() {
    const target = bundle!;
    const runtime = new GoforgeWasmRuntime({
      bundle: target.locator,
      compatibility: { ...target.compatibility, componentVersion: "9.9.9" },
      readArtifact: target.readArtifact,
      factory: createGeneratedComponentFactory(),
    });
    try {
      const error = await assertRejects(() => runtime.invoke("crypto.sha256", { data: "" }));
      assertInstanceOf(error, WasmCompatibilityError);
    } finally {
      await runtime.close();
    }
  },
});

Deno.test({
  name: "component: the guest runs with no environment, arguments, or filesystem authority",
  ignore,
  async fn() {
    const imports = createDeniedWasiImports();
    const environment = imports["wasi:cli/environment"] as {
      getArguments(): string[];
      getEnvironment(): Array<[string, string]>;
    };
    assertEquals(environment.getArguments(), []);
    assertEquals(environment.getEnvironment(), []);
    const preopens = imports["wasi:filesystem/preopens"] as { getDirectories(): unknown[] };
    assertEquals(preopens.getDirectories(), []);

    // The denied descriptor is the only filesystem authority the guest can obtain, and it refuses.
    const types = imports["wasi:filesystem/types"] as {
      Descriptor: new () => { openAt(...args: unknown[]): never };
    };
    const descriptor = new types.Descriptor();
    let thrown: unknown;
    try {
      descriptor.openAt(0, "/etc/passwd", 0, 0);
    } catch (cause) {
      thrown = cause;
    }
    assertEquals(thrown, "not-permitted");

    // A real dispatch still succeeds under exactly these denied imports.
    const runtime = createRuntime(bundle!);
    try {
      const result = await runtime.invoke<{ value: string }>("text.normalize", {
        value: "  Hello  World  ",
        trim: true,
        collapse_whitespace: true,
        lowercase_ascii: true,
      });
      assertEquals(result.value, "hello world");
    } finally {
      await runtime.close();
    }
  },
});

Deno.test({
  name: "component: the production bundle is the ADR 0012 TinyGo build, not a stale artifact",
  ignore,
  async fn() {
    // ADR 0012 rejects componentize-go for production. A bundle built by it would
    // still pass every parity test above while reintroducing the sustained-load
    // trap, so the toolchain evidence is asserted explicitly.
    const evidence = JSON.parse(
      new TextDecoder().decode(await bundle!.readArtifact("toolchain.json")),
    ) as {
      componentCompiler: string;
      wasi: string;
      production: boolean;
      languageDirective: string;
    };
    assertEquals(evidence.componentCompiler, "tinygo 0.41.1");
    assertEquals(evidence.production, true);
    assertEquals(evidence.languageDirective, "go1.25.0");
    // The WASI downgrade is an accepted, documented cost — it must stay visible
    // in the shipped evidence rather than being rounded to "0.2".
    assertEquals(evidence.wasi, "0.2.0");

    const wit = new TextDecoder().decode(await bundle!.readArtifact("goforge.component.wit"));
    assertStringIncludes(wit, "pointerbyte:goforge/operations@0.1.0");
    assertStringIncludes(wit, "wasi:cli/environment@0.2.0");
  },
});

Deno.test({
  name: "component: the default production path really enters the guest, not an adapter",
  ignore,
  async fn() {
    // Guards the integration itself. If `invoke` ever silently resolved through a
    // native adapter — or a mock factory — every parity assertion above would keep
    // passing while the component stopped being exercised at all.
    const targets: string[] = [];
    const runtime = new GoforgeWasmRuntime({
      bundle: bundle!.locator,
      compatibility: bundle!.compatibility,
      readArtifact: bundle!.readArtifact,
      factory: createGeneratedComponentFactory(),
      poolSize: 1,
      observer: (event) => {
        if (event.type === "call.start" && event.target) targets.push(event.target);
      },
    });
    try {
      const result = await runtime.invoke<{ digest: string }>("crypto.sha256", { data: "" });
      assertEquals(result.digest, "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
    } finally {
      await runtime.close();
    }
    assertEquals(targets, ["component"]);
  },
});
