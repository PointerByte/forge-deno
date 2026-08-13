// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS KMS provider contract.
 *
 * The public repository is the shared {@link CloudKmsRepository}; the injectable
 * seam is the shared {@link KmsApi} (implemented by the real
 * `@aws-sdk/client-kms` adapter, or a fake in tests).
 *
 * @module
 */

import type { CloudKmsRepository, KmsApi } from "../common/kms.ts";

export type { CloudKmsRepository, KmsApi };

/** Construction options for the AWS KMS provider. */
export interface AwsKmsOptions {
  /** AWS region (forwarded to the SDK client). */
  region?: string;
  /** Default signing algorithm. Defaults to `RSASSA_PSS_SHA_256`. */
  signingAlgorithm?: string;
  /** Inject a custom/fake API (used by tests and advanced callers). */
  api?: KmsApi;
  /** Arbitrary extra config passed to `new KMSClient(...)`. */
  clientConfig?: Record<string, unknown>;
}
