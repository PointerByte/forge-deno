// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/** Stable error codes emitted by the GoForge component runtime. */
export const WasmErrorCode = {
  ManifestInvalid: "WASM_MANIFEST_INVALID",
  IntegrityFailed: "WASM_INTEGRITY_FAILED",
  Incompatible: "WASM_INCOMPATIBLE",
  CodecInvalid: "WASM_CODEC_INVALID",
  Closed: "WASM_CLOSED",
  Cancelled: "WASM_CANCELLED",
  DeadlineExceeded: "WASM_DEADLINE_EXCEEDED",
  PoolUnavailable: "WASM_POOL_UNAVAILABLE",
  AdapterRejected: "WASM_ADAPTER_REJECTED",
  InvocationFailed: "WASM_INVOCATION_FAILED",
  GuestFailed: "WASM_GUEST_FAILED",
  CapabilityDenied: "WASM_CAPABILITY_DENIED",
} as const;

/** A stable GoForge component runtime error code. */
export type WasmErrorCode = typeof WasmErrorCode[keyof typeof WasmErrorCode];

/** Runtime stage at which a component call failed. */
export type WasmErrorStage =
  | "manifest"
  | "integrity"
  | "compatibility"
  | "codec"
  | "lifecycle"
  | "pool"
  | "adapter"
  | "invoke"
  | "guest"
  | "capability";

/** Base class for all stable component runtime failures. */
export class WasmRuntimeError extends Error {
  /** Machine-readable error code. */
  readonly code: WasmErrorCode | string;
  /** Runtime stage that failed. */
  readonly stage: WasmErrorStage;
  /** Whether the individual error is transient. Retry policy is evaluated separately. */
  readonly retryable: boolean;

  /** Creates a typed runtime error. */
  constructor(
    code: WasmErrorCode | string,
    stage: WasmErrorStage,
    message: string,
    options: { cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WasmRuntimeError";
    this.code = code;
    this.stage = stage;
    this.retryable = options.retryable ?? false;
  }
}

/** Indicates that a manifest is malformed or violates the versioned schema. */
export class WasmManifestError extends WasmRuntimeError {
  /** Creates a manifest validation error. */
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(WasmErrorCode.ManifestInvalid, "manifest", message, options);
    this.name = "WasmManifestError";
  }
}

/** Indicates that a manifest or artifact digest does not match its trusted digest. */
export class WasmIntegrityError extends WasmRuntimeError {
  /** Creates an artifact integrity error. */
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(WasmErrorCode.IntegrityFailed, "integrity", message, options);
    this.name = "WasmIntegrityError";
  }
}

/** Indicates an unsupported schema, ABI, component, or WIT version. */
export class WasmCompatibilityError extends WasmRuntimeError {
  /** Creates a compatibility error. */
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(WasmErrorCode.Incompatible, "compatibility", message, options);
    this.name = "WasmCompatibilityError";
  }
}

/** Indicates invalid JSON ABI data or an unsupported JavaScript value. */
export class WasmCodecError extends WasmRuntimeError {
  /** Creates a codec error. */
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(WasmErrorCode.CodecInvalid, "codec", message, options);
    this.name = "WasmCodecError";
  }
}

/** Indicates that the runtime has begun or completed shutdown. */
export class WasmClosedError extends WasmRuntimeError {
  /** Creates a closed-runtime error. */
  constructor(
    message = "the GoForge component runtime is closed",
    options: { cause?: unknown } = {},
  ) {
    super(WasmErrorCode.Closed, "lifecycle", message, options);
    this.name = "WasmClosedError";
  }
}

/** Indicates caller-requested cancellation. */
export class WasmCancelledError extends WasmRuntimeError {
  /** Creates a cancellation error without exposing the caller's abort reason. */
  constructor(message = "the GoForge component call was cancelled") {
    super(WasmErrorCode.Cancelled, "lifecycle", message);
    this.name = "WasmCancelledError";
  }
}

/** Indicates that a configured call deadline elapsed. */
export class WasmDeadlineExceededError extends WasmRuntimeError {
  /** Creates a deadline error. */
  constructor(message = "the GoForge component call exceeded its deadline") {
    super(WasmErrorCode.DeadlineExceeded, "lifecycle", message);
    this.name = "WasmDeadlineExceededError";
  }
}

/** Indicates that an instance could not be acquired or created. */
export class WasmPoolError extends WasmRuntimeError {
  /** Creates an instance-pool error. */
  constructor(message: string, options: { cause?: unknown; retryable?: boolean } = {}) {
    super(WasmErrorCode.PoolUnavailable, "pool", message, options);
    this.name = "WasmPoolError";
  }
}

/** Indicates that an explicitly selected native adapter is not eligible. */
export class WasmAdapterError extends WasmRuntimeError {
  /** Creates an adapter policy or execution error. */
  constructor(message: string, options: { cause?: unknown; retryable?: boolean } = {}) {
    super(WasmErrorCode.AdapterRejected, "adapter", message, options);
    this.name = "WasmAdapterError";
  }
}

/** Indicates that component glue trapped or rejected outside the stable guest error envelope. */
export class WasmInvocationError extends WasmRuntimeError {
  /** Creates an invocation error. */
  constructor(message: string, options: { cause?: unknown; retryable?: boolean } = {}) {
    super(WasmErrorCode.InvocationFailed, "invoke", message, options);
    this.name = "WasmInvocationError";
  }
}

/**
 * Indicates that the guest requested a WASI capability this host deliberately withholds.
 *
 * GoForge's portable core never needs process, terminal, or filesystem authority, so reaching this
 * error means the component tried to exceed its contract. The host fails closed rather than
 * granting the capability.
 */
export class WasmCapabilityDeniedError extends WasmRuntimeError {
  /** The denied WASI interface or function. */
  readonly capability: string;

  /** Creates a denied-capability error. */
  constructor(capability: string, options: { cause?: unknown } = {}) {
    super(
      WasmErrorCode.CapabilityDenied,
      "capability",
      `the GoForge component host denies the ${capability} capability`,
      options,
    );
    this.name = "WasmCapabilityDeniedError";
    this.capability = capability;
  }
}

/** A structured error returned by the GoForge guest. */
export class WasmGuestError extends WasmRuntimeError {
  /** Optional canonical request field supplied by the GoForge ABI error. */
  readonly field?: string;

  /** Creates a guest error while retaining its cross-runtime code. */
  constructor(
    code: string,
    message: string,
    options: { field?: string; retryable?: boolean } = {},
  ) {
    super(code || WasmErrorCode.GuestFailed, "guest", message, {
      retryable: options.retryable,
    });
    this.name = "WasmGuestError";
    this.field = options.field;
  }
}
