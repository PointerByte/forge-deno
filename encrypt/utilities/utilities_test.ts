// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  bytesOf,
  decodeECCCipherPayload,
  encodeECCCipherPayload,
  fromBase64,
  isLocalAESKey,
  resolveECDHCurve,
  runWithSignal,
  textOf,
  toBase64,
} from "./utilities.ts";
import { CurveAsymmetricKey } from "../common/enums.ts";
import { EncryptError } from "../errors.ts";

Deno.test("base64 round-trips bytes and text", () => {
  const b = bytesOf("héllo");
  assertEquals(textOf(fromBase64(toBase64(b))), "héllo");
  assertEquals(textOf(b.buffer), "héllo");
});

Deno.test("isLocalAESKey validates key sizes", () => {
  assert(isLocalAESKey(toBase64(new Uint8Array(16))));
  assert(isLocalAESKey(toBase64(new Uint8Array(32))));
  assert(!isLocalAESKey(toBase64(new Uint8Array(20))));
  assert(!isLocalAESKey("not base64 @@@"));
});

Deno.test("resolveECDHCurve maps known curves and rejects unknown", () => {
  assertEquals(resolveECDHCurve(CurveAsymmetricKey.CurveP256), "P-256");
  assertEquals(resolveECDHCurve(CurveAsymmetricKey.CurveP521), "P-521");
  let threw = false;
  try {
    resolveECDHCurve(999 as CurveAsymmetricKey);
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("runWithSignal resolves without a signal", async () => {
  assertEquals(await runWithSignal(undefined, () => Promise.resolve(7)), 7);
});

Deno.test("runWithSignal normalizes synchronous and asynchronous failures", async () => {
  const synchronousCause = new Error("synchronous failure");
  const synchronous = await assertRejects(
    () =>
      runWithSignal(undefined, () => {
        throw synchronousCause;
      }),
    EncryptError,
    synchronousCause.message,
  );
  assertEquals(synchronous.cause, synchronousCause);

  const asynchronousCause = new DOMException("Web Crypto failure", "OperationError");
  const asynchronous = await assertRejects(
    () => runWithSignal(undefined, () => Promise.reject(asynchronousCause)),
    EncryptError,
    asynchronousCause.message,
  );
  assertEquals(asynchronous.cause, asynchronousCause);
});

Deno.test("runWithSignal rejects when already aborted", async () => {
  const c = new AbortController();
  c.abort();
  await assertRejects(() => runWithSignal(c.signal, () => Promise.resolve(1)));
});

Deno.test("runWithSignal rejects when aborted mid-flight", async () => {
  const c = new AbortController();
  const p = runWithSignal(c.signal, () => new Promise((r) => setTimeout(() => r(1), 1000)));
  c.abort();
  await assertRejects(() => p);
});

Deno.test("runWithSignal resolves a completed op with a live signal", async () => {
  const c = new AbortController();
  assertEquals(await runWithSignal(c.signal, () => Promise.resolve("ok")), "ok");
});

Deno.test("ECC cipher payload encodes and decodes", () => {
  const payload = { curve: "P-256", ephemeralPublicKey: "a", nonce: "b", cipherText: "c" };
  const encoded = encodeECCCipherPayload(payload);
  assertEquals(decodeECCCipherPayload(encoded), payload);
});

Deno.test("ECC cipher payload rejects malformed input", () => {
  let threw = false;
  try {
    decodeECCCipherPayload("%%%not-base64-json%%%");
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("ECC cipher payload rejects missing fields", () => {
  const bad = toBase64(bytesOf(JSON.stringify({ curve: "P-256" })));
  let threw = false;
  try {
    decodeECCCipherPayload(bad);
  } catch {
    threw = true;
  }
  assert(threw);
});
