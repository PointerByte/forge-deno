// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Azure Key Vault provider.
 *
 * Implements {@link CloudKmsRepository} via {@link KmsRepositoryBase}. The real
 * adapter lazily loads `@azure/keyvault-keys` and uses the supplied credential
 * (e.g. `DefaultAzureCredential` from `@azure/identity`). Pass `api` to inject a
 * fake.
 *
 * @module
 */

import { type KmsApi, KmsRepositoryBase } from "../common/kms.ts";
import type { AzureKeyVaultOptions } from "./interface.ts";

const PROVIDER = "azure-key-vault";
const DEFAULT_ENCRYPTION_ALGORITHM = "RSA-OAEP-256";
const DEFAULT_SIGNING_ALGORITHM = "PS256";

/** Azure Key Vault-backed implementation of {@link CloudKmsRepository}. */
export class AzureKeyVaultProvider extends KmsRepositoryBase {
  /** Creates an Azure Key Vault provider, optionally with an injected API adapter. */
  constructor(private readonly options: AzureKeyVaultOptions = {}) {
    super(PROVIDER, options.signingAlgorithm ?? DEFAULT_SIGNING_ALGORITHM, options.api);
  }

  /** Lazily creates the Azure SDK-backed API adapter. */
  protected createApi(): Promise<KmsApi> {
    return createRealApi(this.options);
  }
}

/** Factory constructor. */
export function newAzureKeyVaultProvider(
  options: AzureKeyVaultOptions = {},
): AzureKeyVaultProvider {
  return new AzureKeyVaultProvider(options);
}

// --- Real SDK adapter -------------------------------------------------------

interface AzureCryptoResult {
  result: Uint8Array;
}
interface AzureVerifyResult {
  result: boolean;
}
interface AzureCryptographyClient {
  encrypt(params: { algorithm: string; plaintext: Uint8Array }): Promise<AzureCryptoResult>;
  decrypt(params: { algorithm: string; ciphertext: Uint8Array }): Promise<AzureCryptoResult>;
  signData(algorithm: string, data: Uint8Array): Promise<AzureCryptoResult>;
  verifyData(
    algorithm: string,
    data: Uint8Array,
    signature: Uint8Array,
  ): Promise<AzureVerifyResult>;
}
interface AzureKey {
  name: string;
  id?: string;
}
interface AzureKeyClient {
  getKey(name: string): Promise<AzureKey>;
  rotateKey(name: string): Promise<AzureKey>;
  updateKeyProperties(name: string, options: { enabled?: boolean }): Promise<unknown>;
}
interface AzureSdk {
  KeyClient: new (vaultUrl: string, credential: unknown) => AzureKeyClient;
  CryptographyClient: new (keyId: string, credential: unknown) => AzureCryptographyClient;
}

/** Builds a {@link KmsApi} backed by the real `@azure/keyvault-keys`. */
export async function createRealApi(options: AzureKeyVaultOptions): Promise<KmsApi> {
  if (!options.vaultUrl) throw new Error("azure-key-vault: vaultUrl is required");
  if (!options.credential) throw new Error("azure-key-vault: credential is required");

  // Loaded only when a real adapter is built at runtime.
  const sdk = await import("@azure/keyvault-keys") as unknown as AzureSdk;
  const credential = options.credential;
  const keyClient = new sdk.KeyClient(options.vaultUrl, credential);
  const encryptionAlgorithm = options.encryptionAlgorithm ?? DEFAULT_ENCRYPTION_ALGORITHM;
  const crypto = (keyId: string) => new sdk.CryptographyClient(keyId, credential);

  return {
    async encrypt(keyId, plaintext) {
      const out = await crypto(keyId).encrypt({ algorithm: encryptionAlgorithm, plaintext });
      return out.result;
    },
    async decrypt(ciphertext, keyId) {
      if (!keyId) throw new Error("azure-key-vault: keyId is required to decrypt");
      const out = await crypto(keyId).decrypt({ algorithm: encryptionAlgorithm, ciphertext });
      return out.result;
    },
    async sign(keyId, message, algorithm) {
      const out = await crypto(keyId).signData(algorithm, message);
      return out.result;
    },
    async verify(keyId, message, signature, algorithm) {
      const out = await crypto(keyId).verifyData(algorithm, message, signature);
      return out.result;
    },
    async describeKey(keyId) {
      const key = await keyClient.getKey(keyId);
      return { keyId: key.name, keyRef: key.id ?? key.name };
    },
    async disableKey(keyId) {
      await keyClient.updateKeyProperties(keyId, { enabled: false });
    },
    async rotateKey(keyId) {
      await keyClient.rotateKey(keyId);
    },
  };
}
