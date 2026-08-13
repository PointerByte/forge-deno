// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared helpers for the encrypt module.
 *
 * Built on the Web Crypto API (`crypto.subtle`): wraps key import/export, ECDH
 * curve resolution, HKDF key derivation and the ECC hybrid payload envelope
 * used by the ECDH encode/decode helpers.
 */

import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { type CurveAsymmetricKey, curveName } from "../common/enums.ts";
import { EncryptError } from "../errors.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Converts an operation failure to the encrypt module's released error type. */
function normalizeEncryptError(cause: unknown): EncryptError {
  if (cause instanceof EncryptError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new EncryptError(message, { cause });
}

/** Runs an operation while normalizing both synchronous and asynchronous failures. */
function runEncryptOperation<T>(op: () => Promise<T>): Promise<T> {
  try {
    return op().catch((cause) => {
      throw normalizeEncryptError(cause);
    });
  } catch (cause) {
    return Promise.reject(normalizeEncryptError(cause));
  }
}

/** UTF-8 encode a string to bytes (ArrayBuffer-backed, Web Crypto friendly). */
export function bytesOf(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(encoder.encode(text));
}

/** UTF-8 decode bytes to a string. */
export function textOf(bytes: Uint8Array | ArrayBuffer): string {
  return decoder.decode(bytes);
}

/** Base64-encode raw bytes. */
export function toBase64(bytes: Uint8Array | ArrayBuffer): string {
  return encodeBase64(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
}

/**
 * Decode a Base64 string into bytes. The result is copied into a fresh
 * `ArrayBuffer`-backed array so it satisfies Web Crypto's `BufferSource`.
 */
export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(decodeBase64(value));
}

/**
 * Rejects immediately if the signal is already aborted, then runs `op` and
 * rejects if the signal aborts first. Web Crypto operations are not natively
 * cancelable, so this races completion against the abort event — the
 * underlying work may still finish in the background.
 */
export function runWithSignal<T>(
  signal: AbortSignal | undefined,
  op: () => Promise<T>,
): Promise<T> {
  if (!signal) return runEncryptOperation(op);
  if (signal.aborted) {
    return Promise.reject(
      normalizeEncryptError(signal.reason ?? new EncryptError("operation aborted")),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(normalizeEncryptError(signal.reason ?? new EncryptError("operation aborted")));
    signal.addEventListener("abort", onAbort, { once: true });
    runEncryptOperation(op).then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", onAbort)
    );
  });
}

/** Maps a {@link CurveAsymmetricKey} to a Web Crypto `namedCurve` string. */
export function resolveECDHCurve(curve: CurveAsymmetricKey): string {
  const name = curveName(curve);
  if (name === "unknown") {
    throw new EncryptError(`unsupported ECDH curve: ${curve}`);
  }
  return name;
}

/** True when the Base64 value decodes to a usable 16- or 32-byte AES key. */
export function isLocalAESKey(secretKey: string): boolean {
  try {
    const raw = fromBase64(secretKey);
    return raw.length === 16 || raw.length === 32;
  } catch {
    return false;
  }
}

// --- Key import helpers -----------------------------------------------------

/** Import a Base64 SPKI RSA public key for the given algorithm/usages. */
export function importRSAPublicKey(
  publicKey: string,
  algorithm: RsaHashedImportParams,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", fromBase64(publicKey), algorithm, false, usages);
}

/** Import a Base64 PKCS#8 RSA private key for the given algorithm/usages. */
export function importRSAPrivateKey(
  privateKey: string,
  algorithm: RsaHashedImportParams,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", fromBase64(privateKey), algorithm, false, usages);
}

/** Import a Base64 SPKI ECDH public key on the given curve. */
export function importECDHPublicKey(publicKey: string, namedCurve: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    fromBase64(publicKey),
    { name: "ECDH", namedCurve },
    false,
    [],
  );
}

/** Import a Base64 PKCS#8 ECDH private key on the given curve. */
export function importECDHPrivateKey(privateKey: string, namedCurve: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    fromBase64(privateKey),
    { name: "ECDH", namedCurve },
    false,
    ["deriveBits"],
  );
}

/**
 * Derives a 256-bit AES-GCM key from an ECDH shared secret using HKDF-SHA256,
 * mixing in a curve-specific prefix for domain separation. Equivalent to the Go
 * `DeriveECCAESKey` helper.
 */
export async function deriveECCAESKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  namedCurve: string,
): Promise<CryptoKey> {
  const bitLengths: Record<string, number> = { "P-256": 256, "P-384": 384, "P-521": 528 };
  const length = bitLengths[namedCurve];
  if (!length) throw new EncryptError(`unsupported ECDH curve: ${namedCurve}`);

  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    length,
  );
  const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: bytesOf(`denoforge/ecdh/${namedCurve}`),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// --- ECC hybrid cipher envelope --------------------------------------------

/**
 * Serialized envelope produced by `ECDH_Encode`. Mirrors the Go
 * `ECCCipherPayload` struct: it carries the ephemeral public key, the curve
 * name and the AES-GCM nonce + ciphertext so the recipient can reconstruct the
 * shared secret and decrypt.
 */
export interface ECCCipherPayload {
  /** Web Crypto named curve used by the ephemeral key. */
  curve: string;
  /** Base64 SPKI ephemeral public key. */
  ephemeralPublicKey: string;
  /** Base64 AES-GCM nonce. */
  nonce: string;
  /** Base64 AES-GCM ciphertext and authentication tag. */
  cipherText: string;
}

/** Encodes an {@link ECCCipherPayload} as a Base64 JSON string. */
export function encodeECCCipherPayload(payload: ECCCipherPayload): string {
  return toBase64(bytesOf(JSON.stringify(payload)));
}

/** Decodes and validates a Base64 JSON {@link ECCCipherPayload}. */
export function decodeECCCipherPayload(encoded: string): ECCCipherPayload {
  let parsed: ECCCipherPayload;
  try {
    parsed = JSON.parse(textOf(fromBase64(encoded))) as ECCCipherPayload;
  } catch (cause) {
    throw new EncryptError("invalid ECC cipher payload", { cause });
  }
  for (const field of ["curve", "ephemeralPublicKey", "nonce", "cipherText"] as const) {
    if (!parsed[field]) throw new EncryptError(`ECC cipher payload missing field: ${field}`);
  }
  return parsed;
}
