// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Repository interfaces for the local provider.
 *
 * Several small, focused interfaces compose the crypto contract. The
 * cancellation context is folded into each request object as an optional
 * `signal` (see {@link BaseRequest}).
 */

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

/** Symmetric encryption helpers (mirrors `SymmetricRepository`). */
export interface SymmetricRepository {
  /** Returns a random Base64-encoded symmetric key. */
  generateSymmetricKeys(input: GenerateSymmetricKeyRequest): Promise<KeyData>;
  /** Encrypts plaintext with AES-GCM using a Base64 key and optional AAD. */
  encryptAES(input: EncryptAESRequest): Promise<string>;
  /** Decrypts Base64 ciphertext produced by {@link encryptAES}. */
  decryptAES(input: DecryptAESRequest): Promise<string>;
}

/** RSA + ECDH helpers (mirrors `AsymmetricRepository`). */
export interface AsymmetricRepository {
  /** Creates an RSA key pair and returns the encoded material + metadata. */
  generateRSAKeys(input: GenerateRSAKeyRequest): Promise<KeyData>;
  /** Creates an ECC key pair on the requested curve. */
  generateECDHCurveKeys(input: GenerateECDHCurveKeyRequest): Promise<KeyData>;
  /** Encrypts plaintext with a Base64 RSA public key (RSA-OAEP). */
  rsaOaepEncode(input: RSAOAEPEncodeRequest): Promise<string>;
  /** Decrypts Base64 ciphertext with a Base64 RSA private key (RSA-OAEP). */
  rsaOaepDecode(input: RSAOAEPDecodeRequest): Promise<string>;
  /** Encrypts plaintext for an ECC public key via ECDH-derived AES-GCM. */
  ecdhEncode(input: ECDHEncodeRequest): Promise<string>;
  /** Decrypts a payload produced by {@link ecdhEncode}. */
  ecdhDecode(input: ECDHDecodeRequest): Promise<string>;
}

/** Provider key-management helpers (mirrors `KeyRepository`). */
export interface KeyRepository {
  /** Creates a new key version/material by key id. */
  rotateKey(input: RotateKeyRequest): Promise<KeyData>;
  /** Returns provider metadata and public material for a key id. */
  getKey(input: GetKeyRequest): Promise<KeyData>;
  /** Disables a provider-backed key by key id. */
  deactivateKey(input: DeactivateKeyRequest): Promise<void>;
}

/** Hashing and MAC helpers (mirrors `HashRepository`). */
export interface HashRepository {
  /** Base64-encoded HMAC-SHA256 signature. */
  hmac(secretKey: string, message: string, signal?: AbortSignal): Promise<string>;
  /** SHA-256 digest as a hexadecimal string. */
  sha256Hex(message: string, signal?: AbortSignal): Promise<string>;
  /** BLAKE3 digest encoded as Base64. */
  blake3(message: string, signal?: AbortSignal): Promise<string>;
}

/** Asymmetric signing/verification helpers (mirrors `SignatureRepository`). */
export interface SignatureRepository {
  /** Creates an Ed25519 key pair. */
  generateEd25519Keys(signal?: AbortSignal): Promise<KeyData>;
  /** Signs text with a Base64 Ed25519 private key; returns Base64 signature. */
  signEd25519(privateKey: string, text: string, signal?: AbortSignal): Promise<string>;
  /** Verifies an Ed25519 Base64 signature; rejects on failure. */
  verifyEd25519(
    publicKey: string,
    text: string,
    signature: string,
    signal?: AbortSignal,
  ): Promise<void>;

  /** Signs text with RSA-PSS using a Base64 private key; returns Base64. */
  signRSAPSS(privateKey: string, text: string, signal?: AbortSignal): Promise<string>;
  /** Verifies an RSA-PSS Base64 signature; rejects on failure. */
  verifyRSAPSS(
    publicKey: string,
    text: string,
    signature: string,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Signs data with RSA PKCS#1 v1.5 + SHA-256. */
  signRSAPKCS1v15SHA256(privateKey: string, data: string, signal?: AbortSignal): Promise<string>;
  /** Verifies an RSA PKCS#1 v1.5 SHA-256 signature; rejects on failure. */
  verifyRSAPKCS1v15SHA256(
    data: string,
    publicKey: string,
    signature: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

/** Aggregate of every local repository. */
export interface LocalRepository
  extends
    SymmetricRepository,
    AsymmetricRepository,
    KeyRepository,
    HashRepository,
    SignatureRepository {}
