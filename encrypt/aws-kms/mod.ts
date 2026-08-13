// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `encrypt/aws-kms` — AWS KMS-backed cryptography.
 *
 * Requires the `@aws-sdk/client-kms` package (loaded lazily on first use) and
 * AWS credentials resolvable by the SDK. Inject a fake {@link KmsApi} to
 * unit-test without AWS.
 *
 * @module
 */

export * from "./interface.ts";
export { AwsKmsProvider, createRealApi, newAwsKmsProvider } from "./repository.ts";
export {
  /** Provider-backed cryptography and key-lifecycle contract used by AWS KMS. */
  type CloudKmsRepository,
  /** Injectable byte-oriented boundary for AWS KMS operations. */
  type KmsApi,
  /** Normalized metadata returned for an AWS KMS key. */
  type KmsKeyDescription,
  /** Shared cloud-KMS repository behavior extended by the AWS provider. */
  KmsRepositoryBase,
} from "../common/kms.ts";
export type {
  /** Common tracing and cancellation fields for AWS KMS requests. */
  BaseRequest,
  /** Request to disable an AWS KMS key. */
  DeactivateKeyRequest,
  /** Request to retrieve metadata for an AWS KMS key. */
  GetKeyRequest,
  /** Normalized provider key metadata and encoded public material. */
  KeyData,
  /** Request to decrypt Base64 ciphertext with AWS KMS. */
  KmsDecryptRequest,
  /** Request to encrypt plaintext with AWS KMS. */
  KmsEncryptRequest,
  /** Request to sign a message with AWS KMS. */
  KmsSignRequest,
  /** Request to verify a signature with AWS KMS. */
  KmsVerifyRequest,
  /** Request to rotate AWS KMS-managed key material. */
  RotateKeyRequest,
} from "../common/kms.ts";
