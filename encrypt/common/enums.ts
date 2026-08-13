// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cryptographic enums shared across the encrypt sub-packages.
 *
 * Modeled as `const` objects plus a union type, keeping canonical integer
 * values and descriptive names.
 */

/** Supported symmetric key sizes, expressed in bytes (mirrors `SizeSymetrycKey`). */
export const SizeSymmetricKey = {
  /** 128-bit symmetric key. */
  Key128Bits: 16,
  /** 256-bit symmetric key. */
  Key256Bits: 32,
} as const;
/** Union of supported symmetric key sizes in bytes. */
export type SizeSymmetricKey = (typeof SizeSymmetricKey)[keyof typeof SizeSymmetricKey];

/** Supported asymmetric key sizes, expressed in bits (mirrors `SizeAsymetrycKey`). */
export const SizeAsymmetricKey = {
  /** 2048-bit asymmetric key. */
  Key2048Bits: 2048,
  /** 3072-bit asymmetric key. */
  Key3072Bits: 3072,
  /** 4096-bit asymmetric key. */
  Key4096Bits: 4096,
} as const;
/** Union of supported RSA key sizes in bits. */
export type SizeAsymmetricKey = (typeof SizeAsymmetricKey)[keyof typeof SizeAsymmetricKey];

/** Supported elliptic curves for ECC encryption (mirrors `CurveAsymmetricKey`). */
export const CurveAsymmetricKey = {
  /** NIST P-256 curve. */
  CurveP256: 256,
  /** NIST P-384 curve. */
  CurveP384: 384,
  /** NIST P-521 curve. */
  CurveP521: 521,
} as const;
/** Union of supported elliptic curve identifiers. */
export type CurveAsymmetricKey = (typeof CurveAsymmetricKey)[keyof typeof CurveAsymmetricKey];

/**
 * Returns the canonical serialized name of the curve (mirrors the Go
 * `CurveAsymmetricKey.String()` method).
 */
export function curveName(curve: CurveAsymmetricKey): string {
  switch (curve) {
    case CurveAsymmetricKey.CurveP256:
      return "P-256";
    case CurveAsymmetricKey.CurveP384:
      return "P-384";
    case CurveAsymmetricKey.CurveP521:
      return "P-521";
    default:
      return "unknown";
  }
}
