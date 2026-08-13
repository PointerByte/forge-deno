// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Native Deno implementation of the eight portable GoForge ABI v1 operations.
 *
 * The three-way benchmark puts the WebAssembly component 23–966× slower than native Deno on the
 * same envelope, so latency-sensitive callers need a native path. This module is that path.
 *
 * ## Why this is not duplicated business logic
 *
 * GoForge remains the single source of truth. This adapter is only usable once it has reproduced
 * GoForge's own shared vectors exactly: {@link createNativeGoforgeAdapter} returns an adapter with
 * `parityQualified: false`, which {@link NativeAdapterRegistry} refuses to route to, and only
 * {@link qualifyNativeAdapter} — which replays every vector and compares byte for byte — can produce
 * a qualified one. An implementation that drifts from the Go core cannot be registered, so the
 * duplication is mechanically checked rather than trusted.
 *
 * Routing stays explicit on top of that: the operation's manifest entry must also name the adapter,
 * and a component failure never silently falls back to it.
 *
 * @example Register a qualified adapter and route one operation to it
 * ```ts
 * import { NativeAdapterRegistry } from "@pointerbyte/denoforge/wasm";
 * import {
 *   createNativeGoforgeAdapter,
 *   GOFORGE_NATIVE_ADAPTER_NAME,
 *   qualifyNativeAdapter,
 * } from "@pointerbyte/denoforge/wasm";
 *
 * const adapters = new NativeAdapterRegistry();
 * adapters.register(await qualifyNativeAdapter(createNativeGoforgeAdapter(), vectors));
 *
 * const digest = await runtime.invoke("crypto.sha256", { data: "" }, {
 *   target: { kind: "native", adapter: GOFORGE_NATIVE_ADAPTER_NAME },
 * });
 * ```
 *
 * @module
 */

import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { recordParityQualification } from "./adapters.ts";
import type { NativeAdapterContext, NativeWasmAdapter } from "./adapters.ts";
import { createAbiFailureResponse, createAbiSuccessResponse } from "./codec.ts";
import type { GoforgeAbiErrorCodeV1 } from "./codec.ts";
import { GOFORGE_ABI_V1_OPERATIONS } from "./contracts.ts";
import type { AbiRequestV1, AbiResponseV1, AbiValue, GoforgeAbiOperationV1 } from "./contracts.ts";
import { WasmAdapterError } from "./errors.ts";

/** Default registry name for the native portable adapter. */
export const GOFORGE_NATIVE_ADAPTER_NAME = "native.deno.portable";

/**
 * Byte limits the portable core enforces, mirrored here so the native path rejects exactly what the
 * guest rejects. `generated_contract_test.ts` pins these against the GoForge manifest.
 */
export const GOFORGE_NATIVE_LIMITS: Readonly<{
  maxBinaryBytes: number;
  maxStringBytes: number;
}> = Object.freeze({ maxBinaryBytes: 512 << 10, maxStringBytes: 64 << 10 });

const AES_GCM_NONCE_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const MINIMUM_HMAC_KEY_BYTES = 16;

/** One shared parity vector as published by GoForge. */
export interface GoforgeSharedVector {
  /** Vector name, used to report which case failed qualification. */
  name: string;
  /** Canonical ABI request. */
  request: {
    /** Canonical ABI operation the vector exercises. */
    operation: GoforgeAbiOperationV1;
    /** Operation arguments, already in canonical ABI form. */
    payload: AbiValue;
    /** Correlation identifier echoed back in the response, when present. */
    id?: string;
  };
  /** Canonical ABI response GoForge produced for that request. */
  response: AbiValue;
}

/** Options for {@link createNativeGoforgeAdapter}. */
export interface NativeGoforgeAdapterOptions {
  /** Overrides the registry name. Defaults to {@link GOFORGE_NATIVE_ADAPTER_NAME}. */
  name?: string;
}

/** A payload failure carrying the exact canonical code and field GoForge would report. */
class PayloadError extends Error {
  readonly code: GoforgeAbiErrorCodeV1;
  readonly field?: string;

  constructor(code: GoforgeAbiErrorCodeV1, field?: string) {
    super(code);
    this.name = "PayloadError";
    this.code = code;
    this.field = field;
  }
}

/**
 * Creates the native adapter in its **unqualified** state.
 *
 * The registry rejects unqualified adapters. Pass the result through
 * {@link qualifyNativeAdapter} before registering it.
 *
 * @param options Optional registry name override.
 */
export function createNativeGoforgeAdapter(
  options: NativeGoforgeAdapterOptions = {},
): NativeWasmAdapter {
  // Frozen so the flag cannot simply be flipped on the returned object. The
  // registry's ledger check is what actually enforces qualification; this closes
  // the lazier route of mutating an adapter you already hold.
  return Object.freeze({
    name: options.name ?? GOFORGE_NATIVE_ADAPTER_NAME,
    operations: Object.freeze([...GOFORGE_ABI_V1_OPERATIONS]) as readonly string[],
    parityQualified: false,
    invoke: (request: Readonly<AbiRequestV1>, context: NativeAdapterContext) =>
      dispatch(request, context),
  });
}

/**
 * Replays every shared vector through `adapter` and returns a qualified copy.
 *
 * Qualification is the only way to obtain `parityQualified: true`. It throws — rather than returning
 * an unqualified adapter — because a native crypto path that disagrees with the Go core is a
 * correctness defect, not a capability to degrade past.
 *
 * @param adapter The adapter to qualify.
 * @param vectors GoForge's shared vectors, e.g. from `wasm/testdata/vectors/v1.json`.
 * @throws {WasmAdapterError} When any vector does not reproduce exactly.
 */
export async function qualifyNativeAdapter(
  adapter: NativeWasmAdapter,
  vectors: readonly GoforgeSharedVector[],
): Promise<NativeWasmAdapter> {
  if (vectors.length === 0) {
    throw new WasmAdapterError("parity qualification requires at least one shared vector");
  }
  const covered = new Set<string>();
  const failures: string[] = [];

  for (const vector of vectors) {
    const id = vector.request.id ?? "parity";
    const expected = canonical({ ...(vector.response as Record<string, AbiValue>), id });
    let actual: string;
    try {
      actual = canonical(
        await adapter.invoke({
          abi: "goforge.abi.v1",
          id,
          operation: vector.request.operation,
          payload: vector.request.payload,
        }, { signal: new AbortController().signal, attempt: 1 }),
      );
    } catch (cause) {
      failures.push(`${vector.name}: threw ${String(cause)}`);
      continue;
    }
    if (actual === expected) {
      covered.add(vector.request.operation);
      continue;
    }
    failures.push(`${vector.name}: expected ${expected} but produced ${actual}`);
  }

  if (failures.length > 0) {
    throw new WasmAdapterError(
      `native adapter ${JSON.stringify(adapter.name)} failed parity qualification:\n  ${
        failures.join("\n  ")
      }`,
    );
  }
  const uncovered = adapter.operations.filter((operation) => !covered.has(operation));
  if (uncovered.length > 0) {
    throw new WasmAdapterError(
      `native adapter ${
        JSON.stringify(adapter.name)
      } claims operations with no qualifying vector: ${uncovered.join(", ")}`,
    );
  }
  // recordParityQualification is the registry's only admission point: a frozen
  // object declaring the flag is still refused unless the qualification run that
  // produced it was recorded here.
  return recordParityQualification(Object.freeze({ ...adapter, parityQualified: true }));
}

/** Serializes with sorted keys so field order cannot mask or invent a parity difference. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    return Object.fromEntries(
      Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  });
}

/** Routes one request to its operation, translating payload failures into canonical responses. */
async function dispatch(
  request: Readonly<AbiRequestV1>,
  context: NativeAdapterContext,
): Promise<AbiResponseV1> {
  try {
    if (context.signal.aborted) {
      return createAbiFailureResponse(request.id, { code: "cancellation_requested" });
    }
    if (context.deadlineUnixMs !== undefined && Date.now() > context.deadlineUnixMs) {
      return createAbiFailureResponse(request.id, { code: "deadline_exceeded" });
    }
    const result = await execute(request.operation, request.payload);
    return createAbiSuccessResponse(request.id, result);
  } catch (cause) {
    if (cause instanceof PayloadError) {
      return createAbiFailureResponse(request.id, { code: cause.code, field: cause.field });
    }
    throw cause;
  }
}

/** Executes one operation against an already-parsed payload. */
function execute(operation: string, payload: AbiValue): unknown | Promise<unknown> {
  switch (operation) {
    case "text.normalize":
      return normalize(payload);
    case "text.validate":
      return validate(payload);
    case "crypto.sha256":
      return sha256(payload);
    case "crypto.hmac-sha256":
      return hmacSha256(payload);
    case "crypto.aes-gcm.encrypt":
      return aesGcmEncrypt(payload);
    case "crypto.aes-gcm.decrypt":
      return aesGcmDecrypt(payload);
    case "encoding.base64.encode":
      return base64Encode(payload);
    case "encoding.base64.decode":
      return base64Decode(payload);
    default:
      throw new PayloadError("unknown_operation");
  }
}

// ---------------------------------------------------------------------------------------------
// Payload decoding — mirrors the Go core's strict object rules exactly.
// ---------------------------------------------------------------------------------------------

/** Requires a JSON object with no unknown keys and no missing or null required keys. */
function object(
  payload: AbiValue,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, AbiValue> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PayloadError("invalid_json", "payload");
  }
  const value = payload as Record<string, AbiValue>;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new PayloadError("unknown_field");
  }
  for (const key of required) {
    if (!(key in value) || value[key] === null) {
      throw new PayloadError("invalid_request", `payload.${key}`);
    }
  }
  return value;
}

/** Reads a required string field; a non-string is a decode failure, as in Go. */
function text(value: Record<string, AbiValue>, key: string): string {
  const raw = value[key];
  if (typeof raw !== "string") throw new PayloadError("invalid_json");
  return raw;
}

/** Reads an optional boolean field, defaulting to Go's zero value. */
function flag(value: Record<string, AbiValue>, key: string): boolean {
  const raw = value[key];
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== "boolean") throw new PayloadError("invalid_json");
  return raw;
}

/** Reads an optional integer field, defaulting to Go's zero value. */
function integer(value: Record<string, AbiValue>, key: string): number {
  const raw = value[key];
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== "number" || !Number.isInteger(raw)) throw new PayloadError("invalid_json");
  return raw;
}

/** Reads an optional string field, defaulting to Go's zero value. */
function optionalText(value: Record<string, AbiValue>, key: string): string {
  const raw = value[key];
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") throw new PayloadError("invalid_json");
  return raw;
}

// ---------------------------------------------------------------------------------------------
// Binary helpers — Go's decodeBinary/encodeBinary, including the canonical round-trip check.
// ---------------------------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Length of the Base64 encoding of `n` bytes, matching Go's `base64.StdEncoding.EncodedLen`. */
function encodedLength(byteCount: number): number {
  return Math.floor((byteCount + 2) / 3) * 4;
}

/** Decodes canonical padded standard-alphabet Base64 with GoForge's exact failure codes. */
function binary(encoded: string, field: string, maxBytes: number): Uint8Array<ArrayBuffer> {
  if (encoded.length > encodedLength(maxBytes)) throw new PayloadError("input_too_large", field);
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new PayloadError("invalid_base64", field);
  }
  let decoded: Uint8Array;
  try {
    decoded = decodeBase64(encoded);
  } catch {
    throw new PayloadError("invalid_base64", field);
  }
  // Go re-encodes and compares, which rejects non-canonical trailing bits that decode successfully.
  if (encodeBase64(decoded) !== encoded) throw new PayloadError("invalid_base64", field);
  if (decoded.byteLength > maxBytes) throw new PayloadError("input_too_large", field);
  // Re-wrap so the buffer type is a plain ArrayBuffer, which is what Web Crypto accepts.
  return new Uint8Array(decoded);
}

/** Rejects lone surrogates, which are the JavaScript analogue of invalid UTF-8. */
function assertUtf8(value: string, field: string): void {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) {
    throw new PayloadError("invalid_utf8", field);
  }
}

/** UTF-8 byte length, which is what the Go core measures with `len(string)`. */
function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

// ---------------------------------------------------------------------------------------------
// Unicode predicates — Go's `unicode` semantics, which differ from JavaScript's built-ins.
// ---------------------------------------------------------------------------------------------

/**
 * Go's `unicode.IsSpace`.
 *
 * Deliberately not `String.prototype.trim`: JavaScript trims U+FEFF, which Go does not treat as
 * space, and does not trim U+0085, which Go does.
 */
function isGoSpace(codePoint: number): boolean {
  switch (codePoint) {
    case 0x09:
    case 0x0a:
    case 0x0b:
    case 0x0c:
    case 0x0d:
    case 0x20:
    case 0x85:
    case 0xa0:
    case 0x1680:
    case 0x2028:
    case 0x2029:
    case 0x202f:
    case 0x205f:
    case 0x3000:
      return true;
    default:
      return codePoint >= 0x2000 && codePoint <= 0x200a;
  }
}

/** Go's `unicode.IsControl`: the C0 and C1 control ranges. */
function isGoControl(codePoint: number): boolean {
  return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

function normalize(payload: AbiValue): { value: string } {
  const input = object(payload, ["value"], ["trim", "collapse_whitespace", "lowercase_ascii"]);
  let value = text(input, "value");
  assertUtf8(value, "payload.value");
  if (byteLength(value) > GOFORGE_NATIVE_LIMITS.maxStringBytes) {
    throw new PayloadError("input_too_large", "payload.value");
  }

  if (flag(input, "trim")) value = trimGoSpace(value);
  if (flag(input, "collapse_whitespace")) value = collapseWhitespace(value);
  if (flag(input, "lowercase_ascii")) value = lowercaseAscii(value);
  return { value };
}

/** Go's `strings.TrimSpace`. */
function trimGoSpace(value: string): string {
  const runes = [...value];
  let start = 0;
  let end = runes.length;
  while (start < end && isGoSpace(runes[start].codePointAt(0) as number)) start++;
  while (end > start && isGoSpace(runes[end - 1].codePointAt(0) as number)) end--;
  return runes.slice(start, end).join("");
}

function collapseWhitespace(value: string): string {
  let result = "";
  let inWhitespace = false;
  for (const character of value) {
    if (isGoSpace(character.codePointAt(0) as number)) {
      if (!inWhitespace) {
        result += " ";
        inWhitespace = true;
      }
      continue;
    }
    inWhitespace = false;
    result += character;
  }
  return result;
}

function lowercaseAscii(value: string): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    result += codePoint >= 0x41 && codePoint <= 0x5a
      ? String.fromCodePoint(codePoint + 0x20)
      : character;
  }
  return result;
}

function validate(payload: AbiValue): { valid: boolean; violations: Array<{ code: string }> } {
  const input = object(payload, ["value", "rules"]);
  const value = text(input, "value");
  const rules = object(input.rules, [], [
    "required",
    "ascii",
    "forbid_control",
    "forbid_whitespace",
    "min_bytes",
    "max_bytes",
    "min_runes",
    "max_runes",
    "prefix",
    "suffix",
  ]);

  const prefix = optionalText(rules, "prefix");
  const suffix = optionalText(rules, "suffix");
  const limit = GOFORGE_NATIVE_LIMITS.maxStringBytes;
  for (const [candidate, field] of [[value, "payload"], [prefix, "payload"], [suffix, "payload"]]) {
    assertUtf8(candidate, field);
  }
  if (
    byteLength(value) > limit || byteLength(prefix) > limit || byteLength(suffix) > limit
  ) {
    throw new PayloadError("input_too_large", "payload");
  }

  const minBytes = integer(rules, "min_bytes");
  const maxBytes = integer(rules, "max_bytes");
  const minRunes = integer(rules, "min_runes");
  const maxRunes = integer(rules, "max_runes");
  if (
    minBytes < 0 || maxBytes < 0 || minRunes < 0 || maxRunes < 0 ||
    minBytes > limit || maxBytes > limit || minRunes > limit || maxRunes > limit ||
    (maxBytes > 0 && minBytes > maxBytes) || (maxRunes > 0 && minRunes > maxRunes)
  ) {
    throw new PayloadError("invalid_request", "payload.rules");
  }

  // Violation order is contractual: it is compared position by position against the Go core.
  const violations: Array<{ code: string }> = [];
  const bytes = byteLength(value);
  const runes = [...value].length;
  if (flag(rules, "required") && value === "") violations.push({ code: "required" });
  if (minBytes > 0 && bytes < minBytes) violations.push({ code: "min_bytes" });
  if (maxBytes > 0 && bytes > maxBytes) violations.push({ code: "max_bytes" });
  if (minRunes > 0 && runes < minRunes) violations.push({ code: "min_runes" });
  if (maxRunes > 0 && runes > maxRunes) violations.push({ code: "max_runes" });
  if (flag(rules, "ascii") && [...value].some((c) => (c.codePointAt(0) as number) > 0x7f)) {
    violations.push({ code: "ascii" });
  }
  if (
    flag(rules, "forbid_control") &&
    [...value].some((c) => isGoControl(c.codePointAt(0) as number))
  ) {
    violations.push({ code: "control" });
  }
  if (
    flag(rules, "forbid_whitespace") &&
    [...value].some((c) => isGoSpace(c.codePointAt(0) as number))
  ) {
    violations.push({ code: "whitespace" });
  }
  if (prefix !== "" && !value.startsWith(prefix)) violations.push({ code: "prefix" });
  if (suffix !== "" && !value.endsWith(suffix)) violations.push({ code: "suffix" });

  return { valid: violations.length === 0, violations };
}

async function sha256(payload: AbiValue): Promise<{ digest: string }> {
  const input = object(payload, ["data"]);
  const data = binary(text(input, "data"), "payload.data", GOFORGE_NATIVE_LIMITS.maxBinaryBytes);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return { digest: encodeBase64(new Uint8Array(digest)) };
}

async function hmacSha256(payload: AbiValue): Promise<{ mac: string }> {
  const input = object(payload, ["key", "data"]);
  const keyBytes = binary(text(input, "key"), "payload.key", GOFORGE_NATIVE_LIMITS.maxBinaryBytes);
  if (keyBytes.byteLength < MINIMUM_HMAC_KEY_BYTES) {
    throw new PayloadError("invalid_key", "payload.key");
  }
  const data = binary(text(input, "data"), "payload.data", GOFORGE_NATIVE_LIMITS.maxBinaryBytes);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, data);
  return { mac: encodeBase64(new Uint8Array(mac)) };
}

/** Decodes and range-checks the shared AES-GCM inputs, in the Go core's exact order. */
async function aesInputs(
  input: Record<string, AbiValue>,
  valueField: "plaintext" | "ciphertext",
  usage: "encrypt" | "decrypt",
): Promise<{
  key: CryptoKey;
  nonce: Uint8Array<ArrayBuffer>;
  aad: Uint8Array<ArrayBuffer>;
  value: Uint8Array<ArrayBuffer>;
}> {
  const keyBytes = binary(text(input, "key"), "payload.key", GOFORGE_NATIVE_LIMITS.maxBinaryBytes);
  if (![16, 24, 32].includes(keyBytes.byteLength)) {
    throw new PayloadError("invalid_key", "payload.key");
  }
  const nonce = binary(
    text(input, "nonce"),
    "payload.nonce",
    GOFORGE_NATIVE_LIMITS.maxBinaryBytes,
  );
  if (nonce.byteLength !== AES_GCM_NONCE_BYTES) {
    throw new PayloadError("invalid_nonce", "payload.nonce");
  }
  const aad = binary(text(input, "aad"), "payload.aad", GOFORGE_NATIVE_LIMITS.maxBinaryBytes);

  const decrypting = usage === "decrypt";
  const valueLimit = decrypting
    ? GOFORGE_NATIVE_LIMITS.maxBinaryBytes
    : Math.max(0, GOFORGE_NATIVE_LIMITS.maxBinaryBytes - AES_GCM_TAG_BYTES);
  const field = `payload.${valueField}`;
  const value = binary(text(input, valueField), field, valueLimit);
  if (decrypting && value.byteLength < AES_GCM_TAG_BYTES) {
    throw new PayloadError("authentication_failed", field);
  }

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [usage]);
  } catch {
    throw new PayloadError("invalid_key", "payload.key");
  }
  return { key, nonce, aad, value };
}

async function aesGcmEncrypt(payload: AbiValue): Promise<{ ciphertext: string }> {
  const input = object(payload, ["key", "nonce", "aad", "plaintext"]);
  const { key, nonce, aad, value } = await aesInputs(input, "plaintext", "encrypt");
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: AES_GCM_TAG_BYTES * 8 },
    key,
    value,
  );
  return { ciphertext: encodeBase64(new Uint8Array(ciphertext)) };
}

async function aesGcmDecrypt(payload: AbiValue): Promise<{ plaintext: string }> {
  const input = object(payload, ["key", "nonce", "aad", "ciphertext"]);
  const { key, nonce, aad, value } = await aesInputs(input, "ciphertext", "decrypt");
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: AES_GCM_TAG_BYTES * 8 },
      key,
      value,
    );
  } catch {
    // Authentication failure carries no detail, so a forgery learns nothing from the response.
    throw new PayloadError("authentication_failed", "payload.ciphertext");
  }
  return { plaintext: encodeBase64(new Uint8Array(plaintext)) };
}

function base64Encode(payload: AbiValue): { encoded: string } {
  const input = object(payload, ["text"]);
  const value = text(input, "text");
  assertUtf8(value, "payload.text");
  const bytes = encoder.encode(value);
  if (bytes.byteLength > GOFORGE_NATIVE_LIMITS.maxStringBytes) {
    throw new PayloadError("input_too_large", "payload.text");
  }
  return { encoded: encodeBase64(bytes) };
}

function base64Decode(payload: AbiValue): { text: string } {
  const input = object(payload, ["encoded"]);
  const decoded = binary(
    text(input, "encoded"),
    "payload.encoded",
    GOFORGE_NATIVE_LIMITS.maxStringBytes,
  );
  try {
    return { text: decoder.decode(decoded) };
  } catch {
    throw new PayloadError("invalid_utf8", "payload.encoded");
  }
}
