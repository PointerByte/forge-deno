// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/** Base error type for the encrypt module (mirrors Go's wrapped error values). */
export class EncryptError extends Error {
  /** Stable error class name. */
  override name = "EncryptError";
  /** Creates a normalized encryption error with an optional cause. */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * Thrown when an operation has no equivalent on the active provider, e.g. the
 * cloud-only key-management methods on the local provider.
 */
export class UnsupportedOperationError extends EncryptError {
  /** Stable error class name. */
  override name = "UnsupportedOperationError";
  /** Creates an error naming the unsupported operation. */
  constructor(operation: string) {
    super(`encrypt: operation not supported by this provider: ${operation}`);
  }
}
