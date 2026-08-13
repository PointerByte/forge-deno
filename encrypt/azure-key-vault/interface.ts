// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Azure Key Vault provider contract.
 *
 * The public repository is the shared {@link CloudKmsRepository}; the injectable
 * seam is the shared {@link KmsApi} (implemented by the real
 * `@azure/keyvault-keys` adapter, or a fake in tests).
 *
 * @module
 */

import type { CloudKmsRepository, KmsApi } from "../common/kms.ts";

export type { CloudKmsRepository, KmsApi };

/** Construction options for the Azure Key Vault provider. */
export interface AzureKeyVaultOptions {
  /** Vault URL, e.g. `https://my-vault.vault.azure.net`. */
  vaultUrl?: string;
  /**
   * Credential object (e.g. `DefaultAzureCredential`). Required for the real
   * adapter; omit when injecting a fake API.
   */
  credential?: unknown;
  /** Default encryption algorithm. Defaults to `RSA-OAEP-256`. */
  encryptionAlgorithm?: string;
  /** Default signing algorithm. Defaults to `PS256`. */
  signingAlgorithm?: string;
  /** Inject a custom/fake API (used by tests and advanced callers). */
  api?: KmsApi;
}
