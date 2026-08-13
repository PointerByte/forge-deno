// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Structured log models (mirrors GoForge `formatter/models.go` + `enums.go`).
 *
 * A {@link LogFormat} entry is what every formatter receives; its JSON keys —
 * including the `process` spelling — match the GoForge wire format exactly.
 *
 * @module
 */

/** Outcome of a traced process, classified from its status code. */
export const Status = {
  /** The process completed successfully (2xx-equivalent). */
  Success: "SUCCESS",
  /** The process failed because of the server (5xx-equivalent). */
  Error: "ERROR",
  /** The process failed because of the caller (4xx-equivalent). */
  ClientError: "CLIENT_ERROR",
  /** The process finished with a status that fits no other class. */
  Other: "OTHER",
  /** No status code was recorded for the process. */
  Unknown: "UNKNOWN",
} as const;
/** Union of process status values. */
export type Status = (typeof Status)[keyof typeof Status];

/** Request-scoped details attached to a log entry. */
export interface Details {
  /** Service or subsystem that produced the entry. */
  system: string;
  /** Calling client identifier, when known. */
  client?: string;
  /** Transport protocol, such as HTTP or gRPC. */
  protocol?: string;
  /** Request or operation method. */
  method?: string;
  /** Request or resource path. */
  path?: string;
  /** Sanitized request headers. */
  headers?: Record<string, unknown>;
  /** Sanitized request payload. */
  request?: unknown;
  /** Sanitized response payload. */
  response?: unknown;
  /** Unrecognized log attributes are merged here as extra keys. */
  [key: string]: unknown;
}

/** A traced downstream call or internal subprocess. */
export interface Process {
  /** Correlation trace identifier. */
  traceID?: string;
  /** Correlation span identifier. */
  spanID?: string;
  /** Downstream system name. */
  system?: string;
  /** Downstream process or operation name. */
  process?: string;
  /** Downstream server address. */
  server?: string;
  /** Sanitized downstream headers. */
  headers?: Record<string, unknown>;
  /** Downstream transport protocol. */
  protocol?: string;
  /** Downstream request method. */
  method?: string;
  /** Downstream response or status code. */
  code?: number;
  /** Downstream resource path. */
  path?: string;
  /** Sanitized downstream request payload. */
  request?: unknown;
  /** Sanitized downstream response payload. */
  response?: unknown;
  /** Classified downstream outcome. */
  status?: Status | string;
  /** Elapsed downstream time in milliseconds. */
  latency?: number;
}

/** A structured log entry ready to be formatted. */
export interface LogFormat {
  /** Uppercase severity name. */
  level: string;
  /** Formatted local timestamp. */
  timestamp: string;
  /** Correlation trace identifier. */
  traceID: string;
  /** Human-readable event message. */
  message: string;
  /** Request-scoped structured attributes. */
  details: Details;
  /** Downstream calls or subprocesses. */
  process: Process[];
  /** Calling function or file. */
  method: string;
  /** Calling source line. */
  line: number;
  /** Elapsed operation time in milliseconds. */
  latency: number;
}
