// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0
//
// GENERATED FILE — DO NOT EDIT.
// Produced by tools/wit_contract.ts from the GoForge release bundle:
//   goforge.manifest.v1 / pointerbyte:goforge@0.1.0 / goforge.abi.v1
//   WIT export: pointerbyte:goforge/operations@0.1.0
// Regenerate with `deno task contract`; `deno task contract:check` fails when this is stale.

/** Contract identity as declared by GoForge. */
export const GENERATED_PORTABLE_PACKAGE = "pointerbyte:goforge" as const;
/** Contract version as declared by GoForge. */
export const GENERATED_PORTABLE_VERSION = "0.1.0" as const;
/** Portable contract manifest schema as declared by GoForge. */
export const GENERATED_PORTABLE_MANIFEST_SCHEMA = "goforge.manifest.v1" as const;
/** JSON bridge ABI as declared by GoForge. */
export const GENERATED_ABI = "goforge.abi.v1" as const;
/** Versioned WIT interface exported by the built component. */
export const GENERATED_WIT_INTERFACE = "pointerbyte:goforge/operations@0.1.0" as const;

/** Serialization profile GoForge accepts. */
export const GENERATED_ENCODING = Object.freeze({
  json: "RFC 8259; UTF-8; unique object fields; unknown fields rejected",
  binary: "RFC 4648 standard alphabet with required padding",
});

/** Every operation, in GoForge's declaration order. */
export const GENERATED_OPERATIONS = [
  "text.normalize",
  "text.validate",
  "crypto.sha256",
  "crypto.hmac-sha256",
  "crypto.aes-gcm.encrypt",
  "crypto.aes-gcm.decrypt",
  "encoding.base64.encode",
  "encoding.base64.decode",
] as const;

/** An operation name derived from the GoForge contract. */
export type GeneratedOperation = typeof GENERATED_OPERATIONS[number];

/** Required capability per operation. */
export const GENERATED_OPERATION_CAPABILITIES: Readonly<Record<GeneratedOperation, string>> = Object
  .freeze({
    "text.normalize": "portable.normalize",
    "text.validate": "portable.validate",
    "crypto.sha256": "crypto.sha256",
    "crypto.hmac-sha256": "crypto.hmac-sha256",
    "crypto.aes-gcm.encrypt": "crypto.aes-gcm",
    "crypto.aes-gcm.decrypt": "crypto.aes-gcm",
    "encoding.base64.encode": "encoding.base64",
    "encoding.base64.decode": "encoding.base64",
  });

/** Every capability GoForge declares, including host-supplied controls. */
export const GENERATED_CAPABILITIES = [
  "portable.normalize",
  "portable.validate",
  "crypto.sha256",
  "crypto.hmac-sha256",
  "crypto.aes-gcm",
  "encoding.base64",
  "control.deadline",
  "control.cancellation",
] as const;

/** Host-supplied control capabilities, which the guest cannot satisfy alone. */
export const GENERATED_HOST_CAPABILITIES = [
  "control.deadline",
  "control.cancellation",
] as const;

/** Resource bounds the guest enforces. */
export const GENERATED_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  "max_request_bytes": 1048576,
  "max_response_bytes": 1048576,
  "max_binary_bytes": 524288,
  "max_string_bytes": 65536,
  "max_id_bytes": 128,
  "max_cancellation_token_bytes": 256,
  "max_required_capabilities": 32,
  "max_json_depth": 32,
});

/** Error codes in GoForge's catalog order; the guest manifest is compared position by position. */
export const GENERATED_ERROR_CODES = [
  "invalid_json",
  "unknown_field",
  "duplicate_field",
  "request_too_large",
  "response_too_large",
  "invalid_abi",
  "invalid_request",
  "unknown_operation",
  "capability_unavailable",
  "execution_state_required",
  "deadline_exceeded",
  "cancellation_requested",
  "invalid_base64",
  "invalid_utf8",
  "input_too_large",
  "invalid_key",
  "invalid_nonce",
  "authentication_failed",
  "internal",
] as const;

/** A canonical error code derived from the GoForge contract. */
export type GeneratedErrorCode = typeof GENERATED_ERROR_CODES[number];

/** The immutable error catalog, message and retryability included. */
export const GENERATED_ERROR_CATALOG: Readonly<
  Record<GeneratedErrorCode, { readonly message: string; readonly retryable: boolean }>
> = Object.freeze({
  "invalid_json": { message: "JSON is malformed or not canonical ABI input", retryable: false },
  "unknown_field": { message: "JSON contains an unknown field", retryable: false },
  "duplicate_field": { message: "JSON contains a duplicate object field", retryable: false },
  "request_too_large": { message: "request exceeds the configured byte limit", retryable: false },
  "response_too_large": { message: "response exceeds the configured byte limit", retryable: false },
  "invalid_abi": { message: "request ABI version is unsupported", retryable: false },
  "invalid_request": { message: "request does not satisfy the ABI contract", retryable: false },
  "unknown_operation": { message: "operation is unsupported", retryable: false },
  "capability_unavailable": { message: "required capability is unavailable", retryable: false },
  "execution_state_required": {
    message: "host did not provide checked execution state",
    retryable: false,
  },
  "deadline_exceeded": { message: "request deadline has been exceeded", retryable: true },
  "cancellation_requested": { message: "request cancellation was requested", retryable: false },
  "invalid_base64": { message: "value is not canonical standard padded Base64", retryable: false },
  "invalid_utf8": { message: "value is not valid UTF-8", retryable: false },
  "input_too_large": {
    message: "operation input exceeds the configured byte limit",
    retryable: false,
  },
  "invalid_key": { message: "cryptographic key has an invalid length", retryable: false },
  "invalid_nonce": { message: "AES-GCM nonce must be exactly 12 bytes", retryable: false },
  "authentication_failed": { message: "AES-GCM authentication failed", retryable: false },
  "internal": {
    message: "portable operation failed without a safe public detail",
    retryable: false,
  },
});

/** Execution-state record fields, in WIT declaration order. */
export const GENERATED_EXECUTION_STATE_FIELDS = [
  "clock-checked",
  "now-unix-milliseconds",
  "cancellation-checked",
  "cancellation-token",
  "cancellation-requested",
] as const;
