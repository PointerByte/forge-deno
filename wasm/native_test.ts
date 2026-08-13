// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves the native adapter is a faithful stand-in for the portable core, not an approximation.
 *
 * Two independent standards are applied. The shared vectors pin the results GoForge published. The
 * differential suite goes further and compares the native adapter against the **real component**
 * over inputs no vector covers — the boundaries and failure paths where two implementations of the
 * same contract are most likely to diverge.
 */

import { assertEquals, assertInstanceOf, assertRejects, assertStringIncludes } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { isParityQualified, NativeAdapterRegistry, recordParityQualification } from "./adapters.ts";
import { createGeneratedComponentFactory } from "./component.ts";
import type { AbiResponseV1, AbiValue, GoforgeAbiOperationV1 } from "./contracts.ts";
import { createAbiSuccessResponse } from "./codec.ts";
import { WasmAdapterError } from "./errors.ts";
import {
  createNativeGoforgeAdapter,
  GOFORGE_NATIVE_ADAPTER_NAME,
  GOFORGE_NATIVE_LIMITS,
  type GoforgeSharedVector,
  qualifyNativeAdapter,
} from "./native.ts";
import { verifyWasmBundle } from "./manifest.ts";
import { locateProductionBundle } from "./test_support.ts";

const context = { signal: new AbortController().signal, attempt: 1 };

async function readVectors(): Promise<GoforgeSharedVector[]> {
  const url = new URL("./testdata/vectors/v1.json", import.meta.url);
  const { vectors } = JSON.parse(await Deno.readTextFile(url)) as {
    vectors: GoforgeSharedVector[];
  };
  return vectors;
}

/** Invokes the unqualified adapter directly; qualification is irrelevant to behaviour. */
function invoke(operation: GoforgeAbiOperationV1, payload: AbiValue): Promise<AbiResponseV1> {
  return createNativeGoforgeAdapter().invoke(
    { abi: "goforge.abi.v1", id: "test", operation, payload },
    context,
  );
}

async function failure(operation: GoforgeAbiOperationV1, payload: AbiValue) {
  const response = await invoke(operation, payload);
  if (response.ok) {
    throw new Error(`expected ${operation} to fail, got ${JSON.stringify(response)}`);
  }
  return response.error;
}

async function success(operation: GoforgeAbiOperationV1, payload: AbiValue) {
  const response = await invoke(operation, payload);
  if (!response.ok) throw new Error(`expected ${operation} to succeed: ${response.error.code}`);
  return response.result as Record<string, AbiValue>;
}

Deno.test("the native adapter reproduces every GoForge shared vector exactly", async () => {
  const qualified = await qualifyNativeAdapter(createNativeGoforgeAdapter(), await readVectors());
  assertEquals(qualified.parityQualified, true);
  assertEquals(qualified.name, GOFORGE_NATIVE_ADAPTER_NAME);
});

Deno.test("qualification is a real gate, not a formality", async (t) => {
  const vectors = await readVectors();

  await t.step("a wrong implementation cannot qualify", async () => {
    const broken = {
      ...createNativeGoforgeAdapter(),
      invoke: () =>
        Promise.resolve<AbiResponseV1>({
          abi: "goforge.abi.v1",
          id: "parity",
          ok: true,
          result: { digest: "wrong" },
        }),
    };
    const error = await assertRejects(
      () => qualifyNativeAdapter(broken, vectors),
      WasmAdapterError,
    );
    assertStringIncludes(error.message, "failed parity qualification");
  });

  await t.step("an adapter claiming operations no vector covers cannot qualify", async () => {
    const error = await assertRejects(
      () => qualifyNativeAdapter(createNativeGoforgeAdapter(), vectors.slice(0, 1)),
      WasmAdapterError,
    );
    assertStringIncludes(error.message, "no qualifying vector");
  });

  await t.step("qualification requires at least one vector", async () => {
    await assertRejects(
      () => qualifyNativeAdapter(createNativeGoforgeAdapter(), []),
      WasmAdapterError,
    );
  });
});

Deno.test("the registry refuses to route to an unqualified adapter", async () => {
  const registry = new NativeAdapterRegistry();
  registry.register(createNativeGoforgeAdapter());
  const error = assertRejects(
    () =>
      Promise.resolve().then(() =>
        registry.resolve(GOFORGE_NATIVE_ADAPTER_NAME, "crypto.sha256", [
          GOFORGE_NATIVE_ADAPTER_NAME,
        ])
      ),
    WasmAdapterError,
  );
  assertStringIncludes((await error).message, "has not passed shared parity qualification");

  const qualified = new NativeAdapterRegistry();
  qualified.register(await qualifyNativeAdapter(createNativeGoforgeAdapter(), await readVectors()));
  assertEquals(
    qualified.resolve("native.deno.portable", "crypto.sha256", ["native.deno.portable"]).name,
    GOFORGE_NATIVE_ADAPTER_NAME,
  );
  await qualified.close();
});

Deno.test("a manifest that does not name the adapter blocks it even when qualified", async () => {
  const registry = new NativeAdapterRegistry();
  registry.register(await qualifyNativeAdapter(createNativeGoforgeAdapter(), await readVectors()));
  assertInstanceOf(
    ((): unknown => {
      try {
        registry.resolve(GOFORGE_NATIVE_ADAPTER_NAME, "crypto.sha256", []);
      } catch (cause) {
        return cause;
      }
    })(),
    WasmAdapterError,
  );
  await registry.close();
});

Deno.test("payload validation matches the portable core's strict object rules", async (t) => {
  await t.step("unknown fields are rejected", async () => {
    assertEquals((await failure("crypto.sha256", { data: "", extra: 1 })).code, "unknown_field");
  });

  await t.step("missing and null required fields are rejected with the field name", async () => {
    assertEquals((await failure("crypto.sha256", {})).field, "payload.data");
    assertEquals((await failure("crypto.sha256", {})).code, "invalid_request");
    assertEquals((await failure("crypto.sha256", { data: null })).code, "invalid_request");
  });

  await t.step("a non-object payload is rejected", async () => {
    assertEquals((await failure("crypto.sha256", [] as unknown as AbiValue)).field, "payload");
    assertEquals((await failure("crypto.sha256", "x" as unknown as AbiValue)).code, "invalid_json");
  });

  await t.step("wrong field types are decode failures", async () => {
    assertEquals((await failure("crypto.sha256", { data: 5 })).code, "invalid_json");
    assertEquals(
      (await failure("text.normalize", { value: "a", trim: "yes" })).code,
      "invalid_json",
    );
  });
});

Deno.test("binary decoding enforces canonical padded Base64", async (t) => {
  await t.step("non-canonical trailing bits are rejected", async () => {
    // "QQ==" is canonical for 0x41; "QR==" decodes to the same byte but is not canonical.
    assertEquals((await success("crypto.sha256", { data: "QQ==" })).digest !== undefined, true);
    assertEquals((await failure("crypto.sha256", { data: "QR==" })).code, "invalid_base64");
  });

  await t.step("unpadded and URL-safe alphabets are rejected", async () => {
    assertEquals((await failure("crypto.sha256", { data: "QQ" })).code, "invalid_base64");
    assertEquals((await failure("crypto.sha256", { data: "-_==" })).code, "invalid_base64");
  });

  await t.step("oversized input is rejected before decoding", async () => {
    const oversized = "A".repeat(4 * (Math.ceil(GOFORGE_NATIVE_LIMITS.maxBinaryBytes / 3) + 8));
    const error = await failure("crypto.sha256", { data: oversized });
    assertEquals(error.code, "input_too_large");
    assertEquals(error.field, "payload.data");
  });
});

Deno.test("cryptographic key and nonce rules fail closed", async (t) => {
  const key128 = encodeBase64(new Uint8Array(16));
  const nonce = encodeBase64(new Uint8Array(12));

  await t.step("HMAC rejects keys under 16 bytes", async () => {
    const error = await failure("crypto.hmac-sha256", {
      key: encodeBase64(new Uint8Array(15)),
      data: "",
    });
    assertEquals(error.code, "invalid_key");
    assertEquals(error.field, "payload.key");
  });

  await t.step("AES rejects key sizes outside 16/24/32", async () => {
    const error = await failure("crypto.aes-gcm.encrypt", {
      key: encodeBase64(new Uint8Array(20)),
      nonce,
      aad: "",
      plaintext: "",
    });
    assertEquals(error.code, "invalid_key");
  });

  await t.step("AES rejects nonces that are not 12 bytes", async () => {
    const error = await failure("crypto.aes-gcm.encrypt", {
      key: key128,
      nonce: encodeBase64(new Uint8Array(11)),
      aad: "",
      plaintext: "",
    });
    assertEquals(error.code, "invalid_nonce");
    assertEquals(error.field, "payload.nonce");
  });

  await t.step("a tampered ciphertext fails authentication with no detail", async () => {
    const { ciphertext } = await success("crypto.aes-gcm.encrypt", {
      key: key128,
      nonce,
      aad: "",
      plaintext: encodeBase64(new TextEncoder().encode("secret")),
    });
    const bytes = new Uint8Array(atob(ciphertext as string).split("").map((c) => c.charCodeAt(0)));
    bytes[0] ^= 0xff;
    const error = await failure("crypto.aes-gcm.decrypt", {
      key: key128,
      nonce,
      aad: "",
      ciphertext: encodeBase64(bytes),
    });
    assertEquals(error.code, "authentication_failed");
    assertEquals(error.message, "AES-GCM authentication failed");
    assertEquals("field" in error, true);
  });

  await t.step("a ciphertext shorter than the tag fails authentication", async () => {
    const error = await failure("crypto.aes-gcm.decrypt", {
      key: key128,
      nonce,
      aad: "",
      ciphertext: encodeBase64(new Uint8Array(15)),
    });
    assertEquals(error.code, "authentication_failed");
  });

  await t.step("changed associated data breaks authentication", async () => {
    const { ciphertext } = await success("crypto.aes-gcm.encrypt", {
      key: key128,
      nonce,
      aad: encodeBase64(new TextEncoder().encode("context-a")),
      plaintext: encodeBase64(new TextEncoder().encode("secret")),
    });
    const error = await failure("crypto.aes-gcm.decrypt", {
      key: key128,
      nonce,
      aad: encodeBase64(new TextEncoder().encode("context-b")),
      ciphertext,
    });
    assertEquals(error.code, "authentication_failed");
  });
});

Deno.test("Unicode handling follows Go's rules, not JavaScript's", async (t) => {
  await t.step("U+0085 is whitespace to Go and is trimmed", async () => {
    // String.prototype.trim() would leave this character in place.
    assertEquals((await success("text.normalize", { value: "a", trim: true })).value, "a");
  });

  await t.step("U+FEFF is not whitespace to Go and is preserved", async () => {
    // String.prototype.trim() would strip this character.
    assertEquals(
      (await success("text.normalize", { value: "﻿a", trim: true })).value,
      "﻿a",
    );
  });

  await t.step("only ASCII letters are lowercased", async () => {
    assertEquals(
      (await success("text.normalize", { value: "ÉA", lowercase_ascii: true })).value,
      "Éa",
    );
  });

  await t.step("collapsing rewrites any run of Unicode space to one ASCII space", async () => {
    assertEquals(
      (await success("text.normalize", { value: "a    b", collapse_whitespace: true }))
        .value,
      "a b",
    );
  });

  await t.step("lone surrogates are rejected as invalid UTF-8", async () => {
    const error = await failure("text.normalize", { value: "a\uD800b" });
    assertEquals(error.code, "invalid_utf8");
    assertEquals(error.field, "payload.value");
  });

  await t.step("length rules count UTF-8 bytes and code points separately", async () => {
    // "é" is 2 bytes, 1 rune.
    const result = await success("text.validate", {
      value: "éé",
      rules: { min_bytes: 5, min_runes: 3 },
    });
    assertEquals(result.violations, [{ code: "min_bytes" }, { code: "min_runes" }]);
  });
});

Deno.test("deadline and cancellation fail closed before any work runs", async (t) => {
  const adapter = createNativeGoforgeAdapter();
  const request = {
    abi: "goforge.abi.v1" as const,
    id: "controls",
    operation: "crypto.sha256" as const,
    payload: { data: "" },
  };

  await t.step("an aborted signal short-circuits", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = await adapter.invoke(request, { signal: controller.signal, attempt: 1 });
    assertEquals(response.ok, false);
    if (!response.ok) assertEquals(response.error.code, "cancellation_requested");
  });

  await t.step("an elapsed deadline short-circuits", async () => {
    const response = await adapter.invoke(request, {
      signal: new AbortController().signal,
      attempt: 1,
      deadlineUnixMs: Date.now() - 1,
    });
    assertEquals(response.ok, false);
    if (!response.ok) assertEquals(response.error.code, "deadline_exceeded");
  });
});

// -------------------------------------------------------------------------------------------
// Differential suite: the native adapter against the real component, beyond the shared vectors.
// -------------------------------------------------------------------------------------------

const bundle = await locateProductionBundle();

Deno.test({
  name: "the native adapter and the real component agree on cases no vector covers",
  ignore: bundle === undefined,
  async fn() {
    const verified = await verifyWasmBundle(
      bundle!.locator,
      bundle!.compatibility,
      bundle!.readArtifact,
    );
    const component = await createGeneratedComponentFactory().create(verified, {
      instanceId: 1,
      signal: new AbortController().signal,
    });
    const native = createNativeGoforgeAdapter();
    const state = {
      clockChecked: false,
      nowUnixMilliseconds: 0,
      cancellationChecked: false,
      cancellationToken: "",
      cancellationRequested: false,
    };

    const key = encodeBase64(new Uint8Array(32).fill(7));
    const nonce = encodeBase64(new Uint8Array(12).fill(3));
    const cases: Array<[GoforgeAbiOperationV1, AbiValue]> = [
      // Empty and boundary inputs.
      ["crypto.sha256", { data: "" }],
      ["crypto.hmac-sha256", { key: encodeBase64(new Uint8Array(16)), data: "" }],
      ["encoding.base64.encode", { text: "" }],
      ["encoding.base64.decode", { encoded: "" }],
      // Unicode boundaries where Go and JavaScript disagree by default.
      ["text.normalize", { value: "  x﻿ ", trim: true }],
      ["text.normalize", { value: "  A\tB\nC  ", trim: true, collapse_whitespace: true }],
      ["text.normalize", { value: "ÀÉÎÕÜ", lowercase_ascii: true }],
      ["text.normalize", { value: "🙂 🙃", collapse_whitespace: true }],
      // Validation rule interactions and ordering.
      ["text.validate", { value: "", rules: { required: true } }],
      ["text.validate", { value: "🙂", rules: { min_bytes: 5, max_runes: 0, ascii: true } }],
      ["text.validate", { value: "ab", rules: { forbid_control: true } }],
      ["text.validate", { value: "ab", rules: { forbid_whitespace: true } }],
      ["text.validate", { value: "xy", rules: { prefix: "x", suffix: "z" } }],
      ["text.validate", { value: "abc", rules: {} }],
      // Failure paths.
      ["crypto.sha256", { data: "QR==" }],
      ["crypto.sha256", { data: "!!!!" }],
      ["crypto.sha256", { data: "AAAA", extra: true }],
      ["crypto.sha256", {}],
      ["crypto.hmac-sha256", { key: encodeBase64(new Uint8Array(15)), data: "" }],
      ["crypto.aes-gcm.encrypt", {
        key: encodeBase64(new Uint8Array(20)),
        nonce,
        aad: "",
        plaintext: "",
      }],
      ["crypto.aes-gcm.encrypt", {
        key,
        nonce: encodeBase64(new Uint8Array(13)),
        aad: "",
        plaintext: "",
      }],
      ["crypto.aes-gcm.decrypt", {
        key,
        nonce,
        aad: "",
        ciphertext: encodeBase64(new Uint8Array(8)),
      }],
      ["encoding.base64.decode", { encoded: encodeBase64(new Uint8Array([0xff, 0xfe])) }],
      ["text.validate", { value: "a", rules: { min_bytes: -1 } }],
      ["text.validate", { value: "a", rules: { min_bytes: 5, max_bytes: 2 } }],
      // Round trips through both implementations.
      ["crypto.aes-gcm.encrypt", {
        key,
        nonce,
        aad: encodeBase64(new TextEncoder().encode("aad")),
        plaintext: encodeBase64(new TextEncoder().encode("hello")),
      }],
    ];

    try {
      for (const [operation, payload] of cases) {
        const label = `${operation} ${JSON.stringify(payload)}`;
        const guest = JSON.parse(
          await component.dispatch(
            JSON.stringify({ abi: "goforge.abi.v1", id: "diff", operation, payload }),
            state,
          ),
        );
        const host = await native.invoke(
          { abi: "goforge.abi.v1", id: "diff", operation, payload },
          context,
        );
        assertEquals(sorted(host), sorted(guest), label);
      }
    } finally {
      await component.close?.();
    }
  },
});

/** Sorts keys so field order never masks or invents a difference. */
function sorted(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    return Object.fromEntries(
      Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  });
}

Deno.test("a claimed qualification that never happened is rejected at registration", async (t) => {
  const vectors = await readVectors();

  await t.step("an object literal cannot simply declare itself qualified", () => {
    const registry = new NativeAdapterRegistry();
    const error = ((): unknown => {
      try {
        registry.register({
          name: "forged.adapter",
          operations: ["crypto.sha256"],
          parityQualified: true,
          invoke: () =>
            Promise.resolve(createAbiSuccessResponse("x", { digest: "whatever-i-want" })),
        });
      } catch (cause) {
        return cause;
      }
    })();
    assertInstanceOf(error, WasmAdapterError);
    assertStringIncludes((error as WasmAdapterError).message, "never performed");
  });

  await t.step(
    "spreading a genuinely qualified adapter does not carry the qualification",
    async () => {
      const genuine = await qualifyNativeAdapter(createNativeGoforgeAdapter(), vectors);
      assertEquals(isParityQualified(genuine), true);

      // The copy declares the flag but is a different object, so the ledger does not know it.
      const copy = { ...genuine, name: "copied.adapter" };
      assertEquals(copy.parityQualified, true);
      assertEquals(isParityQualified(copy), false);

      const registry = new NativeAdapterRegistry();
      const error = ((): unknown => {
        try {
          registry.register(copy);
        } catch (cause) {
          return cause;
        }
      })();
      assertInstanceOf(error, WasmAdapterError);
    },
  );

  await t.step("the unqualified adapter cannot be mutated into a qualified one", () => {
    const adapter = createNativeGoforgeAdapter();
    // Frozen: the assignment is a no-op in sloppy mode and throws in strict mode.
    try {
      (adapter as { parityQualified: boolean }).parityQualified = true;
    } catch { /* strict-mode TypeError is the desired outcome */ }
    assertEquals(adapter.parityQualified, false);
    assertEquals(isParityQualified(adapter), false);
  });

  await t.step("recording requires the adapter to actually declare the flag", () => {
    const error = ((): unknown => {
      try {
        recordParityQualification(createNativeGoforgeAdapter());
      } catch (cause) {
        return cause;
      }
    })();
    assertInstanceOf(error, WasmAdapterError);
  });
});
