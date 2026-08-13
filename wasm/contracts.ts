// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/** The only portable JSON ABI version accepted by this runtime. */
export const GOFORGE_ABI_V1 = "goforge.abi.v1" as const;

/** GoForge's canonical portable contract identity. */
export const GOFORGE_PORTABLE_PACKAGE = "pointerbyte:goforge" as const;
/** Version of the portable contract package this host speaks. */
export const GOFORGE_PORTABLE_VERSION = "0.1.0" as const;
/** Schema family of the contract manifest the guest itself exports. */
export const GOFORGE_PORTABLE_MANIFEST_SCHEMA_V1 = "goforge.manifest.v1" as const;

/** Release-bundle schema. This is deliberately distinct from the portable contract manifest. */
export const GOFORGE_BUNDLE_MANIFEST_SCHEMA_V1 = "goforge.bundle-manifest.v1" as const;

/**
 * Release-bundle schema.
 *
 * @deprecated Use {@link GOFORGE_BUNDLE_MANIFEST_SCHEMA_V1}.
 */
export const GOFORGE_MANIFEST_SCHEMA_V1: typeof GOFORGE_BUNDLE_MANIFEST_SCHEMA_V1 =
  GOFORGE_BUNDLE_MANIFEST_SCHEMA_V1;

/** Stable operations exported by GoForge portable ABI v1. */
export const GOFORGE_ABI_V1_OPERATIONS = [
  "text.normalize",
  "text.validate",
  "crypto.sha256",
  "crypto.hmac-sha256",
  "crypto.aes-gcm.encrypt",
  "crypto.aes-gcm.decrypt",
  "encoding.base64.encode",
  "encoding.base64.decode",
] as const;

/** A GoForge portable ABI v1 operation. */
export type GoforgeAbiOperationV1 = typeof GOFORGE_ABI_V1_OPERATIONS[number];

/** Required capability for each canonical operation. */
export const GOFORGE_ABI_V1_OPERATION_CAPABILITIES: Readonly<
  Record<GoforgeAbiOperationV1, string>
> = Object.freeze({
  "text.normalize": "portable.normalize",
  "text.validate": "portable.validate",
  "crypto.sha256": "crypto.sha256",
  "crypto.hmac-sha256": "crypto.hmac-sha256",
  "crypto.aes-gcm.encrypt": "crypto.aes-gcm",
  "crypto.aes-gcm.decrypt": "crypto.aes-gcm",
  "encoding.base64.encode": "encoding.base64",
  "encoding.base64.decode": "encoding.base64",
});

/** JSON primitives supported by ABI v1. Binary fields are canonical padded Base64 strings. */
export type AbiJsonPrimitive = string | number | boolean | null;

/** A recursively JSON-safe ABI value. There is no generic binary wrapper in this contract. */
export type AbiValue = AbiJsonPrimitive | AbiValue[] | { [key: string]: AbiValue };

/** A relative artifact path and its lowercase SHA-256 digest. */
export interface WasmArtifactDescriptor {
  /** Package-relative path without traversal segments. */
  path: string;
  /** Lowercase hexadecimal SHA-256 digest. */
  sha256: string;
}

/** Release routing and retry metadata for one canonical portable operation. */
export interface WasmOperationContract {
  /** Capability copied from the GoForge portable contract manifest. */
  capability: string;
  /** Whether repeating the same request ID is safe after a transient failure. */
  retrySafe: boolean;
  /** Whether the operation handles cryptographic or authentication material. */
  securitySensitive: boolean;
  /** Explicit parity-qualified native adapters eligible for this operation. */
  nativeAdapters?: string[];
}

/** Strict schema for an immutable component release bundle. */
export interface WasmBundleManifestV1 {
  /** Release-bundle schema, not the Go portable contract-manifest schema. */
  schema: typeof GOFORGE_BUNDLE_MANIFEST_SCHEMA_V1;
  /** Portable JSON bridge ABI version. */
  abi: typeof GOFORGE_ABI_V1;
  /** Exact GoForge component release expected by the host. */
  componentVersion: string;
  /** Exact versioned WIT package name expected by the host. */
  witPackage: string;
  /** Original component artifact used to generate the host output. */
  source: WasmArtifactDescriptor;
  /** Generated ESM host glue loaded by the injected factory. */
  glue: WasmArtifactDescriptor;
  /** External core Wasm modules keyed by generated module name. */
  coreModules: Record<string, WasmArtifactDescriptor>;
  /** Named capabilities declared by this release. */
  capabilities: string[];
  /** Release metadata for every canonical ABI operation. */
  operations: Record<GoforgeAbiOperationV1, WasmOperationContract>;
}

/**
 * Release manifest of a component bundle.
 *
 * @deprecated Use {@link WasmBundleManifestV1}.
 */
export type WasmComponentManifestV1 = WasmBundleManifestV1;

/** Trusted compatibility values compiled into the Deno host. */
export interface WasmCompatibility {
  /** Exact GoForge component version supported by the host. */
  componentVersion: string;
  /** Exact versioned WIT package supported by the host. */
  witPackage: string;
  /** Supported portable ABI; defaults to {@link GOFORGE_ABI_V1}. */
  abi?: typeof GOFORGE_ABI_V1;
  /** Supported release-bundle schema. */
  bundleSchema?: typeof GOFORGE_BUNDLE_MANIFEST_SCHEMA_V1;
  /**
   * Supported portable ABI, under its former name.
   *
   * @deprecated Use `abi`.
   */
  abiVersion?: typeof GOFORGE_ABI_V1;
  /**
   * Supported release-bundle schema, under its former name.
   *
   * @deprecated Use `bundleSchema`.
   */
  schemaVersion?: typeof GOFORGE_BUNDLE_MANIFEST_SCHEMA_V1;
}

/** Trusted location and digest of the bundle manifest. */
export interface WasmBundleLocator {
  /** Path understood by the injected artifact reader. */
  manifestPath: string;
  /** Trusted lowercase SHA-256 digest of the manifest bytes. */
  manifestSha256: string;
}

/** Fully verified bytes passed to a component factory. */
export interface VerifiedWasmBundle {
  /** Parsed and compatibility-checked release-bundle manifest. */
  manifest: Readonly<WasmBundleManifestV1>;
  /** Exact verified manifest bytes. */
  manifestBytes: Uint8Array;
  /** Exact verified source component bytes. */
  sourceBytes: Uint8Array;
  /** Exact verified generated host glue bytes. */
  glueBytes: Uint8Array;
  /** Exact verified core modules keyed by generated module name. */
  coreModuleBytes: ReadonlyMap<string, Uint8Array>;
}

/** Portable control metadata serialized with an ABI v1 request. */
export interface AbiRequestMetadataV1 {
  /** Absolute Unix epoch deadline in milliseconds. */
  deadline_unix_ms?: number;
  /** Opaque cancellation token checked by the host and Go dispatcher. */
  cancellation_token?: string;
  /** Capabilities that must be available before the operation runs. */
  required_capabilities?: string[];
}

/** Version 1 request envelope sent to the component or a native adapter. */
export interface AbiRequestV1 {
  /** Stable ABI discriminator. */
  abi: typeof GOFORGE_ABI_V1;
  /** Stable request ID reused across safe retries. */
  id: string;
  /** Canonical GoForge portable operation. */
  operation: GoforgeAbiOperationV1;
  /** Optional portable execution metadata. */
  metadata?: AbiRequestMetadataV1;
  /** Raw operation-specific JSON payload; binary fields are padded Base64 strings. */
  payload: AbiValue;
}

/** Host-observed state passed separately to GoForge's component dispatch export. */
export interface AbiExecutionStateV1 {
  /** Whether the host actually consulted a clock; false makes deadlines fail closed. */
  clockChecked: boolean;
  /** Host wall-clock reading in Unix epoch milliseconds. */
  nowUnixMilliseconds: number;
  /** Whether the host actually evaluated cancellation for this call. */
  cancellationChecked: boolean;
  /** Token the host checked; must equal the request's `metadata.cancellation_token`. */
  cancellationToken: string;
  /** Whether cancellation was already requested when the guest was entered. */
  cancellationRequested: boolean;
}

/** Structured portable failure returned by GoForge. */
export interface AbiErrorV1 {
  /** Stable lowercase snake_case ABI error code. */
  code: string;
  /** Stable public message from the GoForge error catalog. */
  message: string;
  /** Whether the individual failure is transient. */
  retryable: boolean;
  /** Optional canonical request field associated with the failure. */
  field?: string;
}

/** Successful version 1 response envelope. */
export interface AbiSuccessResponseV1 {
  /** Stable ABI discriminator. */
  abi: typeof GOFORGE_ABI_V1;
  /** Correlation ID echoed from the request. */
  id: string;
  /** Success discriminator. */
  ok: true;
  /** Raw operation-specific JSON result; binary fields are padded Base64 strings. */
  result: AbiValue;
}

/** Failed version 1 response envelope. */
export interface AbiFailureResponseV1 {
  /** Stable ABI discriminator. */
  abi: typeof GOFORGE_ABI_V1;
  /** Correlation ID echoed from the request, or empty when it could not be parsed. */
  id: string;
  /** Failure discriminator. */
  ok: false;
  /** Structured portable failure from the canonical GoForge catalog. */
  error: AbiErrorV1;
}

/** Version 1 response envelope. */
export type AbiResponseV1 = AbiSuccessResponseV1 | AbiFailureResponseV1;

/** Explicit implementation selected for a call. */
export type WasmExecutionTarget =
  | { kind: "component" }
  | { kind: "native"; adapter: string };

/** Per-call lifecycle, routing, and safe-retry options. */
export interface WasmCallOptions {
  /** Caller cancellation signal. */
  signal?: AbortSignal;
  /** Relative timeout in milliseconds. */
  timeoutMs?: number;
  /** Absolute deadline as epoch milliseconds or a Date. */
  deadline?: number | Date;
  /** Explicit execution target; defaults to the component and never changes automatically. */
  target?: WasmExecutionTarget;
  /** Stable request ID; generated when omitted. */
  requestId?: string;
  /** Opaque token serialized as `metadata.cancellation_token`. */
  cancellationToken?: string;
  /** Capabilities serialized as `metadata.required_capabilities`. */
  requiredCapabilities?: readonly string[];
  /** Opt in to retry only when the release and error also mark the call safe. */
  allowRetry?: boolean;
}

/** Bounded retry policy applied only to manifest-qualified transient failures. */
export interface WasmRetryPolicy {
  /** Total attempts including the first; 1 disables retrying. */
  maxAttempts: number;
  /** Delay before the second attempt, doubled per subsequent attempt. */
  initialDelayMs: number;
  /** Upper bound applied to the exponential delay. */
  maxDelayMs: number;
  /** Lowercase snake_case guest error codes eligible for retry. */
  transientCodes: readonly string[];
}

/** Lifecycle state of a runtime instance. */
export type WasmRuntimeState = "idle" | "loading" | "ready" | "degraded" | "closing" | "closed";

/** Immutable runtime health snapshot. */
export interface WasmRuntimeHealth {
  /** Current lifecycle state. */
  state: WasmRuntimeState;
  /** Whether the bundle has completed integrity and compatibility verification. */
  verified: boolean;
  /** Instances currently executing a call. */
  activeInstances: number;
  /** Instances currently held by the pool. */
  totalInstances: number;
  /** Calls waiting for a free instance. */
  queuedCalls: number;
  /** Configured maximum number of simultaneous instances. */
  poolSize: number;
  /** Code of the most recent failure; absent after a success. */
  lastErrorCode?: string;
}

/** Redacted runtime event emitted to an observability hook. */
export interface WasmRuntimeEvent {
  /** Which lifecycle transition this event reports. */
  type:
    | "load.start"
    | "load.success"
    | "load.failure"
    | "call.queued"
    | "call.start"
    | "call.success"
    | "call.failure"
    | "call.retry"
    | "runtime.close";
  /** Host clock reading when the event was emitted, in epoch milliseconds. */
  timestamp: number;
  /** Correlation ID for call-scoped events. */
  requestId?: string;
  /** Canonical operation name for call-scoped events. */
  operation?: string;
  /** Selected implementation, either `component` or `native:<adapter>`. */
  target?: string;
  /** One-based attempt number for call-scoped events. */
  attempt?: number;
  /** Elapsed time for completed load or call events. */
  durationMs?: number;
  /** Stable failure code for failure events. */
  errorCode?: string;
}

/** Receives redacted runtime lifecycle events. */
export type WasmRuntimeObserver = (event: Readonly<WasmRuntimeEvent>) => void;
