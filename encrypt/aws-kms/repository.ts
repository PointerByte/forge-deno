// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS KMS provider.
 *
 * Implements {@link CloudKmsRepository} via {@link KmsRepositoryBase}. The real
 * adapter lazily loads `@aws-sdk/client-kms`; pass `api` to inject a fake. Key
 * material stays in KMS — operations address keys by id/ARN and exchange Base64
 * ciphertext/signatures.
 *
 * @module
 */

import { type KmsApi, KmsRepositoryBase } from "../common/kms.ts";
import { toBase64 } from "../utilities/utilities.ts";
import type { AwsKmsOptions } from "./interface.ts";

const PROVIDER = "aws-kms";
const DEFAULT_SIGNING_ALGORITHM = "RSASSA_PSS_SHA_256";

/** AWS KMS-backed implementation of {@link CloudKmsRepository}. */
export class AwsKmsProvider extends KmsRepositoryBase {
  /** Creates an AWS KMS provider, optionally with an injected API adapter. */
  constructor(private readonly options: AwsKmsOptions = {}) {
    super(PROVIDER, options.signingAlgorithm ?? DEFAULT_SIGNING_ALGORITHM, options.api);
  }

  /** Lazily creates the AWS SDK-backed API adapter. */
  protected createApi(): Promise<KmsApi> {
    return createRealApi(this.options);
  }
}

/** Factory constructor. */
export function newAwsKmsProvider(options: AwsKmsOptions = {}): AwsKmsProvider {
  return new AwsKmsProvider(options);
}

// --- Real SDK adapter -------------------------------------------------------

interface AwsCommand {
  readonly input?: unknown;
}
interface AwsSdkClient {
  send(command: AwsCommand): Promise<Record<string, unknown>>;
}
interface AwsSdk {
  KMSClient: new (config: Record<string, unknown>) => AwsSdkClient;
  EncryptCommand: new (input: Record<string, unknown>) => AwsCommand;
  DecryptCommand: new (input: Record<string, unknown>) => AwsCommand;
  SignCommand: new (input: Record<string, unknown>) => AwsCommand;
  VerifyCommand: new (input: Record<string, unknown>) => AwsCommand;
  DescribeKeyCommand: new (input: Record<string, unknown>) => AwsCommand;
  DisableKeyCommand: new (input: Record<string, unknown>) => AwsCommand;
  GetPublicKeyCommand: new (input: Record<string, unknown>) => AwsCommand;
  RotateKeyOnDemandCommand: new (input: Record<string, unknown>) => AwsCommand;
}

/** Builds a {@link KmsApi} backed by the real `@aws-sdk/client-kms`. */
export async function createRealApi(options: AwsKmsOptions): Promise<KmsApi> {
  // Loaded only when a real adapter is built at runtime.
  const sdk = await import("@aws-sdk/client-kms") as unknown as AwsSdk;
  const client = new sdk.KMSClient({ region: options.region, ...(options.clientConfig ?? {}) });
  const bytes = (v: unknown): Uint8Array => new Uint8Array(v as ArrayBufferLike);

  return {
    async encrypt(keyId, plaintext) {
      const out = await client.send(new sdk.EncryptCommand({ KeyId: keyId, Plaintext: plaintext }));
      return bytes(out.CiphertextBlob);
    },
    async decrypt(ciphertext, keyId) {
      const out = await client.send(
        new sdk.DecryptCommand({ CiphertextBlob: ciphertext, KeyId: keyId }),
      );
      return bytes(out.Plaintext);
    },
    async sign(keyId, message, algorithm) {
      const out = await client.send(
        new sdk.SignCommand({
          KeyId: keyId,
          Message: message,
          MessageType: "RAW",
          SigningAlgorithm: algorithm,
        }),
      );
      return bytes(out.Signature);
    },
    async verify(keyId, message, signature, algorithm) {
      const out = await client.send(
        new sdk.VerifyCommand({
          KeyId: keyId,
          Message: message,
          Signature: signature,
          SigningAlgorithm: algorithm,
        }),
      );
      return Boolean(out.SignatureValid);
    },
    async describeKey(keyId) {
      const out = await client.send(new sdk.DescribeKeyCommand({ KeyId: keyId }));
      const meta = (out.KeyMetadata ?? {}) as Record<string, unknown>;
      let publicKey: string | undefined;
      try {
        const pub = await client.send(new sdk.GetPublicKeyCommand({ KeyId: keyId }));
        if (pub.PublicKey) publicKey = toBase64(bytes(pub.PublicKey));
      } catch {
        // Symmetric keys have no public material.
      }
      return {
        keyId: String(meta.KeyId ?? keyId),
        keyRef: meta.Arn as string | undefined,
        publicKey,
      };
    },
    async disableKey(keyId) {
      await client.send(new sdk.DisableKeyCommand({ KeyId: keyId }));
    },
    async rotateKey(keyId) {
      await client.send(new sdk.RotateKeyOnDemandCommand({ KeyId: keyId }));
    },
  };
}
