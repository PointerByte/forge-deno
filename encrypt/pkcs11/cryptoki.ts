// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cryptoki constants and attribute encoding.
 *
 * forge-go keeps these unexported because its fake token lives inside the
 * package. Here the token seam ({@link Pkcs11Module}) is public so callers can
 * inject their own implementation — the same choice the cloud backends make
 * with `KmsApi` — which means the `CKM_`/`CKA_`/`CKK_` values that seam speaks
 * in have to be public too.
 *
 * @module
 */

/** PKCS#11 `CKM_` mechanism types the provider can request. */
export const Mechanism = {
  /** `CKM_RSA_PKCS_KEY_PAIR_GEN`. */
  RsaPkcsKeyPairGen: 0x00000000,
  /** `CKM_RSA_PKCS`, a degradation target for PKCS#1 v1.5 signing. */
  RsaPkcs: 0x00000001,
  /** `CKM_RSA_PKCS_OAEP`. */
  RsaPkcsOaep: 0x00000009,
  /** `CKM_RSA_PKCS_PSS`, a degradation target for PSS signing. */
  RsaPkcsPss: 0x0000000d,
  /** `CKM_SHA256_RSA_PKCS`. */
  Sha256RsaPkcs: 0x00000040,
  /** `CKM_SHA256_RSA_PKCS_PSS`. */
  Sha256RsaPkcsPss: 0x00000043,
  /** `CKM_SHA256`. */
  Sha256: 0x00000250,
  /** `CKM_SHA256_HMAC`. */
  Sha256Hmac: 0x00000251,
  /** `CKM_GENERIC_SECRET_KEY_GEN`. */
  GenericSecretKeyGen: 0x00000350,
  /** `CKM_EC_KEY_PAIR_GEN`. */
  EcKeyPairGen: 0x00001040,
  /** `CKM_ECDH1_DERIVE`. */
  Ecdh1Derive: 0x00001050,
  /** `CKM_EC_EDWARDS_KEY_PAIR_GEN`. */
  EcEdwardsKeyPairGen: 0x00001055,
  /** `CKM_EDDSA`. */
  EdDsa: 0x00001057,
  /** `CKM_AES_KEY_GEN`. */
  AesKeyGen: 0x00001080,
  /** `CKM_AES_GCM`. */
  AesGcm: 0x00001087,
  /** `CKM_HKDF_DERIVE`. */
  HkdfDerive: 0x0000402a,
} as const;
/** Union of the `CKM_` values this provider names. */
export type Mechanism = (typeof Mechanism)[keyof typeof Mechanism];

const MECHANISM_NAMES = new Map<number, string>([
  [Mechanism.RsaPkcsKeyPairGen, "CKM_RSA_PKCS_KEY_PAIR_GEN"],
  [Mechanism.RsaPkcs, "CKM_RSA_PKCS"],
  [Mechanism.RsaPkcsOaep, "CKM_RSA_PKCS_OAEP"],
  [Mechanism.RsaPkcsPss, "CKM_RSA_PKCS_PSS"],
  [Mechanism.Sha256RsaPkcs, "CKM_SHA256_RSA_PKCS"],
  [Mechanism.Sha256RsaPkcsPss, "CKM_SHA256_RSA_PKCS_PSS"],
  [Mechanism.Sha256, "CKM_SHA256"],
  [Mechanism.Sha256Hmac, "CKM_SHA256_HMAC"],
  [Mechanism.GenericSecretKeyGen, "CKM_GENERIC_SECRET_KEY_GEN"],
  [Mechanism.EcKeyPairGen, "CKM_EC_KEY_PAIR_GEN"],
  [Mechanism.Ecdh1Derive, "CKM_ECDH1_DERIVE"],
  [Mechanism.EcEdwardsKeyPairGen, "CKM_EC_EDWARDS_KEY_PAIR_GEN"],
  [Mechanism.EdDsa, "CKM_EDDSA"],
  [Mechanism.AesKeyGen, "CKM_AES_KEY_GEN"],
  [Mechanism.AesGcm, "CKM_AES_GCM"],
  [Mechanism.HkdfDerive, "CKM_HKDF_DERIVE"],
]);

/**
 * Returns the canonical `CKM_` name, falling back to the numeric code for
 * mechanisms this provider does not name.
 */
export function mechanismName(value: number): string {
  return MECHANISM_NAMES.get(value) ??
    `CKM_0x${value.toString(16).toUpperCase().padStart(8, "0")}`;
}

/** PKCS#11 `CKA_` attribute types the provider reads or writes. */
export const AttributeType = {
  /** `CKA_CLASS`. */
  Class: 0x00000000,
  /** `CKA_TOKEN`. */
  Token: 0x00000001,
  /** `CKA_PRIVATE`. */
  Private: 0x00000002,
  /** `CKA_LABEL`. */
  Label: 0x00000003,
  /** `CKA_VALUE`. */
  Value: 0x00000011,
  /** `CKA_KEY_TYPE`. */
  KeyType: 0x00000100,
  /** `CKA_ID`. */
  Id: 0x00000102,
  /** `CKA_SENSITIVE`. */
  Sensitive: 0x00000103,
  /** `CKA_ENCRYPT`. */
  Encrypt: 0x00000104,
  /** `CKA_DECRYPT`. */
  Decrypt: 0x00000105,
  /** `CKA_WRAP`. */
  Wrap: 0x00000106,
  /** `CKA_UNWRAP`. */
  Unwrap: 0x00000107,
  /** `CKA_SIGN`. */
  Sign: 0x00000108,
  /** `CKA_VERIFY`. */
  Verify: 0x0000010a,
  /** `CKA_DERIVE`. */
  Derive: 0x0000010c,
  /** `CKA_MODULUS`. */
  Modulus: 0x00000120,
  /** `CKA_MODULUS_BITS`. */
  ModulusBits: 0x00000121,
  /** `CKA_PUBLIC_EXPONENT`. */
  PublicExponent: 0x00000122,
  /** `CKA_PRIVATE_EXPONENT`; only ever read to prove it is unreadable. */
  PrivateExponent: 0x00000123,
  /** `CKA_VALUE_LEN`. */
  ValueLen: 0x00000161,
  /** `CKA_EXTRACTABLE`. */
  Extractable: 0x00000162,
  /** `CKA_EC_PARAMS`. */
  EcParams: 0x00000180,
  /** `CKA_EC_POINT`. */
  EcPoint: 0x00000181,
} as const;
/** Union of the `CKA_` values this provider names. */
export type AttributeType = (typeof AttributeType)[keyof typeof AttributeType];

/** PKCS#11 `CKK_` key types. */
export const KeyType = {
  /** `CKK_RSA`. */
  Rsa: 0x00000000,
  /** `CKK_EC`. */
  Ec: 0x00000003,
  /** `CKK_GENERIC_SECRET`. */
  GenericSecret: 0x00000010,
  /** `CKK_AES`. */
  Aes: 0x0000001f,
  /** `CKK_EC_EDWARDS`. */
  EcEdwards: 0x00000040,
} as const;
/** Union of the `CKK_` values this provider names. */
export type KeyType = (typeof KeyType)[keyof typeof KeyType];

/** `CKG_MGF1_SHA256`, the only mask generation function this provider uses. */
export const CKG_MGF1_SHA256 = 0x00000002;

/**
 * `CKZ_DATA_SPECIFIED`, the only defined OAEP source type. It is required even
 * when no label is supplied; leaving the field zero makes strict tokens reject
 * `C_DecryptInit` with `CKR_ARGUMENTS_BAD`.
 */
export const CKZ_DATA_SPECIFIED = 0x00000001;

/**
 * `CKD_NULL`. The provider runs HKDF as a separate derive step because the
 * KDFs `CKM_ECDH1_DERIVE` offers are ANSI X9.63, not HKDF, and could not
 * reproduce the key the local provider derives.
 */
export const CKD_NULL = 0x00000001;

/**
 * `CKF_HKDF_SALT_NULL`. A null salt means a salt of HashLen zero bytes, which
 * is exactly RFC 5869 with a nil salt.
 */
export const CKF_HKDF_SALT_NULL = 0x00000001;

/** AES-GCM IV length, shared with the local provider's wire format. */
export const GCM_NONCE_BYTES = 12;

/** AES-GCM authentication tag length in bits. */
export const GCM_TAG_BITS = 128;

/**
 * The constant ASN.1 `DigestInfo` header for SHA-256, as used by
 * RSASSA-PKCS1-v1_5. Prepending it to a digest yields exactly what
 * `CKM_RSA_PKCS` expects, which lets a token that only implements the raw
 * mechanism still produce a signature identical to `CKM_SHA256_RSA_PKCS`.
 */
export const SHA256_DIGEST_INFO_PREFIX: Uint8Array = Uint8Array.from([
  0x30,
  0x31,
  0x30,
  0x0d,
  0x06,
  0x09,
  0x60,
  0x86,
  0x48,
  0x01,
  0x65,
  0x03,
  0x04,
  0x02,
  0x01,
  0x05,
  0x00,
  0x04,
  0x20,
]);

/** DER-encoded named curve OIDs, as stored in `CKA_EC_PARAMS`. */
export const EC_PARAMS: Readonly<Record<string, Uint8Array>> = {
  /** `1.2.840.10045.3.1.7` (NIST P-256). */
  "P-256": Uint8Array.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]),
  /** `1.3.132.0.34` (NIST P-384). */
  "P-384": Uint8Array.from([0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x22]),
  /** `1.3.132.0.35` (NIST P-521). */
  "P-521": Uint8Array.from([0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x23]),
  /** `1.3.101.112` (Ed25519). */
  "Ed25519": Uint8Array.from([0x06, 0x03, 0x2b, 0x65, 0x70]),
};

/** One `CKA_` type/value pair. */
export interface Attribute {
  /** The `CKA_` type. */
  type: number;
  /**
   * Raw bytes in the encoding PKCS#11 expects: little-endian `CK_ULONG` for
   * numbers, a single byte for `CK_BBOOL`, DER for `CKA_EC_PARAMS`.
   */
  value: Uint8Array;
  /**
   * Whether the object actually carries this attribute.
   *
   * Only meaningful on values returned by {@link Pkcs11Module.getAttributes},
   * where a missing attribute comes back with `present: false` instead of
   * failing the whole call. Sending an attribute an object does not have makes
   * `C_SetAttributeValue` reject the entire template with
   * `CKR_ATTRIBUTE_TYPE_INVALID`, so `deactivateKey` probes before it writes.
   */
  present: boolean;
}

/** Builds a `CK_BBOOL` attribute. */
export function boolAttribute(type: number, value: boolean): Attribute {
  return { type, value: Uint8Array.from([value ? 1 : 0]), present: true };
}

/** Builds a little-endian `CK_ULONG` attribute. */
export function ulongAttribute(type: number, value: number | bigint): Attribute {
  const encoded = new Uint8Array(8);
  new DataView(encoded.buffer).setBigUint64(0, BigInt(value), true);
  return { type, value: encoded, present: true };
}

/** Builds an attribute from raw bytes. */
export function bytesAttribute(type: number, value: Uint8Array): Attribute {
  return { type, value, present: true };
}

/** Builds an attribute from a UTF-8 string, for `CKA_LABEL`. */
export function textAttribute(type: number, value: string): Attribute {
  return { type, value: new TextEncoder().encode(value), present: true };
}

/** Decodes a `CK_ULONG` attribute value, or undefined when it is malformed. */
export function ulongValue(value: Uint8Array): number | undefined {
  if (value.length !== 8) return undefined;
  const decoded = new DataView(value.buffer, value.byteOffset, 8).getBigUint64(0, true);
  return Number(decoded);
}

/** Decodes a `CK_BBOOL` attribute value, or undefined when it is malformed. */
export function boolValue(value: Uint8Array): boolean | undefined {
  if (value.length !== 1) return undefined;
  return value[0] !== 0;
}

/** Returns the value of `type` within `attributes`, when the object carries it. */
export function findAttribute(attributes: Attribute[], type: number): Uint8Array | undefined {
  return attributes.find((candidate) => candidate.type === type && candidate.present)?.value;
}

/**
 * Reports whether the object carries `type` at all, regardless of its value.
 * `deactivateKey` uses it to build a template the token will accept.
 */
export function hasAttribute(attributes: Attribute[], type: number): boolean {
  return findAttribute(attributes, type) !== undefined;
}

const CKR_NAMES = new Map<number, string>([
  [0x00000001, "CKR_CANCEL"],
  [0x00000002, "CKR_HOST_MEMORY"],
  [0x00000003, "CKR_SLOT_ID_INVALID"],
  [0x00000005, "CKR_GENERAL_ERROR"],
  [0x00000006, "CKR_FUNCTION_FAILED"],
  [0x00000007, "CKR_ARGUMENTS_BAD"],
  [0x00000010, "CKR_ATTRIBUTE_READ_ONLY"],
  [0x00000011, "CKR_ATTRIBUTE_SENSITIVE"],
  [0x00000012, "CKR_ATTRIBUTE_TYPE_INVALID"],
  [0x00000013, "CKR_ATTRIBUTE_VALUE_INVALID"],
  [0x00000020, "CKR_DATA_INVALID"],
  [0x00000021, "CKR_DATA_LEN_RANGE"],
  [0x00000030, "CKR_DEVICE_ERROR"],
  [0x00000031, "CKR_DEVICE_MEMORY"],
  [0x00000032, "CKR_DEVICE_REMOVED"],
  [0x00000040, "CKR_ENCRYPTED_DATA_INVALID"],
  [0x00000041, "CKR_ENCRYPTED_DATA_LEN_RANGE"],
  [0x00000060, "CKR_KEY_HANDLE_INVALID"],
  [0x00000062, "CKR_KEY_SIZE_RANGE"],
  [0x00000063, "CKR_KEY_TYPE_INCONSISTENT"],
  [0x00000068, "CKR_KEY_FUNCTION_NOT_PERMITTED"],
  [0x00000069, "CKR_KEY_NOT_WRAPPABLE"],
  [0x0000006a, "CKR_KEY_UNEXTRACTABLE"],
  [0x00000070, "CKR_MECHANISM_INVALID"],
  [0x00000071, "CKR_MECHANISM_PARAM_INVALID"],
  [0x00000082, "CKR_OBJECT_HANDLE_INVALID"],
  [0x00000090, "CKR_OPERATION_ACTIVE"],
  [0x00000091, "CKR_OPERATION_NOT_INITIALIZED"],
  [0x000000a0, "CKR_PIN_INCORRECT"],
  [0x000000a1, "CKR_PIN_INVALID"],
  [0x000000a2, "CKR_PIN_LEN_RANGE"],
  [0x000000a3, "CKR_PIN_EXPIRED"],
  [0x000000a4, "CKR_PIN_LOCKED"],
  [0x000000b0, "CKR_SESSION_CLOSED"],
  [0x000000b1, "CKR_SESSION_COUNT"],
  [0x000000b3, "CKR_SESSION_HANDLE_INVALID"],
  [0x000000b5, "CKR_SESSION_READ_ONLY"],
  [0x000000c0, "CKR_SIGNATURE_INVALID"],
  [0x000000c1, "CKR_SIGNATURE_LEN_RANGE"],
  [0x000000d0, "CKR_TEMPLATE_INCOMPLETE"],
  [0x000000d1, "CKR_TEMPLATE_INCONSISTENT"],
  [0x000000e0, "CKR_TOKEN_NOT_PRESENT"],
  [0x000000e1, "CKR_TOKEN_NOT_RECOGNIZED"],
  [0x000000e2, "CKR_TOKEN_WRITE_PROTECTED"],
  [0x00000100, "CKR_USER_ALREADY_LOGGED_IN"],
  [0x00000101, "CKR_USER_NOT_LOGGED_IN"],
  [0x00000102, "CKR_USER_PIN_NOT_INITIALIZED"],
  [0x00000103, "CKR_USER_TYPE_INVALID"],
  [0x00000150, "CKR_BUFFER_TOO_SMALL"],
  [0x00000190, "CKR_CRYPTOKI_NOT_INITIALIZED"],
  [0x00000191, "CKR_CRYPTOKI_ALREADY_INITIALIZED"],
]);

/** The `CK_RV` values the provider acts on by name. */
export const ReturnValue = {
  /** `CKR_OK`. */
  Ok: 0x00000000,
  /** `CKR_ATTRIBUTE_SENSITIVE`. */
  AttributeSensitive: 0x00000011,
  /** `CKR_ATTRIBUTE_TYPE_INVALID`. */
  AttributeTypeInvalid: 0x00000012,
  /** `CKR_ARGUMENTS_BAD`. */
  ArgumentsBad: 0x00000007,
  /** `CKR_BUFFER_TOO_SMALL`. */
  BufferTooSmall: 0x00000150,
  /** `CKR_CRYPTOKI_ALREADY_INITIALIZED`. */
  CryptokiAlreadyInitialized: 0x00000191,
  /** `CKR_DEVICE_REMOVED`. */
  DeviceRemoved: 0x00000032,
  /** `CKR_KEY_HANDLE_INVALID`. */
  KeyHandleInvalid: 0x00000060,
  /** `CKR_KEY_UNEXTRACTABLE`. */
  KeyUnextractable: 0x0000006a,
  /** `CKR_MECHANISM_INVALID`. */
  MechanismInvalid: 0x00000070,
  /** `CKR_MECHANISM_PARAM_INVALID`. */
  MechanismParamInvalid: 0x00000071,
  /** `CKR_SESSION_CLOSED`. */
  SessionClosed: 0x000000b0,
  /** `CKR_SESSION_HANDLE_INVALID`. */
  SessionHandleInvalid: 0x000000b3,
  /** `CKR_SIGNATURE_INVALID`. */
  SignatureInvalid: 0x000000c0,
  /** `CKR_USER_ALREADY_LOGGED_IN`. */
  UserAlreadyLoggedIn: 0x00000100,
  /** `CKR_USER_NOT_LOGGED_IN`. */
  UserNotLoggedIn: 0x00000101,
} as const;
/** Union of the `CK_RV` values this provider names. */
export type ReturnValue = (typeof ReturnValue)[keyof typeof ReturnValue];

/** Returns the canonical `CKR_` name, or a numeric rendering when unnamed. */
export function returnValueName(code: number): string {
  return CKR_NAMES.get(code) ?? `CKR_0x${code.toString(16).toUpperCase().padStart(8, "0")}`;
}
