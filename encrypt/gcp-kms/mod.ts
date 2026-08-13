// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `encrypt/gcp-kms` — Google Cloud KMS-backed cryptography.
 *
 * Requires `@google-cloud/kms` (loaded lazily) and application-default
 * credentials resolvable by the SDK. Inject a fake {@link KmsApi} to unit-test
 * without GCP.
 *
 * @module
 */

export * from "./interface.ts";
export { createRealApi, GcpKmsProvider, newGcpKmsProvider } from "./repository.ts";
export {
  /** Provider-backed cryptography and key-lifecycle contract used by Google Cloud KMS. */
  type CloudKmsRepository,
  /** Injectable byte-oriented boundary for Google Cloud KMS operations. */
  type KmsApi,
  /** Normalized metadata returned for a Google Cloud KMS key. */
  type KmsKeyDescription,
  /** Shared cloud-KMS repository behavior extended by the Google Cloud provider. */
  KmsRepositoryBase,
} from "../common/kms.ts";
export type {
  /** Common tracing and cancellation fields for Google Cloud KMS requests. */
  BaseRequest,
  /** Request to disable a Google Cloud KMS key. */
  DeactivateKeyRequest,
  /** Request to retrieve metadata for a Google Cloud KMS key. */
  GetKeyRequest,
  /** Normalized provider key metadata and encoded public material. */
  KeyData,
  /** Request to decrypt Base64 ciphertext with Google Cloud KMS. */
  KmsDecryptRequest,
  /** Request to encrypt plaintext with Google Cloud KMS. */
  KmsEncryptRequest,
  /** Request to sign a message with Google Cloud KMS. */
  KmsSignRequest,
  /** Request to verify a signature with Google Cloud KMS. */
  KmsVerifyRequest,
  /** Request to rotate Google Cloud KMS-managed key material. */
  RotateKeyRequest,
} from "../common/kms.ts";
