// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertRejects } from "@std/assert";
import { newLocalProvider } from "./repository.ts";
import { CurveAsymmetricKey, SizeAsymmetricKey, SizeSymmetricKey } from "../common/enums.ts";
import { EncryptError, UnsupportedOperationError } from "../errors.ts";
import { toBase64 } from "../utilities/utilities.ts";

const enc = newLocalProvider();

Deno.test("AES-GCM round-trip with AAD", async () => {
  const key = await enc.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });
  const ct = await enc.encryptAES({ secretKey: key.keyRef, value: "secret", additional: "aad" });
  const pt = await enc.decryptAES({ secretKey: key.keyRef, cipherValue: ct, additional: "aad" });
  assertEquals(pt, "secret");
});

Deno.test("AES-GCM fails on AAD mismatch", async () => {
  const key = await enc.generateSymmetricKeys({ size: SizeSymmetricKey.Key128Bits });
  const ct = await enc.encryptAES({ secretKey: key.keyRef, value: "secret", additional: "a" });
  await assertRejects(() =>
    enc.decryptAES({ secretKey: key.keyRef, cipherValue: ct, additional: "b" })
  );
});

Deno.test("AES-GCM Web Crypto failures preserve their message and cause as EncryptError", async () => {
  const error = await assertRejects(
    () =>
      enc.encryptAES({
        secretKey: toBase64(new Uint8Array(7)),
        value: "secret",
      }),
    EncryptError,
  );
  assert(error.cause instanceof Error);
  assertEquals(error.message, error.cause.message);
});

Deno.test("RSA-OAEP round-trip", async () => {
  const k = await enc.generateRSAKeys({ size: SizeAsymmetricKey.Key2048Bits });
  const ct = await enc.rsaOaepEncode({ publicKey: k.publicKey, text: "hi" });
  assertEquals(await enc.rsaOaepDecode({ privateKey: k.keyRef, cipherText: ct }), "hi");
});

Deno.test("ECDH round-trip on every curve", async () => {
  for (
    const curve of [
      CurveAsymmetricKey.CurveP256,
      CurveAsymmetricKey.CurveP384,
      CurveAsymmetricKey.CurveP521,
    ]
  ) {
    const k = await enc.generateECDHCurveKeys({ curve });
    const ct = await enc.ecdhEncode({ publicKey: k.publicKey, text: "ecdh" });
    assertEquals(await enc.ecdhDecode({ privateKey: k.keyRef, cipherText: ct }), "ecdh");
  }
});

Deno.test("Ed25519 sign/verify", async () => {
  const k = await enc.generateEd25519Keys();
  const sig = await enc.signEd25519(k.keyRef, "msg");
  await enc.verifyEd25519(k.publicKey, "msg", sig);
  await assertRejects(() => enc.verifyEd25519(k.publicKey, "tampered", sig));
});

Deno.test("signature verification failures retain their public message as EncryptError", async () => {
  const k = await enc.generateEd25519Keys();
  const sig = await enc.signEd25519(k.keyRef, "msg");
  const error = await assertRejects(
    () => enc.verifyEd25519(k.publicKey, "tampered", sig),
    EncryptError,
    "encrypt/local: Ed25519 signature verification failed",
  );
  assert(error.cause instanceof Error);
  assertEquals(error.cause.message, error.message);
});

Deno.test("SHA-256 is stable", async () => {
  assertEquals(
    await enc.sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("RSA-PSS sign/verify", async () => {
  const k = await enc.generateRSAKeys({ size: SizeAsymmetricKey.Key2048Bits });
  const sig = await enc.signRSAPSS(k.keyRef, "data");
  await enc.verifyRSAPSS(k.publicKey, "data", sig);
  await assertRejects(() => enc.verifyRSAPSS(k.publicKey, "other", sig));
});

Deno.test("RSA PKCS1v15 sign/verify", async () => {
  const k = await enc.generateRSAKeys({ size: SizeAsymmetricKey.Key2048Bits });
  const sig = await enc.signRSAPKCS1v15SHA256(k.keyRef, "data");
  await enc.verifyRSAPKCS1v15SHA256("data", k.publicKey, sig);
  await assertRejects(() => enc.verifyRSAPKCS1v15SHA256("other", k.publicKey, sig));
});

Deno.test("HMAC and BLAKE3 produce stable output", async () => {
  assertEquals(await enc.hmac("k", "m"), await enc.hmac("k", "m"));
  assert((await enc.blake3("abc")).length > 0);
  assertEquals(await enc.blake3("abc"), await enc.blake3("abc"));
});

Deno.test("generated key material carries provider metadata", async () => {
  const k = await enc.generateRSAKeys({ size: SizeAsymmetricKey.Key2048Bits });
  assertEquals(k.provider, "local");
  assert(k.keyId.length > 0);
  assert(k.publicKey.length > 0);
  assert(k.keyRef.length > 0);
});

Deno.test("symmetric key has the requested size", async () => {
  const k = await enc.generateSymmetricKeys({ size: SizeSymmetricKey.Key128Bits });
  // 16 raw bytes -> base64 length is 24 with padding.
  assertEquals(atob(k.keyRef).length, 16);
});

Deno.test("aborted signal rejects before work", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assertRejects(() =>
    enc.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits, signal: ctrl.signal })
  );
});

Deno.test("ECDH P-256 round-trip via explicit path", async () => {
  const k = await enc.generateECDHCurveKeys({ curve: CurveAsymmetricKey.CurveP256 });
  const ct = await enc.ecdhEncode({ publicKey: k.publicKey, text: "hi" });
  assertEquals(await enc.ecdhDecode({ privateKey: k.keyRef, cipherText: ct }), "hi");
});

Deno.test("key-management is unsupported on the local provider", async () => {
  await assertRejects(() => enc.getKey({ keyId: "x" }), UnsupportedOperationError);
  await assertRejects(() => enc.rotateKey({ keyId: "x" }), UnsupportedOperationError);
  await assertRejects(() => enc.deactivateKey({ keyId: "x" }), UnsupportedOperationError);
});
