// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Encrypt module example. Run with: `deno run examples/encrypt.ts`
 *
 * Uses a local import map entry so it works inside the repo; consumers would
 * import from `@pointerbyte/denoforge/encrypt` instead.
 */

import {
  CurveAsymmetricKey,
  newLocalProvider,
  SizeAsymmetricKey,
  SizeSymmetricKey,
} from "../encrypt/mod.ts";

const enc = newLocalProvider();

// --- Symmetric (AES-GCM) ---
const symKey = await enc.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });
const cipher = await enc.encryptAES({
  secretKey: symKey.keyRef,
  value: "top secret",
  additional: "ctx-v1",
});
const plain = await enc.decryptAES({
  secretKey: symKey.keyRef,
  cipherValue: cipher,
  additional: "ctx-v1",
});
console.log("AES-GCM round-trip:", plain);

// --- Asymmetric (RSA-OAEP) ---
const rsa = await enc.generateRSAKeys({ size: SizeAsymmetricKey.Key2048Bits });
const rsaCipher = await enc.rsaOaepEncode({ publicKey: rsa.publicKey, text: "hello rsa" });
console.log(
  "RSA-OAEP round-trip:",
  await enc.rsaOaepDecode({
    privateKey: rsa.keyRef,
    cipherText: rsaCipher,
  }),
);

// --- ECDH hybrid encryption ---
const ec = await enc.generateECDHCurveKeys({ curve: CurveAsymmetricKey.CurveP256 });
const ecCipher = await enc.ecdhEncode({ publicKey: ec.publicKey, text: "hello ecdh" });
console.log(
  "ECDH round-trip:",
  await enc.ecdhDecode({
    privateKey: ec.keyRef,
    cipherText: ecCipher,
  }),
);

// --- Signatures (Ed25519) ---
const ed = await enc.generateEd25519Keys();
const signature = await enc.signEd25519(ed.keyRef, "sign me");
await enc.verifyEd25519(ed.publicKey, "sign me", signature);
console.log("Ed25519 signature verified");

// --- Hashing ---
console.log("SHA-256:", await enc.sha256Hex("abc"));
console.log("HMAC:", await enc.hmac("key", "message"));
console.log("BLAKE3:", await enc.blake3("abc"));
