// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `encrypt/azure-key-vault` — Azure Key Vault-backed cryptography.
 *
 * Requires `@azure/keyvault-keys` (loaded lazily) and a credential such as
 * `DefaultAzureCredential` from `@azure/identity`. Inject a fake {@link KmsApi}
 * to unit-test without Azure.
 *
 * @module
 */

export * from "./interface.ts";
export { AzureKeyVaultProvider, createRealApi, newAzureKeyVaultProvider } from "./repository.ts";
export {
  /** Provider-backed cryptography and key-lifecycle contract used by Azure Key Vault. */
  type CloudKmsRepository,
  /** Injectable byte-oriented boundary for Azure Key Vault operations. */
  type KmsApi,
  /** Normalized metadata returned for an Azure Key Vault key. */
  type KmsKeyDescription,
  /** Shared cloud-KMS repository behavior extended by the Azure provider. */
  KmsRepositoryBase,
} from "../common/kms.ts";
export type {
  /** Common tracing and cancellation fields for Azure Key Vault requests. */
  BaseRequest,
  /** Request to disable an Azure Key Vault key. */
  DeactivateKeyRequest,
  /** Request to retrieve metadata for an Azure Key Vault key. */
  GetKeyRequest,
  /** Normalized provider key metadata and encoded public material. */
  KeyData,
  /** Request to decrypt Base64 ciphertext with Azure Key Vault. */
  KmsDecryptRequest,
  /** Request to encrypt plaintext with Azure Key Vault. */
  KmsEncryptRequest,
  /** Request to sign a message with Azure Key Vault. */
  KmsSignRequest,
  /** Request to verify a signature with Azure Key Vault. */
  KmsVerifyRequest,
  /** Request to rotate Azure Key Vault-managed key material. */
  RotateKeyRequest,
} from "../common/kms.ts";
