// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * GCP KMS provider contract.
 *
 * The public repository is the shared {@link CloudKmsRepository}; the injectable
 * seam is the shared {@link KmsApi} (implemented by the real
 * `@google-cloud/kms` adapter, or a fake in tests).
 *
 * @module
 */

import type { CloudKmsRepository, KmsApi } from "../common/kms.ts";

export type { CloudKmsRepository, KmsApi };

/** Construction options for the GCP KMS provider. */
export interface GcpKmsOptions {
  /** Default signing algorithm label (informational; the key version decides). */
  signingAlgorithm?: string;
  /** Inject a custom/fake API (used by tests and advanced callers). */
  api?: KmsApi;
  /** Config passed to `new KeyManagementServiceClient(...)`. */
  clientConfig?: Record<string, unknown>;
}
