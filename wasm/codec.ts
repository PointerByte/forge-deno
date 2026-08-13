// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import type {
  AbiFailureResponseV1,
  AbiRequestMetadataV1,
  AbiRequestV1,
  AbiResponseV1,
  AbiSuccessResponseV1,
  AbiValue,
  GoforgeAbiOperationV1,
} from "./contracts.ts";
import {
  GOFORGE_ABI_V1,
  GOFORGE_ABI_V1_OPERATION_CAPABILITIES,
  GOFORGE_ABI_V1_OPERATIONS,
} from "./contracts.ts";
import { WasmCodecError } from "./errors.ts";

const MAX_REQUEST_BYTES = 1 << 20;
const MAX_RESPONSE_BYTES = 1 << 20;
const MAX_BINARY_BYTES = 512 << 10;
const MAX_ID_BYTES = 128;
const MAX_CANCELLATION_TOKEN_BYTES = 256;
const MAX_REQUIRED_CAPABILITIES = 32;
const MAX_JSON_DEPTH = 32;
const operationSet = new Set<string>(GOFORGE_ABI_V1_OPERATIONS);
const capabilityPattern = /^[a-z0-9.-]+$/;
const errorCodePattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const utf8 = new TextEncoder();

/**
 * Every stable GoForge portable ABI v1 error code, in the exact order GoForge emits them.
 *
 * The order is contractual: {@link assertPortableContractManifest} compares the guest's error
 * catalog against this sequence position by position.
 */
export const GOFORGE_ABI_V1_ERROR_CODES = [
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

/** A stable GoForge portable ABI v1 error code. */
export type GoforgeAbiErrorCodeV1 = typeof GOFORGE_ABI_V1_ERROR_CODES[number];

/** The immutable public definition of one canonical ABI error. */
export interface GoforgeAbiErrorDefinitionV1 {
  /** Stable public message; never includes an underlying runtime or cryptographic detail. */
  readonly message: string;
  /** Whether the individual failure is transient. */
  readonly retryable: boolean;
}

/** Canonical error catalog copied from GoForge portable ABI v1. */
export const GOFORGE_ABI_ERROR_CATALOG: Readonly<
  Record<GoforgeAbiErrorCodeV1, GoforgeAbiErrorDefinitionV1>
> = Object.freeze(
  {
    invalid_json: {
      message: "JSON is malformed or not canonical ABI input",
      retryable: false,
    },
    unknown_field: { message: "JSON contains an unknown field", retryable: false },
    duplicate_field: { message: "JSON contains a duplicate object field", retryable: false },
    request_too_large: {
      message: "request exceeds the configured byte limit",
      retryable: false,
    },
    response_too_large: {
      message: "response exceeds the configured byte limit",
      retryable: false,
    },
    invalid_abi: { message: "request ABI version is unsupported", retryable: false },
    invalid_request: { message: "request does not satisfy the ABI contract", retryable: false },
    unknown_operation: { message: "operation is unsupported", retryable: false },
    capability_unavailable: {
      message: "required capability is unavailable",
      retryable: false,
    },
    execution_state_required: {
      message: "host did not provide checked execution state",
      retryable: false,
    },
    deadline_exceeded: { message: "request deadline has been exceeded", retryable: true },
    cancellation_requested: { message: "request cancellation was requested", retryable: false },
    invalid_base64: {
      message: "value is not canonical standard padded Base64",
      retryable: false,
    },
    invalid_utf8: { message: "value is not valid UTF-8", retryable: false },
    input_too_large: {
      message: "operation input exceeds the configured byte limit",
      retryable: false,
    },
    invalid_key: { message: "cryptographic key has an invalid length", retryable: false },
    invalid_nonce: { message: "AES-GCM nonce must be exactly 12 bytes", retryable: false },
    authentication_failed: { message: "AES-GCM authentication failed", retryable: false },
    internal: {
      message: "portable operation failed without a safe public detail",
      retryable: false,
    },
  } as const,
);

/** Encodes bytes as canonical RFC 4648 standard-alphabet Base64 with required padding. */
export function encodeAbiBase64(value: Uint8Array | ArrayBuffer | ArrayBufferView): string {
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new WasmCodecError("Base64 input must be an ArrayBuffer or typed-array view");
  }
  if (bytes.byteLength > MAX_BINARY_BYTES) {
    throw new WasmCodecError("Base64 input exceeds the ABI binary limit");
  }
  return encodeBase64(bytes);
}

/** Decodes canonical padded Base64 and rejects URL-safe, unpadded, or oversized input. */
export function decodeAbiBase64(value: string): Uint8Array {
  assertCanonicalBase64(value, "Base64 value");
  const bytes = Uint8Array.from(decodeBase64(value));
  if (bytes.byteLength > MAX_BINARY_BYTES) {
    throw new WasmCodecError("Base64 value exceeds the ABI binary limit");
  }
  return bytes;
}

/**
 * Validates and detaches a raw JSON ABI value.
 *
 * @deprecated Prefer operation-specific payload types plus {@link encodeAbiBase64}. This function
 * no longer creates generic byte wrappers because GoForge ABI v1 has no such representation.
 */
export function encodeAbiValue(value: unknown): AbiValue {
  return copyAbiValue(value, new Set(), "$", 0);
}

/**
 * Validates and detaches a raw JSON ABI value without implicit binary decoding.
 *
 * @deprecated Prefer operation-specific result types plus {@link decodeAbiBase64}.
 */
export function decodeAbiValue(value: AbiValue): unknown {
  return copyAbiValue(value, new Set(), "$", 0);
}

/** Creates a strict canonical ABI v1 request envelope. */
export function createAbiRequest(
  id: string,
  operation: string,
  payload: unknown,
  metadata?: Readonly<AbiRequestMetadataV1>,
): AbiRequestV1 {
  assertIdentifier(id, "id");
  if (!operationSet.has(operation)) {
    throw new WasmCodecError(`unsupported ABI operation ${JSON.stringify(operation)}`);
  }
  const normalizedMetadata = metadata === undefined ? undefined : normalizeMetadata(metadata);
  const request: AbiRequestV1 = {
    abi: GOFORGE_ABI_V1,
    id,
    operation: operation as GoforgeAbiOperationV1,
    payload: encodeAbiValue(payload),
  };
  // Go's Request struct serializes metadata before payload. Rebuild only when metadata is present.
  if (normalizedMetadata !== undefined) {
    return {
      abi: request.abi,
      id: request.id,
      operation: request.operation,
      metadata: normalizedMetadata,
      payload: request.payload,
    };
  }
  return request;
}

/** Serializes a request in the same field order as Go's canonical Request struct. */
export function serializeAbiRequest(request: AbiRequestV1): string {
  validateRequestEnvelope(request);
  const json = JSON.stringify(request);
  if (utf8.encode(json).byteLength > MAX_REQUEST_BYTES) {
    throw new WasmCodecError("request exceeds the ABI byte limit");
  }
  return json;
}

/** Creates a canonical success response for a native adapter or mock component. */
export function createAbiSuccessResponse(id: string, result: unknown): AbiSuccessResponseV1 {
  assertIdentifier(id, "id");
  return { abi: GOFORGE_ABI_V1, id, ok: true, result: encodeAbiValue(result) };
}

/** Creates a canonical failure using the immutable GoForge ABI v1 error catalog. */
export function createAbiFailureResponse(
  id: string,
  error: {
    code: GoforgeAbiErrorCodeV1;
    field?: string;
    message?: string;
    retryable?: boolean;
  },
): AbiFailureResponseV1 {
  assertIdentifier(id, "id");
  const definition = GOFORGE_ABI_ERROR_CATALOG[error.code];
  if (!definition) throw new WasmCodecError(`unknown ABI error code ${JSON.stringify(error.code)}`);
  if (error.message !== undefined && error.message !== definition.message) {
    throw new WasmCodecError("ABI error message does not match the GoForge v1 catalog");
  }
  if (error.retryable !== undefined && error.retryable !== definition.retryable) {
    throw new WasmCodecError("ABI error retryability does not match the GoForge v1 catalog");
  }
  const response: AbiFailureResponseV1 = {
    abi: GOFORGE_ABI_V1,
    id,
    ok: false,
    error: { code: error.code, message: definition.message, retryable: definition.retryable },
  };
  if (error.field !== undefined) {
    assertErrorField(error.field);
    response.error.field = error.field;
  }
  return response;
}

/** Parses and strictly validates one component JSON response for a request. */
export function parseAbiResponse(json: string, expectedId: string): AbiResponseV1 {
  if (utf8.encode(json).byteLength > MAX_RESPONSE_BYTES) {
    throw new WasmCodecError("component response exceeds the ABI byte limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
    assertUniqueAbiJsonObjectFields(json);
  } catch (cause) {
    if (cause instanceof WasmCodecError) throw cause;
    throw new WasmCodecError("component response is not valid JSON", { cause });
  }
  return validateAbiResponse(value, expectedId);
}

/** Strictly validates an adapter response for one request. */
export function validateAbiResponse(value: unknown, expectedId: string): AbiResponseV1 {
  assertIdentifier(expectedId, "id");
  const object = requireRecord(value, "response");
  requireExactKeys(
    object,
    object.ok === true ? ["abi", "id", "ok", "result"] : ["abi", "id", "ok", "error"],
    "response",
  );
  if (object.abi !== GOFORGE_ABI_V1) {
    throw new WasmCodecError(`unsupported response ABI ${JSON.stringify(object.abi)}`);
  }
  if (object.id !== expectedId) {
    throw new WasmCodecError("component response id does not match the request");
  }
  if (object.ok === true) {
    const result = encodeAbiValue(object.result);
    return { abi: GOFORGE_ABI_V1, id: expectedId, ok: true, result };
  }
  if (object.ok !== false) throw new WasmCodecError("response.ok must be a boolean discriminator");

  const error = requireRecord(object.error, "response.error");
  const allowed = ["code", "message", "retryable"];
  if ("field" in error) allowed.push("field");
  requireExactKeys(error, allowed, "response.error");
  if (typeof error.code !== "string" || !errorCodePattern.test(error.code)) {
    throw new WasmCodecError("response.error.code must be lowercase snake_case");
  }
  const definition = GOFORGE_ABI_ERROR_CATALOG[error.code as GoforgeAbiErrorCodeV1];
  if (!definition) throw new WasmCodecError(`response.error.code ${error.code} is not in ABI v1`);
  if (error.message !== definition.message) {
    throw new WasmCodecError("response.error.message does not match the ABI v1 catalog");
  }
  if (error.retryable !== definition.retryable) {
    throw new WasmCodecError("response.error.retryable does not match the ABI v1 catalog");
  }
  const result: AbiFailureResponseV1 = {
    abi: GOFORGE_ABI_V1,
    id: expectedId,
    ok: false,
    error: { code: error.code, message: definition.message, retryable: definition.retryable },
  };
  if ("field" in error) {
    assertErrorField(error.field);
    result.error.field = error.field as string;
  }
  return result;
}

function normalizeMetadata(value: Readonly<AbiRequestMetadataV1>): AbiRequestMetadataV1 {
  const object = requireRecord(value, "metadata");
  const allowed = ["deadline_unix_ms", "cancellation_token", "required_capabilities"];
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw new WasmCodecError(`metadata contains unknown field ${key}`);
  }
  const result: AbiRequestMetadataV1 = {};
  if (value.deadline_unix_ms !== undefined) {
    if (!Number.isSafeInteger(value.deadline_unix_ms) || value.deadline_unix_ms <= 0) {
      throw new WasmCodecError("metadata.deadline_unix_ms must be a positive safe integer");
    }
    result.deadline_unix_ms = value.deadline_unix_ms;
  }
  if (value.cancellation_token !== undefined) {
    assertToken(value.cancellation_token);
    result.cancellation_token = value.cancellation_token;
  }
  if (value.required_capabilities !== undefined) {
    if (
      !Array.isArray(value.required_capabilities) ||
      value.required_capabilities.length > MAX_REQUIRED_CAPABILITIES
    ) {
      throw new WasmCodecError("metadata.required_capabilities exceeds the ABI limit");
    }
    const known = new Set([
      ...Object.values(GOFORGE_ABI_V1_OPERATION_CAPABILITIES),
      "control.deadline",
      "control.cancellation",
    ]);
    const seen = new Set<string>();
    result.required_capabilities = value.required_capabilities.map((capability) => {
      if (
        typeof capability !== "string" || !capabilityPattern.test(capability) ||
        seen.has(capability)
      ) {
        throw new WasmCodecError("metadata.required_capabilities is invalid or duplicated");
      }
      if (!known.has(capability)) {
        throw new WasmCodecError(
          `required capability ${JSON.stringify(capability)} is unavailable`,
        );
      }
      seen.add(capability);
      return capability;
    });
  }
  return result;
}

function validateRequestEnvelope(request: AbiRequestV1): void {
  const object = requireRecord(request, "request");
  const expected = request.metadata === undefined
    ? ["abi", "id", "operation", "payload"]
    : ["abi", "id", "operation", "metadata", "payload"];
  requireExactKeys(object, expected, "request");
  if (request.abi !== GOFORGE_ABI_V1) throw new WasmCodecError("request ABI is unsupported");
  assertIdentifier(request.id, "id");
  if (!operationSet.has(request.operation)) {
    throw new WasmCodecError("request operation is unsupported");
  }
  if (request.metadata !== undefined) normalizeMetadata(request.metadata);
  encodeAbiValue(request.payload);
}

function copyAbiValue(value: unknown, seen: Set<object>, path: string, depth: number): AbiValue {
  if (depth > MAX_JSON_DEPTH) throw new WasmCodecError("ABI data exceeds maximum nesting depth 32");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new WasmCodecError(`${path} is not a finite number`);
    return value;
  }
  if (typeof value !== "object") {
    throw new WasmCodecError(`${path} contains unsupported ${typeof value} data`);
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new WasmCodecError(`${path} contains binary data; encode its contract field as Base64`);
  }
  if (seen.has(value)) throw new WasmCodecError(`${path} contains a reference cycle`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new WasmCodecError(`${path} must contain only plain records`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => copyAbiValue(item, seen, `${path}[${index}]`, depth + 1));
    }
    const result: Record<string, AbiValue> = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new WasmCodecError(`${path} contains a reserved object key`);
      }
      result[key] = copyAbiValue(item, seen, `${path}.${key}`, depth + 1);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function assertCanonicalBase64(value: string, path: string): void {
  if (typeof value !== "string" || value.length % 4 !== 0 || !base64Pattern.test(value)) {
    throw new WasmCodecError(`${path} is not canonical RFC 4648 padded Base64`);
  }
  try {
    const decoded = decodeBase64(value);
    if (encodeBase64(decoded) !== value) throw new Error("non-canonical Base64");
  } catch (cause) {
    throw new WasmCodecError(`${path} is invalid Base64`, { cause });
  }
}

function assertIdentifier(value: unknown, path: string): asserts value is string {
  if (
    typeof value !== "string" || value.length === 0 ||
    utf8.encode(value).byteLength > MAX_ID_BYTES ||
    /\p{Cc}/u.test(value)
  ) {
    throw new WasmCodecError(
      `${path} must be a non-empty control-free UTF-8 string of at most 128 bytes`,
    );
  }
}

function assertToken(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || value.length === 0 ||
    utf8.encode(value).byteLength > MAX_CANCELLATION_TOKEN_BYTES || /\p{Cc}/u.test(value)
  ) {
    throw new WasmCodecError("metadata.cancellation_token is invalid");
  }
}

function assertErrorField(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || value.length === 0 || utf8.encode(value).byteLength > 512 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new WasmCodecError("response.error.field is invalid");
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WasmCodecError(`${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WasmCodecError(`${path} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new WasmCodecError(`${path} has unsupported or missing fields`);
  }
}

/** Detects duplicate object fields that JSON.parse would otherwise overwrite. */
export function assertUniqueAbiJsonObjectFields(json: string): void {
  let index = 0;
  const whitespace = () => {
    while (index < json.length && /[\t\n\r ]/.test(json[index])) index++;
  };
  const stringToken = (): string => {
    const start = index++;
    while (index < json.length) {
      const character = json[index++];
      if (character === "\\") {
        index++;
      } else if (character === '"') {
        return JSON.parse(json.slice(start, index)) as string;
      }
    }
    throw new WasmCodecError("component response contains an unterminated string");
  };
  const value = (depth: number): void => {
    if (depth > MAX_JSON_DEPTH) throw new WasmCodecError("response exceeds maximum JSON depth 32");
    whitespace();
    if (json[index] === "{") return object(depth + 1);
    if (json[index] === "[") return array(depth + 1);
    if (json[index] === '"') {
      stringToken();
      return;
    }
    while (index < json.length && !/[\s,}\]]/.test(json[index])) index++;
  };
  const object = (depth: number): void => {
    index++;
    whitespace();
    const fields = new Set<string>();
    if (json[index] === "}") {
      index++;
      return;
    }
    while (index < json.length) {
      whitespace();
      const key = stringToken();
      if (fields.has(key)) {
        throw new WasmCodecError("component response contains a duplicate object field");
      }
      fields.add(key);
      whitespace();
      index++;
      value(depth);
      whitespace();
      if (json[index++] === "}") return;
    }
  };
  const array = (depth: number): void => {
    index++;
    whitespace();
    if (json[index] === "]") {
      index++;
      return;
    }
    while (index < json.length) {
      value(depth);
      whitespace();
      if (json[index++] === "]") return;
    }
  };
  value(0);
}
