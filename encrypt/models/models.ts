// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Request/response models for the encrypt module.
 *
 * Each model is a TypeScript interface with camelCased field names. The
 * cancellation context that every repository method takes is represented as an
 * optional {@link AbortSignal} on each request (`signal`) so callers can cancel
 * long-running operations.
 */

import type { CurveAsymmetricKey, SizeAsymmetricKey, SizeSymmetricKey } from "../common/enums.ts";

/** Common fields shared by every request: a trace UID and a cancellation signal. */
export interface BaseRequest {
  /** Operator-supplied correlation id. Optional. */
  uid?: string;
  /** Cancellation signal for the operation. */
  signal?: AbortSignal;
}

/** Provider metadata and encoded key material returned by key operations. */
export interface KeyData {
  /** Base64-encoded SPKI public key, when applicable. */
  publicKey: string;
  /** Provider-assigned key id. */
  keyId: string;
  /**
   * Encoded reference to the key material. For the local provider this holds the
   * Base64-encoded PKCS#8 private key (or the raw symmetric key).
   */
  keyRef: string;
  /** Provider name, e.g. `"local"`. */
  provider: string;
}

/** Request to rotate an existing provider-managed key. */
export interface RotateKeyRequest extends BaseRequest {
  /** Provider-specific key identifier. */
  keyId: string;
}

/** Request to fetch metadata for an existing provider-managed key. */
export interface GetKeyRequest extends BaseRequest {
  /** Provider-specific key identifier. */
  keyId: string;
}

/** Request to deactivate or disable an existing provider-managed key. */
export interface DeactivateKeyRequest extends BaseRequest {
  /** Provider-specific key identifier. */
  keyId: string;
}

/** Request to create a new symmetric key. */
export interface GenerateSymmetricKeyRequest extends BaseRequest {
  /** Desired symmetric key size. */
  size: SizeSymmetricKey;
}

/** Request to encrypt plaintext with AES-GCM. */
export interface EncryptAESRequest extends BaseRequest {
  /** Base64-encoded AES key. */
  secretKey: string;
  /** Plaintext to encrypt. */
  value: string;
  /** Optional additional authenticated data (AAD). */
  additional?: string;
}

/** Request to decrypt an AES-GCM ciphertext. */
export interface DecryptAESRequest extends BaseRequest {
  /** Base64-encoded AES key. */
  secretKey: string;
  /** Base64 ciphertext produced by `encryptAES`. */
  cipherValue: string;
  /** Optional additional authenticated data (AAD); must match encryption. */
  additional?: string;
}

/** Request to generate an RSA key pair. */
export interface GenerateRSAKeyRequest extends BaseRequest {
  /** Desired RSA modulus size in bits. */
  size: SizeAsymmetricKey;
}

/** Request to generate an ECDH key pair on a supported curve. */
export interface GenerateECDHCurveKeyRequest extends BaseRequest {
  /** Elliptic curve to use for the key pair. */
  curve: CurveAsymmetricKey;
}

/** Request to encrypt plaintext with RSA-OAEP. */
export interface RSAOAEPEncodeRequest extends BaseRequest {
  /** Base64-encoded SPKI RSA public key. */
  publicKey: string;
  /** Plaintext to encrypt. */
  text: string;
}

/** Request to decrypt RSA-OAEP ciphertext. */
export interface RSAOAEPDecodeRequest extends BaseRequest {
  /** Base64-encoded PKCS#8 RSA private key. */
  privateKey: string;
  /** Base64 ciphertext produced by RSA-OAEP encryption. */
  cipherText: string;
}

/** Request to encrypt plaintext using an ECDH-derived shared secret. */
export interface ECDHEncodeRequest extends BaseRequest {
  /** Base64-encoded SPKI ECC public key. */
  publicKey: string;
  /** Plaintext to encrypt. */
  text: string;
}

/** Request to decrypt an ECDH hybrid ciphertext. */
export interface ECDHDecodeRequest extends BaseRequest {
  /** Base64-encoded PKCS#8 ECC private key. */
  privateKey: string;
  /** Encoded ciphertext payload produced by ECDH encryption. */
  cipherText: string;
}
