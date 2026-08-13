// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Local cryptographic provider.
 *
 * Every primitive is backed by the Web Crypto API (`crypto.subtle`), which Deno
 * ships natively — so there are no external runtime dependencies except BLAKE3
 * (see {@link LocalProvider.blake3}), which has no Web Crypto equivalent and is
 * delegated to `@noble/hashes`.
 *
 * Key material is exchanged as Base64-encoded DER: SPKI for public keys and
 * PKCS#8 for private keys (raw bytes for symmetric keys). This is the standard,
 * interoperable encoding for keys.
 */

import { encodeHex } from "@std/encoding/hex";
import { blake3 as nobleBlake3 } from "@noble/hashes/blake3";

import { CurveAsymmetricKey } from "../common/enums.ts";
import { UnsupportedOperationError } from "../errors.ts";
import type {
  DeactivateKeyRequest,
  DecryptAESRequest,
  ECDHDecodeRequest,
  ECDHEncodeRequest,
  EncryptAESRequest,
  GenerateECDHCurveKeyRequest,
  GenerateRSAKeyRequest,
  GenerateSymmetricKeyRequest,
  GetKeyRequest,
  KeyData,
  RotateKeyRequest,
  RSAOAEPDecodeRequest,
  RSAOAEPEncodeRequest,
} from "../models/models.ts";
import type { LocalRepository } from "./interface.ts";
import {
  bytesOf,
  decodeECCCipherPayload,
  deriveECCAESKey,
  encodeECCCipherPayload,
  fromBase64,
  importECDHPrivateKey,
  importRSAPrivateKey,
  importRSAPublicKey,
  resolveECDHCurve,
  runWithSignal,
  textOf,
  toBase64,
} from "../utilities/utilities.ts";

const PROVIDER = "local";
const GCM_NONCE_BYTES = 12;
const PSS_SALT_BYTES = 32; // SHA-256 digest length (PSSSaltLengthEqualsHash).

/** Concatenates byte arrays into a single Uint8Array. */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function exportPair(pair: CryptoKeyPair): Promise<{ publicKey: string; privateKey: string }> {
  const [spki, pkcs8] = await Promise.all([
    crypto.subtle.exportKey("spki", pair.publicKey),
    crypto.subtle.exportKey("pkcs8", pair.privateKey),
  ]);
  return { publicKey: toBase64(spki), privateKey: toBase64(pkcs8) };
}

/** Tries each supported curve until the SPKI public key imports cleanly. */
async function importECDHPublicKeyAuto(
  publicKey: string,
): Promise<{ key: CryptoKey; namedCurve: string }> {
  const der = fromBase64(publicKey);
  for (const curve of ["P-256", "P-384", "P-521"]) {
    try {
      const key = await crypto.subtle.importKey(
        "spki",
        der,
        { name: "ECDH", namedCurve: curve },
        false,
        [],
      );
      return { key, namedCurve: curve };
    } catch {
      // Try the next curve.
    }
  }
  throw new Error("encrypt/local: unable to import ECDH public key on any supported curve");
}

/**
 * Local implementation of every encrypt repository interface. Construct it
 * directly or via {@link newLocalProvider}.
 */
export class LocalProvider implements LocalRepository {
  // --- Symmetric ----------------------------------------------------------

  /** Generates a random symmetric key and returns its Base64 secret in `keyRef`. */
  generateSymmetricKeys(input: GenerateSymmetricKeyRequest): Promise<KeyData> {
    return runWithSignal(input.signal, () => {
      const raw = crypto.getRandomValues(new Uint8Array(input.size));
      return Promise.resolve<KeyData>({
        publicKey: "",
        keyId: crypto.randomUUID(),
        keyRef: toBase64(raw),
        provider: PROVIDER,
      });
    });
  }

  /** Encrypts UTF-8 plaintext with AES-GCM and returns a Base64 nonce/ciphertext envelope. */
  encryptAES(input: EncryptAESRequest): Promise<string> {
    return runWithSignal(input.signal, async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        fromBase64(input.secretKey),
        { name: "AES-GCM" },
        false,
        ["encrypt"],
      );
      const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));
      const params: AesGcmParams = { name: "AES-GCM", iv: nonce };
      if (input.additional !== undefined) params.additionalData = bytesOf(input.additional);
      const cipher = new Uint8Array(
        await crypto.subtle.encrypt(params, key, bytesOf(input.value)),
      );
      return toBase64(concatBytes(nonce, cipher));
    });
  }

  /** Decrypts an AES-GCM Base64 envelope and returns UTF-8 plaintext. */
  decryptAES(input: DecryptAESRequest): Promise<string> {
    return runWithSignal(input.signal, async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        fromBase64(input.secretKey),
        { name: "AES-GCM" },
        false,
        ["decrypt"],
      );
      const blob = fromBase64(input.cipherValue);
      const nonce = blob.subarray(0, GCM_NONCE_BYTES);
      const cipher = blob.subarray(GCM_NONCE_BYTES);
      const params: AesGcmParams = { name: "AES-GCM", iv: nonce };
      if (input.additional !== undefined) params.additionalData = bytesOf(input.additional);
      const plain = await crypto.subtle.decrypt(params, key, cipher);
      return textOf(plain);
    });
  }

  // --- Asymmetric (RSA / ECDH) -------------------------------------------

  /** Generates an extractable RSA key pair encoded as Base64 DER. */
  generateRSAKeys(input: GenerateRSAKeyRequest): Promise<KeyData> {
    return runWithSignal(input.signal, async () => {
      // Generated as RSA-PSS to obtain extractable DER; the same DER is later
      // re-imported as RSA-OAEP / PKCS1v15 / PSS as each operation requires.
      const pair = await crypto.subtle.generateKey(
        {
          name: "RSA-PSS",
          modulusLength: input.size,
          publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      );
      const { publicKey, privateKey } = await exportPair(pair);
      return { publicKey, keyId: crypto.randomUUID(), keyRef: privateKey, provider: PROVIDER };
    });
  }

  /** Generates an extractable ECDH key pair on the requested curve. */
  generateECDHCurveKeys(input: GenerateECDHCurveKeyRequest): Promise<KeyData> {
    return runWithSignal(input.signal, async () => {
      const namedCurve = resolveECDHCurve(input.curve);
      const pair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve },
        true,
        ["deriveBits", "deriveKey"],
      );
      const { publicKey, privateKey } = await exportPair(pair);
      return { publicKey, keyId: crypto.randomUUID(), keyRef: privateKey, provider: PROVIDER };
    });
  }

  /** Encrypts UTF-8 text with a Base64 SPKI RSA public key using RSA-OAEP. */
  rsaOaepEncode(input: RSAOAEPEncodeRequest): Promise<string> {
    return runWithSignal(input.signal, async () => {
      const key = await importRSAPublicKey(
        input.publicKey,
        { name: "RSA-OAEP", hash: "SHA-256" },
        ["encrypt"],
      );
      const cipher = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, bytesOf(input.text));
      return toBase64(cipher);
    });
  }

  /** Decrypts Base64 RSA-OAEP ciphertext with a Base64 PKCS#8 private key. */
  rsaOaepDecode(input: RSAOAEPDecodeRequest): Promise<string> {
    return runWithSignal(input.signal, async () => {
      const key = await importRSAPrivateKey(
        input.privateKey,
        { name: "RSA-OAEP", hash: "SHA-256" },
        ["decrypt"],
      );
      const plain = await crypto.subtle.decrypt(
        { name: "RSA-OAEP" },
        key,
        fromBase64(input.cipherText),
      );
      return textOf(plain);
    });
  }

  /** Encrypts text with ephemeral ECDH, HKDF-SHA256 and AES-GCM. */
  ecdhEncode(input: ECDHEncodeRequest): Promise<string> {
    return runWithSignal(input.signal, async () => {
      const { key: recipient, namedCurve } = await importECDHPublicKeyAuto(input.publicKey);
      const ephemeral = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve },
        true,
        ["deriveBits"],
      );
      const aesKey = await deriveECCAESKey(ephemeral.privateKey, recipient, namedCurve);
      const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));
      const cipher = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce },
        aesKey,
        bytesOf(input.text),
      );
      const ephemeralPub = await crypto.subtle.exportKey("spki", ephemeral.publicKey);
      return encodeECCCipherPayload({
        curve: namedCurve,
        ephemeralPublicKey: toBase64(ephemeralPub),
        nonce: toBase64(nonce),
        cipherText: toBase64(cipher),
      });
    });
  }

  /** Decrypts an ECDH hybrid-cipher envelope with the recipient private key. */
  ecdhDecode(input: ECDHDecodeRequest): Promise<string> {
    return runWithSignal(input.signal, async () => {
      const payload = decodeECCCipherPayload(input.cipherText);
      const privateKey = await importECDHPrivateKey(input.privateKey, payload.curve);
      const ephemeralPub = await crypto.subtle.importKey(
        "spki",
        fromBase64(payload.ephemeralPublicKey),
        { name: "ECDH", namedCurve: payload.curve },
        false,
        [],
      );
      const aesKey = await deriveECCAESKey(privateKey, ephemeralPub, payload.curve);
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64(payload.nonce) },
        aesKey,
        fromBase64(payload.cipherText),
      );
      return textOf(plain);
    });
  }

  // --- Key management (provider-backed; unsupported on the local provider) ---

  /** Rejects because local ephemeral keys cannot be rotated by identifier. */
  rotateKey(_input: RotateKeyRequest): Promise<KeyData> {
    return Promise.reject(new UnsupportedOperationError("rotateKey"));
  }

  /** Rejects because local ephemeral keys cannot be retrieved by identifier. */
  getKey(_input: GetKeyRequest): Promise<KeyData> {
    return Promise.reject(new UnsupportedOperationError("getKey"));
  }

  /** Rejects because local ephemeral keys cannot be deactivated by identifier. */
  deactivateKey(_input: DeactivateKeyRequest): Promise<void> {
    return Promise.reject(new UnsupportedOperationError("deactivateKey"));
  }

  // --- Hashing ------------------------------------------------------------

  /** Computes an HMAC-SHA256 signature and returns it as Base64. */
  hmac(secretKey: string, message: string, signal?: AbortSignal): Promise<string> {
    return runWithSignal(signal, async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        bytesOf(secretKey),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign("HMAC", key, bytesOf(message));
      return toBase64(sig);
    });
  }

  /** Computes a lowercase hexadecimal SHA-256 digest. */
  sha256Hex(message: string, signal?: AbortSignal): Promise<string> {
    return runWithSignal(signal, async () => {
      const digest = await crypto.subtle.digest("SHA-256", bytesOf(message));
      return encodeHex(new Uint8Array(digest));
    });
  }

  /** Computes a BLAKE3 digest and returns it as Base64. */
  blake3(message: string, signal?: AbortSignal): Promise<string> {
    return runWithSignal(signal, () => Promise.resolve(toBase64(nobleBlake3(bytesOf(message)))));
  }

  // --- Signatures ---------------------------------------------------------

  /** Generates an extractable Ed25519 key pair encoded as Base64 DER. */
  generateEd25519Keys(signal?: AbortSignal): Promise<KeyData> {
    return runWithSignal(signal, async () => {
      const pair = await crypto.subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"],
      ) as CryptoKeyPair;
      const { publicKey, privateKey } = await exportPair(pair);
      return { publicKey, keyId: crypto.randomUUID(), keyRef: privateKey, provider: PROVIDER };
    });
  }

  /** Signs UTF-8 text with a Base64 PKCS#8 Ed25519 private key. */
  signEd25519(privateKey: string, text: string, signal?: AbortSignal): Promise<string> {
    return runWithSignal(signal, async () => {
      const key = await crypto.subtle.importKey(
        "pkcs8",
        fromBase64(privateKey),
        { name: "Ed25519" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, bytesOf(text));
      return toBase64(sig);
    });
  }

  /** Verifies an Ed25519 signature or rejects when it is invalid. */
  verifyEd25519(
    publicKey: string,
    text: string,
    signature: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return runWithSignal(signal, async () => {
      const key = await crypto.subtle.importKey(
        "spki",
        fromBase64(publicKey),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      const ok = await crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        fromBase64(signature),
        bytesOf(text),
      );
      if (!ok) throw new Error("encrypt/local: Ed25519 signature verification failed");
    });
  }

  /** Signs UTF-8 text with RSA-PSS/SHA-256 and returns Base64. */
  signRSAPSS(privateKey: string, text: string, signal?: AbortSignal): Promise<string> {
    return runWithSignal(signal, async () => {
      const key = await importRSAPrivateKey(
        privateKey,
        { name: "RSA-PSS", hash: "SHA-256" },
        ["sign"],
      );
      const sig = await crypto.subtle.sign(
        { name: "RSA-PSS", saltLength: PSS_SALT_BYTES },
        key,
        bytesOf(text),
      );
      return toBase64(sig);
    });
  }

  /** Verifies an RSA-PSS/SHA-256 signature or rejects when it is invalid. */
  verifyRSAPSS(
    publicKey: string,
    text: string,
    signature: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return runWithSignal(signal, async () => {
      const key = await importRSAPublicKey(
        publicKey,
        { name: "RSA-PSS", hash: "SHA-256" },
        ["verify"],
      );
      const ok = await crypto.subtle.verify(
        { name: "RSA-PSS", saltLength: PSS_SALT_BYTES },
        key,
        fromBase64(signature),
        bytesOf(text),
      );
      if (!ok) throw new Error("encrypt/local: RSA-PSS signature verification failed");
    });
  }

  /** Signs UTF-8 data with RSASSA-PKCS1-v1_5/SHA-256 and returns Base64. */
  signRSAPKCS1v15SHA256(privateKey: string, data: string, signal?: AbortSignal): Promise<string> {
    return runWithSignal(signal, async () => {
      const key = await importRSAPrivateKey(
        privateKey,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        ["sign"],
      );
      const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, bytesOf(data));
      return toBase64(sig);
    });
  }

  /** Verifies an RSASSA-PKCS1-v1_5/SHA-256 signature or rejects when invalid. */
  verifyRSAPKCS1v15SHA256(
    data: string,
    publicKey: string,
    signature: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return runWithSignal(signal, async () => {
      const key = await importRSAPublicKey(
        publicKey,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        ["verify"],
      );
      const ok = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        fromBase64(signature),
        bytesOf(data),
      );
      if (!ok) throw new Error("encrypt/local: RSA PKCS1v15 signature verification failed");
    });
  }
}

/** Factory constructor. */
export function newLocalProvider(): LocalProvider {
  return new LocalProvider();
}

/** Re-export of the supported asymmetric-curve constants. */
export { CurveAsymmetricKey };
