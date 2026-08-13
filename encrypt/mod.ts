// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `encrypt` — modular cryptographic helpers backed by the Web Crypto API.
 *
 * The local provider is the provider shipped here; the key-management surface
 * ({@link KeyRepository}) is part of the contract but is provider-backed, so the
 * local provider throws `UnsupportedOperationError`. Implement `KeyRepository`
 * to plug in a cloud KMS.
 *
 * @example
 * ```ts
 * import { newLocalProvider, SizeSymmetricKey } from "@pointerbyte/denoforge/encrypt";
 *
 * const enc = newLocalProvider();
 * const key = await enc.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });
 * const ct = await enc.encryptAES({ secretKey: key.keyRef, value: "hello" });
 * const pt = await enc.decryptAES({ secretKey: key.keyRef, cipherValue: ct });
 * ```
 *
 * @module
 */

export * from "./common/enums.ts";
export * from "./models/models.ts";
export * from "./errors.ts";
export * from "./local/mod.ts";
// Shared cloud-KMS contract. The concrete providers (aws-kms, azure-key-vault,
// gcp-kms) live behind their own import specifiers so their cloud SDKs stay
// optional and are never pulled into the core graph.
export {
  type CloudKmsRepository,
  type KmsApi,
  type KmsDecryptRequest,
  type KmsEncryptRequest,
  type KmsKeyDescription,
  KmsRepositoryBase,
  type KmsSignRequest,
  type KmsVerifyRequest,
} from "./common/kms.ts";
export {
  decodeECCCipherPayload,
  type ECCCipherPayload,
  encodeECCCipherPayload,
  isLocalAESKey,
} from "./utilities/utilities.ts";
