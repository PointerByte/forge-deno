// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Dependency-free contracts shared by gRPC handlers and interceptors.
 *
 * These structural types intentionally describe only the grpc-js surface that
 * middleware needs. Keeping them independent from `@grpc/grpc-js` lets logger
 * and security expose gRPC interceptors without loading the gRPC runtime.
 *
 * @module
 */

/** A metadata value accepted by the gRPC protocol. */
export type GrpcMetadataValue = string | Uint8Array;

/** Structural metadata contract used by gRPC interceptors. */
export interface GrpcMetadata {
  /** Appends a value for a metadata key. */
  add(key: string, value: GrpcMetadataValue): void;
  /** Replaces all values for a metadata key. */
  set(key: string, value: GrpcMetadataValue): void;
  /** Removes every value for a metadata key. */
  remove(key: string): void;
  /** Returns all values associated with a metadata key. */
  get(key: string): GrpcMetadataValue[];
  /** Returns the first value for each metadata key. */
  getMap(): Record<string, GrpcMetadataValue>;
  /** Returns an independent copy of the metadata collection. */
  clone(): GrpcMetadata;
}

/**
 * Structural unary-call contract exposed through {@link GrpcContext}.
 *
 * The grpc-js adapter supplies its native `ServerUnaryCall` here. The
 * structural contract preserves common call inspection without making
 * middleware consumers depend on the runtime package.
 */
export interface GrpcServerCall<Req = unknown> {
  /** Decoded unary request value. */
  readonly request: Req;
  /** Incoming call metadata. */
  readonly metadata: GrpcMetadata;
  /** Whether the peer has cancelled the call. */
  readonly cancelled: boolean;
  /** Returns the call deadline or infinity sentinel. */
  getDeadline(): Date | number;
  /** Returns the authority or host targeted by the call. */
  getHost(): string;
  /** Returns the fully-qualified RPC method path. */
  getPath(): string;
  /** Returns the remote peer description. */
  getPeer(): string;
  /** Sends initial response metadata. */
  sendMetadata(metadata: GrpcMetadata): void;
}

/** Per-call context handed to handlers and interceptors. */
export interface GrpcContext {
  /** Fully-qualified method path, e.g. `/denoforge.v1.Methods/Echo`. */
  readonly method: string;
  /** Inbound request metadata (headers). */
  readonly metadata: GrpcMetadata;
  /** The underlying call through a dependency-free structural contract. */
  readonly call: GrpcServerCall;
  /** Mutable bag for interceptors to pass data downstream (e.g. JWT claims). */
  readonly state: Record<string, unknown>;
}

/** A unary business handler. */
export type UnaryHandler<Req = unknown, Res = unknown> = (
  request: Req,
  ctx: GrpcContext,
) => Res | Promise<Res>;

/** Wraps the next handler in the chain; throw {@link GrpcError} to fail the call. */
export type ServerInterceptor = (
  ctx: GrpcContext,
  next: () => Promise<unknown>,
) => Promise<unknown>;

/** A gRPC error carrying a standard status code. */
export class GrpcError extends Error {
  /** Stable error class name. */
  override name = "GrpcError";

  /** Creates an RPC error carrying a standard numeric status code. */
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

/**
 * Standard gRPC status codes.
 *
 * The numeric values are part of the gRPC wire contract and match
 * `@grpc/grpc-js`'s `status` enum.
 */
export interface GrpcStatusCodes {
  /** Name of status code 0. */
  readonly 0: "OK";
  /** Name of status code 1. */
  readonly 1: "CANCELLED";
  /** Name of status code 2. */
  readonly 2: "UNKNOWN";
  /** Name of status code 3. */
  readonly 3: "INVALID_ARGUMENT";
  /** Name of status code 4. */
  readonly 4: "DEADLINE_EXCEEDED";
  /** Name of status code 5. */
  readonly 5: "NOT_FOUND";
  /** Name of status code 6. */
  readonly 6: "ALREADY_EXISTS";
  /** Name of status code 7. */
  readonly 7: "PERMISSION_DENIED";
  /** Name of status code 8. */
  readonly 8: "RESOURCE_EXHAUSTED";
  /** Name of status code 9. */
  readonly 9: "FAILED_PRECONDITION";
  /** Name of status code 10. */
  readonly 10: "ABORTED";
  /** Name of status code 11. */
  readonly 11: "OUT_OF_RANGE";
  /** Name of status code 12. */
  readonly 12: "UNIMPLEMENTED";
  /** Name of status code 13. */
  readonly 13: "INTERNAL";
  /** Name of status code 14. */
  readonly 14: "UNAVAILABLE";
  /** Name of status code 15. */
  readonly 15: "DATA_LOSS";
  /** Name of status code 16. */
  readonly 16: "UNAUTHENTICATED";
  /** Successful RPC status. */
  readonly OK: 0;
  /** Client-cancelled RPC status. */
  readonly CANCELLED: 1;
  /** Unknown failure status. */
  readonly UNKNOWN: 2;
  /** Invalid request argument status. */
  readonly INVALID_ARGUMENT: 3;
  /** Deadline exceeded status. */
  readonly DEADLINE_EXCEEDED: 4;
  /** Missing resource status. */
  readonly NOT_FOUND: 5;
  /** Existing-resource conflict status. */
  readonly ALREADY_EXISTS: 6;
  /** Authorization failure status. */
  readonly PERMISSION_DENIED: 7;
  /** Resource exhaustion status. */
  readonly RESOURCE_EXHAUSTED: 8;
  /** Failed precondition status. */
  readonly FAILED_PRECONDITION: 9;
  /** Aborted operation status. */
  readonly ABORTED: 10;
  /** Out-of-range argument status. */
  readonly OUT_OF_RANGE: 11;
  /** Unsupported method status. */
  readonly UNIMPLEMENTED: 12;
  /** Internal server failure status. */
  readonly INTERNAL: 13;
  /** Temporarily unavailable service status. */
  readonly UNAVAILABLE: 14;
  /** Unrecoverable data loss status. */
  readonly DATA_LOSS: 15;
  /** Authentication failure status. */
  readonly UNAUTHENTICATED: 16;
}

/** Frozen bidirectional mapping of standard gRPC status names and codes. */
export const status: GrpcStatusCodes = Object.freeze(
  {
    0: "OK",
    1: "CANCELLED",
    2: "UNKNOWN",
    3: "INVALID_ARGUMENT",
    4: "DEADLINE_EXCEEDED",
    5: "NOT_FOUND",
    6: "ALREADY_EXISTS",
    7: "PERMISSION_DENIED",
    8: "RESOURCE_EXHAUSTED",
    9: "FAILED_PRECONDITION",
    10: "ABORTED",
    11: "OUT_OF_RANGE",
    12: "UNIMPLEMENTED",
    13: "INTERNAL",
    14: "UNAVAILABLE",
    15: "DATA_LOSS",
    16: "UNAUTHENTICATED",
    OK: 0,
    CANCELLED: 1,
    UNKNOWN: 2,
    INVALID_ARGUMENT: 3,
    DEADLINE_EXCEEDED: 4,
    NOT_FOUND: 5,
    ALREADY_EXISTS: 6,
    PERMISSION_DENIED: 7,
    RESOURCE_EXHAUSTED: 8,
    FAILED_PRECONDITION: 9,
    ABORTED: 10,
    OUT_OF_RANGE: 11,
    UNIMPLEMENTED: 12,
    INTERNAL: 13,
    UNAVAILABLE: 14,
    DATA_LOSS: 15,
    UNAUTHENTICATED: 16,
  } as const,
);

/** Any standard gRPC status code. */
export type GrpcStatus =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16;
