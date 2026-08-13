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
  type CloudKmsRepository,
  type KmsApi,
  type KmsKeyDescription,
  KmsRepositoryBase,
} from "../common/kms.ts";
export type {
  BaseRequest,
  DeactivateKeyRequest,
  GetKeyRequest,
  KeyData,
  KmsDecryptRequest,
  KmsEncryptRequest,
  KmsSignRequest,
  KmsVerifyRequest,
  RotateKeyRequest,
} from "../common/kms.ts";
