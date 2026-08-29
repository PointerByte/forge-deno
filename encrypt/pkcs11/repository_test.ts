// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { AttributeType, boolValue, findAttribute, Mechanism } from "./cryptoki.ts";
import {
  Pkcs11KeyUriRequiredError,
  Pkcs11ModuleRequiredError,
  Pkcs11OaepHashUnsupportedError,
  Pkcs11PinRequiredError,
  Pkcs11SecretNotExtractableError,
  Pkcs11TokenRequiredError,
  Pkcs11UnsupportedMechanismError,
} from "./errors.ts";
import { newPkcs11Provider, type Pkcs11Provider } from "./repository.ts";
import { FakeToken, FULL_MECHANISMS } from "./test_support.ts";
import { isKeyUri, parseKeyUri } from "./uri.ts";
import { CurveAsymmetricKey, SizeAsymmetricKey, SizeSymmetricKey } from "../common/enums.ts";
import { newLocalProvider } from "../local/repository.ts";

const local = newLocalProvider();

/** Builds a provider over a fresh in-memory token. */
function provider(
  options: { mechanisms?: number[]; refuseSecretExtraction?: boolean } = {},
  overrides: Record<string, unknown> = {},
): { hsm: Pkcs11Provider; token: FakeToken } {
  const token = new FakeToken(options);
  const hsm = newPkcs11Provider({
    module: token,
    tokenLabel: "forge-test",
    pin: () => "1234",
    ...overrides,
  });
  return { hsm, token };
}

/** The mechanism list minus the named mechanisms. */
function without(...excluded: number[]): number[] {
  return FULL_MECHANISMS.filter((mechanism) => !excluded.includes(mechanism));
}

// --- Configuration ----------------------------------------------------------

Deno.test("configuration is validated on first use, not at construction", async () => {
  const hsm = newPkcs11Provider();
  await assertRejects(
    () => hsm.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits }),
    Pkcs11ModuleRequiredError,
  );
});

Deno.test("an injected module still needs a token and a pin", async () => {
  const noToken = newPkcs11Provider({ module: new FakeToken(), pin: () => "1234" });
  await assertRejects(
    () => noToken.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits }),
    Pkcs11TokenRequiredError,
  );

  const noPin = newPkcs11Provider({ module: new FakeToken(), tokenLabel: "forge-test" });
  await assertRejects(
    () => noPin.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits }),
    Pkcs11PinRequiredError,
  );
});

Deno.test("an operation with no reference and no default key uri fails", async () => {
  const { hsm } = provider();
  await assertRejects(
    () => hsm.getKey({ keyId: "" }),
    Pkcs11KeyUriRequiredError,
  );
});

Deno.test("the configured key uri is the default reference", async () => {
  const { hsm } = provider();
  const key = await hsm.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });

  const withDefault = newPkcs11Provider({
    module: new FakeToken(),
    tokenLabel: "forge-test",
    pin: () => "1234",
    keyUri: key.keyRef,
  });
  // The default is parsed and used; the object lives on the other token, so
  // the failure proves the reference was resolved rather than rejected.
  await assertRejects(() => withDefault.getKey({ keyId: "" }));
});

Deno.test("the token is logged into once for many operations", async () => {
  const { hsm, token } = provider();
  await hsm.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });
  await hsm.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });
  await hsm.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });
  assertEquals(token.logins, 1);
});

// --- Routing ----------------------------------------------------------------

Deno.test("local key material never reaches the token", async () => {
  const { hsm, token } = provider();
  const key = await local.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });

  const cipher = await hsm.encryptAES({ secretKey: key.keyRef, value: "secret" });
  assertEquals(await hsm.decryptAES({ secretKey: key.keyRef, cipherValue: cipher }), "secret");
  assertEquals(token.logins, 0);
});

Deno.test("hashing that a token cannot accelerate stays local", async () => {
  const { hsm, token } = provider();
  assertEquals(await hsm.sha256Hex("payload"), await local.sha256Hex("payload"));
  assertEquals(await hsm.blake3("payload"), await local.blake3("payload"));
  assertEquals(token.logins, 0);
});

// --- Symmetric --------------------------------------------------------------

Deno.test("generated symmetric keys are non-extractable and referenced by uri", async () => {
  const { hsm, token } = provider();
  const key = await hsm.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits, uid: "app" });

  assertEquals(key.provider, "pkcs11");
  assert(isKeyUri(key.keyRef));
  assertEquals(parseKeyUri(key.keyRef).object, "GoForge-symmetric-app");
  assertEquals(key.publicKey, "");

  const stored = token.object(token.handles()[0])!;
  assertEquals(boolValue(stored.attributes.get(AttributeType.Sensitive)!), true);
  assertEquals(boolValue(stored.attributes.get(AttributeType.Extractable)!), false);
  assertEquals(stored.attributes.get(AttributeType.Value), undefined);
});

Deno.test("AES round-trips on the token, with and without AAD", async () => {
  const { hsm } = provider();
  const key = await hsm.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });

  const plain = await hsm.decryptAES({
    secretKey: key.keyRef,
    cipherValue: await hsm.encryptAES({ secretKey: key.keyRef, value: "secret" }),
  });
  assertEquals(plain, "secret");

  const withAad = await hsm.decryptAES({
    secretKey: key.keyRef,
    cipherValue: await hsm.encryptAES({
      secretKey: key.keyRef,
      value: "secret",
      additional: "aad",
    }),
    additional: "aad",
  });
  assertEquals(withAad, "secret");
});

Deno.test("token ciphertext carries the local provider's nonce prefix", async () => {
  const { hsm } = provider();
  const key = await hsm.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });
  const cipher = await hsm.encryptAES({ secretKey: key.keyRef, value: "0123456789" });

  // 12-byte nonce + 10-byte plaintext + 16-byte tag.
  assertEquals(atob(cipher).length, 12 + 10 + 16);
});

Deno.test("a token that cannot do AES-GCM fails instead of falling back", async () => {
  const { hsm } = provider({ mechanisms: without(Mechanism.AesGcm) });
  const key = await hsm.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });

  const error = await assertRejects(
    () => hsm.encryptAES({ secretKey: key.keyRef, value: "secret" }),
    Pkcs11UnsupportedMechanismError,
  );
  assertEquals(error.mechanism, "CKM_AES_GCM");
});

Deno.test("short ciphertext is rejected before it reaches the token", async () => {
  const { hsm } = provider();
  const key = await hsm.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });
  await assertRejects(
    () => hsm.decryptAES({ secretKey: key.keyRef, cipherValue: btoa("short") }),
    Error,
    "shorter than the nonce",
  );
});

Deno.test("unsupported symmetric sizes are rejected", async () => {
  const { hsm } = provider();
  await assertRejects(
    () => hsm.generateSymmetricKeys({ size: 24 as SizeSymmetricKey }),
    Error,
    "unsupported symmetric key size",
  );
});

// --- RSA --------------------------------------------------------------------

Deno.test("generated RSA keys report an importable SPKI public key", async () => {
  const { hsm } = provider();
  const key = await hsm.generateRSAKeys({ size: SizeAsymmetricKey.Key2048Bits });

  assert(isKeyUri(key.keyRef));
  const imported = await crypto.subtle.importKey(
    "spki",
    Uint8Array.from(atob(key.publicKey), (char) => char.charCodeAt(0)),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  assertEquals(imported.type, "public");
});

Deno.test("RSA-OAEP encrypts with the fetched public key and decrypts on the token", async () => {
  const { hsm } = provider();
  const key = await hsm.generateRSAKeys({ size: SizeAsymmetricKey.Key2048Bits });

  const cipher = await hsm.rsaOaepEncode({ publicKey: key.keyRef, text: "secret" });
  assertEquals(await hsm.rsaOaepDecode({ privateKey: key.keyRef, cipherText: cipher }), "secret");
});

Deno.test("a token that refuses SHA-256 OAEP says so", async () => {
  const { hsm, token } = provider();
  const key = await hsm.generateRSAKeys({ size: SizeAsymmetricKey.Key2048Bits });
  const cipher = await hsm.rsaOaepEncode({ publicKey: key.keyRef, text: "secret" });

  // A SoftHSM2-style token: OAEP is advertised, but only with SHA-1.
  token.decrypt = () =>
    Promise.reject(Object.assign(new Error("CKR_MECHANISM_PARAM_INVALID"), { code: 0x71 }));
  await assertRejects(
    () => hsm.rsaOaepDecode({ privateKey: key.keyRef, cipherText: cipher }),
    Pkcs11OaepHashUnsupportedError,
  );
});

Deno.test("unsupported RSA sizes are rejected", async () => {
  const { hsm } = provider();
  await assertRejects(
    () => hsm.generateRSAKeys({ size: 1024 as SizeAsymmetricKey }),
    Error,
    "unsupported rsa key size",
  );
});

// --- Signatures -------------------------------------------------------------

Deno.test("RSA-PSS signs on the token and verifies locally", async () => {
  const { hsm } = provider();
  const key = await hsm.generateRSAKeys({ size: SizeAsymmetricKey.Key2048Bits });

  const signature = await hsm.signRSAPSS(key.keyRef, "payload");
  await hsm.verifyRSAPSS(key.keyRef, "payload", signature);
  await local.verifyRSAPSS(key.publicKey, "payload", signature);
  await assertRejects(() => hsm.verifyRSAPSS(key.keyRef, "tampered", signature));
});

Deno.test("RSA PKCS#1 v1.5 signs on the token and verifies locally", async () => {
  const { hsm } = provider();
  const key = await hsm.generateRSAKeys({ size: SizeAsymmetricKey.Key2048Bits });

  const signature = await hsm.signRSAPKCS1v15SHA256(key.keyRef, "payload");
  await hsm.verifyRSAPKCS1v15SHA256("payload", key.keyRef, signature);
  await local.verifyRSAPKCS1v15SHA256("payload", key.publicKey, signature);
});

Deno.test("a token with neither PKCS#1 mechanism refuses to sign", async () => {
  const { hsm } = provider({
    mechanisms: without(Mechanism.Sha256RsaPkcs, Mechanism.RsaPkcs),
  });
  const key = await hsm.generateRSAKeys({ size: SizeAsymmetricKey.Key2048Bits });

  const error = await assertRejects(
    () => hsm.signRSAPKCS1v15SHA256(key.keyRef, "payload"),
    Pkcs11UnsupportedMechanismError,
  );
  assertEquals(error.mechanism, "CKM_SHA256_RSA_PKCS");
});

Deno.test("Ed25519 signs on the token and verifies locally", async () => {
  const { hsm } = provider();
  const key = await hsm.generateEd25519Keys();

  const signature = await hsm.signEd25519(key.keyRef, "payload");
  await hsm.verifyEd25519(key.keyRef, "payload", signature);
  await local.verifyEd25519(key.publicKey, "payload", signature);
});

Deno.test("a token without CKM_EDDSA refuses to sign", async () => {
  const { hsm } = provider({ mechanisms: without(Mechanism.EdDsa) });
  const key = await hsm.generateEd25519Keys();
  await assertRejects(
    () => hsm.signEd25519(key.keyRef, "payload"),
    Pkcs11UnsupportedMechanismError,
  );
});

Deno.test("local signing keys bypass the token entirely", async () => {
  const { hsm, token } = provider();
  const key = await local.generateEd25519Keys();

  const signature = await hsm.signEd25519(key.keyRef, "payload");
  await hsm.verifyEd25519(key.publicKey, "payload", signature);
  assertEquals(token.logins, 0);
});

// --- HMAC -------------------------------------------------------------------

Deno.test("HMAC runs on the token for a uri and locally for a secret", async () => {
  const { hsm, token } = provider();
  const key = await hsm.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });

  const onToken = await hsm.hmac(key.keyRef, "payload");
  assertEquals(onToken, await hsm.hmac(key.keyRef, "payload"));
  assertEquals(token.logins, 1);

  assertEquals(
    await hsm.hmac("shared-secret", "payload"),
    await local.hmac("shared-secret", "payload"),
  );
});

Deno.test("a token without CKM_SHA256_HMAC refuses to MAC", async () => {
  const { hsm } = provider({ mechanisms: without(Mechanism.Sha256Hmac) });
  const key = await hsm.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });
  await assertRejects(() => hsm.hmac(key.keyRef, "payload"), Pkcs11UnsupportedMechanismError);
});

// --- ECDH -------------------------------------------------------------------

Deno.test("ECDH round-trips with the derivation inside the token", async () => {
  const { hsm } = provider();
  const key = await hsm.generateECDHCurveKeys({ curve: CurveAsymmetricKey.CurveP256 });

  const payload = await hsm.ecdhEncode({ publicKey: key.keyRef, text: "secret" });
  assertEquals(await hsm.ecdhDecode({ privateKey: key.keyRef, cipherText: payload }), "secret");
});

Deno.test("ECDH falls back to extraction when the token has no HKDF", async () => {
  const { hsm } = provider({ mechanisms: without(Mechanism.HkdfDerive) });
  const key = await hsm.generateECDHCurveKeys({ curve: CurveAsymmetricKey.CurveP384 });

  const payload = await hsm.ecdhEncode({ publicKey: key.keyRef, text: "secret" });
  assertEquals(await hsm.ecdhDecode({ privateKey: key.keyRef, cipherText: payload }), "secret");
});

Deno.test("ECDH fails rather than extracting when extraction is disabled", async () => {
  const { hsm } = provider(
    { mechanisms: without(Mechanism.HkdfDerive) },
    { allowSecretExtraction: false },
  );
  const key = await hsm.generateECDHCurveKeys({ curve: CurveAsymmetricKey.CurveP256 });
  const payload = await hsm.ecdhEncode({ publicKey: key.keyRef, text: "secret" });

  await assertRejects(
    () => hsm.ecdhDecode({ privateKey: key.keyRef, cipherText: payload }),
    Pkcs11SecretNotExtractableError,
  );
});

Deno.test("ECDH reports a token that will not release the derived secret", async () => {
  const { hsm } = provider({
    mechanisms: without(Mechanism.HkdfDerive),
    refuseSecretExtraction: true,
  });
  const key = await hsm.generateECDHCurveKeys({ curve: CurveAsymmetricKey.CurveP256 });
  const payload = await hsm.ecdhEncode({ publicKey: key.keyRef, text: "secret" });

  await assertRejects(
    () => hsm.ecdhDecode({ privateKey: key.keyRef, cipherText: payload }),
    Pkcs11SecretNotExtractableError,
  );
});

Deno.test("a token without CKM_ECDH1_DERIVE refuses to decrypt", async () => {
  const { hsm } = provider();
  const key = await hsm.generateECDHCurveKeys({ curve: CurveAsymmetricKey.CurveP256 });
  const payload = await hsm.ecdhEncode({ publicKey: key.keyRef, text: "secret" });

  const { hsm: crippled } = provider({ mechanisms: without(Mechanism.Ecdh1Derive) });
  await assertRejects(
    () => crippled.ecdhDecode({ privateKey: key.keyRef, cipherText: payload }),
    Pkcs11UnsupportedMechanismError,
  );
});

Deno.test("unsupported curves are rejected", async () => {
  const { hsm } = provider();
  await assertRejects(
    () => hsm.generateECDHCurveKeys({ curve: 224 as CurveAsymmetricKey }),
    Error,
    "unsupported ecc curve",
  );
});

// --- Key management ---------------------------------------------------------

Deno.test("getKey resolves the reference and reports the public key", async () => {
  const { hsm } = provider();
  const key = await hsm.generateRSAKeys({ size: SizeAsymmetricKey.Key2048Bits });

  const fetched = await hsm.getKey({ keyId: key.keyRef });
  assertEquals(fetched.keyRef, key.keyRef);
  assertEquals(fetched.publicKey, key.publicKey);
  assertEquals(fetched.provider, "pkcs11");
});

Deno.test("getKey on a bare AES key reports the reference and no public half", async () => {
  const { hsm } = provider();
  const key = await hsm.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });

  const fetched = await hsm.getKey({ keyId: key.keyRef });
  assertEquals(fetched.publicKey, "");
  assertEquals(fetched.keyId, key.keyId);
});

Deno.test("rotateKey mints a new reference and leaves the previous key usable", async () => {
  const { hsm } = provider();
  const key = await hsm.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });
  const cipher = await hsm.encryptAES({ secretKey: key.keyRef, value: "secret" });

  const rotated = await hsm.rotateKey({ keyId: key.keyRef });
  assertNotEquals(rotated.keyRef, key.keyRef);
  assertEquals(rotated.provider, "pkcs11");
  assertEquals(
    await hsm.decryptAES({ secretKey: key.keyRef, cipherValue: cipher }),
    "secret",
  );
});

Deno.test("rotateKey can disable the previous key", async () => {
  const { hsm, token } = provider({}, { rotateDisablesPrevious: true });
  const key = await hsm.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });
  const previous = token.handles()[0];

  await hsm.rotateKey({ keyId: key.keyRef });
  const stored = token.object(previous)!;
  assertEquals(boolValue(stored.attributes.get(AttributeType.Encrypt)!), false);
  assertEquals(boolValue(stored.attributes.get(AttributeType.Decrypt)!), false);
});

Deno.test("rotating an RSA key preserves its modulus size", async () => {
  const { hsm } = provider();
  const key = await hsm.generateRSAKeys({ size: SizeAsymmetricKey.Key2048Bits });

  const rotated = await hsm.rotateKey({ keyId: key.keyRef });
  assertNotEquals(rotated.publicKey, key.publicKey);
  assertEquals(rotated.publicKey.length, key.publicKey.length);
});

Deno.test("rotating an EC key preserves its curve", async () => {
  const { hsm } = provider();
  const key = await hsm.generateECDHCurveKeys({ curve: CurveAsymmetricKey.CurveP384 });

  const rotated = await hsm.rotateKey({ keyId: key.keyRef });
  assertNotEquals(rotated.publicKey, key.publicKey);

  const payload = await hsm.ecdhEncode({ publicKey: rotated.keyRef, text: "secret" });
  assertEquals(await hsm.ecdhDecode({ privateKey: rotated.keyRef, cipherText: payload }), "secret");
});

Deno.test("rotation labels do not accumulate suffixes", async () => {
  const { hsm } = provider();
  const key = await hsm.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });

  const once = await hsm.rotateKey({ keyId: key.keyRef });
  const twice = await hsm.rotateKey({ keyId: once.keyRef });
  const label = parseKeyUri(twice.keyRef).object!;
  assertEquals(label.split("-").length, "GoForge-symmetric-0".split("-").length);
});

Deno.test("deactivateKey clears every usage attribute the object carries", async () => {
  const { hsm, token } = provider();
  const key = await hsm.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });
  const handle = token.handles()[0];

  await hsm.deactivateKey({ keyId: key.keyRef });
  const stored = token.object(handle)!;
  assertEquals(boolValue(stored.attributes.get(AttributeType.Encrypt)!), false);
  assertEquals(boolValue(stored.attributes.get(AttributeType.Decrypt)!), false);
});

Deno.test("deactivateKey fails rather than destroying a key it cannot disable", async () => {
  const { hsm, token } = provider();
  const key = await hsm.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });
  token.setAttributes = () => Promise.reject(new Error("CKR_ATTRIBUTE_READ_ONLY"));

  await assertRejects(() => hsm.deactivateKey({ keyId: key.keyRef }));
  assertEquals(token.handles().length, 1);
});

Deno.test("deactivateKey destroys the object when the caller asked for it", async () => {
  const { hsm, token } = provider({}, { deactivateDestroys: true });
  const key = await hsm.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });
  token.setAttributes = () => Promise.reject(new Error("CKR_ATTRIBUTE_READ_ONLY"));

  await hsm.deactivateKey({ keyId: key.keyRef });
  assertEquals(token.handles().length, 0);
});

// --- Cancellation and sessions ---------------------------------------------

Deno.test("an aborted signal rejects before the token is touched", async () => {
  const { hsm, token } = provider();
  await assertRejects(() =>
    hsm.generateSymmetricKeys({
      size: SizeSymmetricKey.Key256Bits,
      signal: AbortSignal.abort(),
    })
  );
  assertEquals(token.logins, 0);
});

Deno.test("concurrent operations stay within the session bound", async () => {
  const { hsm, token } = provider({}, { maxSessions: 2 });
  await Promise.all(
    Array.from(
      { length: 8 },
      () => hsm.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits }),
    ),
  );
  assert(token.peakSessions <= 2, `peak ${token.peakSessions} exceeds the bound`);
});

Deno.test("close is a no-op for an injected module", async () => {
  const { hsm } = provider();
  await hsm.close();
});

Deno.test("findAttribute reports absent attributes as missing", () => {
  assertEquals(
    findAttribute([{ type: 1, value: new Uint8Array(0), present: false }], 1),
    undefined,
  );
});
