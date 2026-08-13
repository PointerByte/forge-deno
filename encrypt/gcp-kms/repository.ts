// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * GCP KMS provider.
 *
 * Implements {@link CloudKmsRepository} via {@link KmsRepositoryBase}. The real
 * adapter lazily loads `@google-cloud/kms`. GCP signs over a digest, so the
 * adapter hashes the message with SHA-256 before `asymmetricSign`. GCP has no
 * server-side verify API, so verification is performed client-side with the
 * key's public material (RSA only). Pass `api` to inject a fake.
 *
 * @module
 */

import { type KmsApi, KmsRepositoryBase } from "../common/kms.ts";
import { fromBase64 } from "../utilities/utilities.ts";
import type { GcpKmsOptions } from "./interface.ts";

const PROVIDER = "gcp-kms";
const DEFAULT_SIGNING_ALGORITHM = "RSA_SIGN_PSS_2048_SHA256";

/** GCP KMS-backed implementation of {@link CloudKmsRepository}. */
export class GcpKmsProvider extends KmsRepositoryBase {
  /** Creates a GCP KMS provider, optionally with an injected API adapter. */
  constructor(private readonly options: GcpKmsOptions = {}) {
    super(PROVIDER, options.signingAlgorithm ?? DEFAULT_SIGNING_ALGORITHM, options.api);
  }

  /** Lazily creates the Google Cloud SDK-backed API adapter. */
  protected createApi(): Promise<KmsApi> {
    return createRealApi(this.options);
  }
}

/** Factory constructor. */
export function newGcpKmsProvider(options: GcpKmsOptions = {}): GcpKmsProvider {
  return new GcpKmsProvider(options);
}

// --- Real SDK adapter -------------------------------------------------------

interface GcpClient {
  encrypt(req: Record<string, unknown>): Promise<[{ ciphertext?: unknown }]>;
  decrypt(req: Record<string, unknown>): Promise<[{ plaintext?: unknown }]>;
  asymmetricSign(req: Record<string, unknown>): Promise<[{ signature?: unknown }]>;
  getPublicKey(req: Record<string, unknown>): Promise<[{ pem?: string; algorithm?: string }]>;
  createCryptoKeyVersion(req: Record<string, unknown>): Promise<[unknown]>;
  updateCryptoKeyVersion(req: Record<string, unknown>): Promise<[unknown]>;
}
interface GcpSdk {
  KeyManagementServiceClient: new (config?: Record<string, unknown>) => GcpClient;
}

/** Builds a {@link KmsApi} backed by the real `@google-cloud/kms`. */
export async function createRealApi(options: GcpKmsOptions): Promise<KmsApi> {
  // Loaded only when a real adapter is built at runtime.
  const sdk = await import("@google-cloud/kms") as unknown as GcpSdk;
  const client = new sdk.KeyManagementServiceClient(options.clientConfig ?? {});
  const bytes = (v: unknown): Uint8Array => new Uint8Array(v as ArrayBufferLike);

  return {
    async encrypt(keyId, plaintext) {
      const [res] = await client.encrypt({ name: keyId, plaintext });
      return bytes(res.ciphertext);
    },
    async decrypt(ciphertext, keyId) {
      const [res] = await client.decrypt({ name: keyId, ciphertext });
      return bytes(res.plaintext);
    },
    async sign(keyId, message) {
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", Uint8Array.from(message)),
      );
      const [res] = await client.asymmetricSign({ name: keyId, digest: { sha256: digest } });
      return bytes(res.signature);
    },
    async verify(keyId, message, signature, algorithm) {
      const [pub] = await client.getPublicKey({ name: keyId });
      if (!pub.pem) throw new Error("gcp-kms: no public key available to verify");
      return verifyWithPublicKey(pub.pem, message, signature, algorithm);
    },
    async describeKey(keyId) {
      try {
        const [pub] = await client.getPublicKey({ name: keyId });
        return { keyId, keyRef: keyId, publicKey: pub.pem ? pemToBase64(pub.pem) : undefined };
      } catch {
        return { keyId, keyRef: keyId };
      }
    },
    async disableKey(keyId) {
      await client.updateCryptoKeyVersion({
        cryptoKeyVersion: { name: keyId, state: "DISABLED" },
        updateMask: { paths: ["state"] },
      });
    },
    async rotateKey(keyId) {
      await client.createCryptoKeyVersion({ parent: keyId, cryptoKeyVersion: {} });
    },
  };
}

/** Extracts the Base64 DER body from a PEM block. */
function pemToBase64(pem: string): string {
  return pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
}

/** Verifies an RSA signature client-side using the key's public PEM. */
async function verifyWithPublicKey(
  pem: string,
  message: Uint8Array,
  signature: Uint8Array,
  algorithm: string,
): Promise<boolean> {
  const der = fromBase64(pemToBase64(pem));
  const upper = algorithm.toUpperCase();
  const pss = upper.includes("PSS") || !upper.includes("PKCS1");
  const importParams: RsaHashedImportParams = pss
    ? { name: "RSA-PSS", hash: "SHA-256" }
    : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const verifyParams: AlgorithmIdentifier | RsaPssParams = pss
    ? { name: "RSA-PSS", saltLength: 32 }
    : "RSASSA-PKCS1-v1_5";
  const key = await crypto.subtle.importKey("spki", der, importParams, false, ["verify"]);
  return crypto.subtle.verify(
    verifyParams,
    key,
    Uint8Array.from(signature),
    Uint8Array.from(message),
  );
}
