// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests against a real PKCS#11 token.
 *
 * They need a writable token and they mutate it, so they are skipped unless
 * `FORGE_PKCS11_MODULE` and `FORGE_PKCS11_PIN` are set — the Deno counterpart
 * of forge-go's `pkcs11_integration` build tag. Against SoftHSM2:
 *
 * ```bash
 * softhsm2-util --init-token --free --label forge-hsm --pin 1234 --so-pin 1234
 * FORGE_PKCS11_MODULE=/usr/lib64/pkcs11/libsofthsm2.so \
 * FORGE_PKCS11_PIN=1234 \
 * deno test -A encrypt/pkcs11/integration_test.ts
 * ```
 *
 * This is the only automated proof that the hand-written `CK_FUNCTION_LIST`
 * offsets and struct layouts in `ffi.ts` match a real module.
 *
 * @module
 */

import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  AttributeType,
  boolAttribute,
  bytesAttribute,
  KeyType,
  Mechanism,
  textAttribute,
  ulongAttribute,
} from "./cryptoki.ts";
import { Pkcs11OaepHashUnsupportedError } from "./errors.ts";
import { loadModule } from "./ffi.ts";
import { newPkcs11Provider, type Pkcs11Provider } from "./repository.ts";
import { formatKeyUri, isKeyUri, ObjectClass } from "./uri.ts";
import { CurveAsymmetricKey, SizeAsymmetricKey, SizeSymmetricKey } from "../common/enums.ts";
import { newLocalProvider } from "../local/repository.ts";

const modulePath = Deno.env.get("FORGE_PKCS11_MODULE") ?? "";
const pin = Deno.env.get("FORGE_PKCS11_PIN") ?? "";
const tokenLabel = Deno.env.get("FORGE_PKCS11_TOKEN") ?? "forge-hsm";
const enabled = modulePath !== "" && pin !== "";

const local = newLocalProvider();

/** Builds a provider against the configured token. */
function hsm(overrides: Record<string, unknown> = {}): Pkcs11Provider {
  return newPkcs11Provider({ modulePath, tokenLabel, pin: () => pin, ...overrides });
}

/** Declares a test that only runs when a token is configured. */
function tokenTest(name: string, fn: () => Promise<void>): void {
  Deno.test({ name, ignore: !enabled, fn });
}

tokenTest("a token-generated AES key encrypts and decrypts in hardware", async () => {
  const provider = hsm();
  const key = await provider.generateSymmetricKeys({
    size: SizeSymmetricKey.Key256Bits,
    uid: "integration",
  });
  assert(isKeyUri(key.keyRef));
  assertEquals(key.provider, "pkcs11");

  const cipher = await provider.encryptAES({
    secretKey: key.keyRef,
    value: "hardware round trip",
    additional: "aad",
  });
  const plain = await provider.decryptAES({
    secretKey: key.keyRef,
    cipherValue: cipher,
    additional: "aad",
  });
  assertEquals(plain, "hardware round trip");

  await assertRejects(() =>
    provider.decryptAES({ secretKey: key.keyRef, cipherValue: cipher, additional: "other" })
  );
  await provider.deactivateKey({ keyId: key.keyRef });
});

tokenTest("a token-generated private key cannot be read out", async () => {
  const provider = hsm();
  const key = await provider.generateRSAKeys({
    size: SizeAsymmetricKey.Key2048Bits,
    uid: "integration",
  });

  const module = loadModule(modulePath);
  await module.initialize();
  const slots = await module.slots(true);
  const slot = slots.find((candidate) => candidate.tokenLabel === tokenLabel)!;
  const session = await module.openSession(slot.id);
  await module.login(session, pin);
  try {
    const handles = await module.findObjects(session, [
      ulongAttribute(AttributeType.Class, ObjectClass.PrivateKey),
      textAttribute(AttributeType.Label, `GoForge-rsa-integration`),
    ]);
    assert(handles.length > 0, "the generated private key should be on the token");
    const attributes = await module.getAttributes(session, handles[0], [
      AttributeType.PrivateExponent,
      AttributeType.Extractable,
    ]);
    const exponent = attributes.find((a) => a.type === AttributeType.PrivateExponent)!;
    assert(
      !exponent.present || exponent.value.length === 0,
      "CKA_PRIVATE_EXPONENT must not be readable",
    );
  } finally {
    await module.closeSession(session);
  }

  await provider.deactivateKey({ keyId: key.keyRef });
  await provider.close();
});

tokenTest("RSA-PSS signs in hardware and verifies against the reported key", async () => {
  const provider = hsm();
  const key = await provider.generateRSAKeys({ size: SizeAsymmetricKey.Key2048Bits });

  const signature = await provider.signRSAPSS(key.keyRef, "payload");
  await local.verifyRSAPSS(key.publicKey, "payload", signature);
  await provider.verifyRSAPSS(key.keyRef, "payload", signature);
  await assertRejects(() => local.verifyRSAPSS(key.publicKey, "tampered", signature));

  await provider.deactivateKey({ keyId: key.keyRef });
});

tokenTest("RSA PKCS#1 v1.5 signs in hardware and verifies locally", async () => {
  const provider = hsm();
  const key = await provider.generateRSAKeys({ size: SizeAsymmetricKey.Key2048Bits });

  const signature = await provider.signRSAPKCS1v15SHA256(key.keyRef, "payload");
  await local.verifyRSAPKCS1v15SHA256("payload", key.publicKey, signature);

  await provider.deactivateKey({ keyId: key.keyRef });
});

tokenTest("RSA-OAEP either round-trips or reports the token's hash limit", async () => {
  const provider = hsm();
  const key = await provider.generateRSAKeys({ size: SizeAsymmetricKey.Key2048Bits });
  const cipher = await provider.rsaOaepEncode({ publicKey: key.keyRef, text: "sealed" });

  try {
    assertEquals(
      await provider.rsaOaepDecode({ privateKey: key.keyRef, cipherText: cipher }),
      "sealed",
    );
  } catch (failure) {
    // SoftHSM2 hardcodes OAEP to SHA-1, so it cannot run this path. Reporting
    // that is the documented behavior, not a failure.
    assert(
      failure instanceof Pkcs11OaepHashUnsupportedError,
      `unexpected failure: ${failure}`,
    );
  }
  await provider.deactivateKey({ keyId: key.keyRef });
});

tokenTest("ECDH round-trips through the token", async () => {
  const provider = hsm();
  const key = await provider.generateECDHCurveKeys({ curve: CurveAsymmetricKey.CurveP256 });

  const payload = await provider.ecdhEncode({ publicKey: key.keyRef, text: "shared" });
  assertEquals(
    await provider.ecdhDecode({ privateKey: key.keyRef, cipherText: payload }),
    "shared",
  );
  await provider.deactivateKey({ keyId: key.keyRef });
});

tokenTest("Ed25519 signs in hardware when the token supports it", async () => {
  const provider = hsm();
  let key;
  try {
    key = await provider.generateEd25519Keys();
  } catch (failure) {
    console.log(`token cannot generate Ed25519 keys, skipping: ${failure}`);
    return;
  }

  const signature = await provider.signEd25519(key.keyRef, "payload");
  await local.verifyEd25519(key.publicKey, "payload", signature);
  await provider.deactivateKey({ keyId: key.keyRef });
});

tokenTest("HMAC runs on a provisioned generic secret key", async () => {
  const provider = hsm();
  const reference = await provisionHmacKey();
  if (!reference) return;

  const mac = await provider.hmac(reference, "message");
  assert(mac.length > 0);
  assertEquals(await provider.hmac(reference, "message"), mac);
  assertNotEquals(await provider.hmac(reference, "different"), mac);
  await provider.deactivateKey({ keyId: reference });
});

tokenTest("getKey resolves a reference the token actually holds", async () => {
  const provider = hsm();
  const key = await provider.generateECDHCurveKeys({ curve: CurveAsymmetricKey.CurveP256 });

  const fetched = await provider.getKey({ keyId: key.keyRef });
  assertEquals(fetched.keyRef, key.keyRef);
  assertEquals(fetched.publicKey, key.publicKey);
  await provider.deactivateKey({ keyId: key.keyRef });
});

tokenTest("rotateKey mints a distinct reference on the token", async () => {
  const provider = hsm();
  const key = await provider.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });
  const rotated = await provider.rotateKey({ keyId: key.keyRef });

  assertNotEquals(rotated.keyRef, key.keyRef);
  const cipher = await provider.encryptAES({ secretKey: rotated.keyRef, value: "after rotation" });
  assertEquals(
    await provider.decryptAES({ secretKey: rotated.keyRef, cipherValue: cipher }),
    "after rotation",
  );

  await provider.deactivateKey({ keyId: key.keyRef });
  await provider.deactivateKey({ keyId: rotated.keyRef });
});

/**
 * Creates the `CKK_GENERIC_SECRET` key `CKM_SHA256_HMAC` needs, which
 * `generateSymmetricKeys` deliberately does not produce.
 */
async function provisionHmacKey(): Promise<string | undefined> {
  const module = loadModule(modulePath);
  await module.initialize();
  const slots = await module.slots(true);
  const slot = slots.find((candidate) => candidate.tokenLabel === tokenLabel);
  if (!slot) return undefined;

  const mechanisms = await module.mechanisms(slot.id);
  if (
    !mechanisms.includes(Mechanism.GenericSecretKeyGen) ||
    !mechanisms.includes(Mechanism.Sha256Hmac)
  ) {
    console.log("token cannot MAC with a generic secret key, skipping");
    return undefined;
  }

  const session = await module.openSession(slot.id);
  await module.login(session, pin);
  const id = crypto.getRandomValues(new Uint8Array(16));
  const label = `GoForge-hmac-integration-${Date.now()}`;
  try {
    await module.generateKey(session, Mechanism.GenericSecretKeyGen, [
      boolAttribute(AttributeType.Token, true),
      boolAttribute(AttributeType.Private, true),
      boolAttribute(AttributeType.Sensitive, true),
      boolAttribute(AttributeType.Extractable, false),
      textAttribute(AttributeType.Label, label),
      bytesAttribute(AttributeType.Id, id),
      ulongAttribute(AttributeType.Class, ObjectClass.SecretKey),
      ulongAttribute(AttributeType.KeyType, KeyType.GenericSecret),
      ulongAttribute(AttributeType.ValueLen, 32),
      boolAttribute(AttributeType.Sign, true),
      boolAttribute(AttributeType.Verify, true),
    ]);
  } catch (failure) {
    console.log(`token refused a generic secret key, skipping: ${failure}`);
    return undefined;
  } finally {
    await module.closeSession(session);
  }
  return formatKeyUri({ object: label, id, class: ObjectClass.SecretKey });
}
