// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Request-scoped HTTP context and W3C trace propagation middleware.
 *
 * @module
 */

import { type Middleware, setRequestContext } from "../../../security/middlewares/context.ts";
import type { Process } from "../../../logger/formatter/models.ts";
import { context as otelContext } from "@opentelemetry/api";
import { activeSpanContext, traceparent as spanTraceparent } from "../../../telemetry/mod.ts";
import { extractContext } from "../../../telemetry/internal.ts";

export type { Process, Status } from "../../../logger/formatter/models.ts";

/** Safe metadata made available to handlers for the lifetime of a request. */
export interface HttpRequestContext {
  /** Correlation identifier read from or written to the configured header. */
  requestId: string;
  /** W3C traceparent value surfaced for the active request span. */
  traceparent: string;
  /** Trace identifier surfaced for the active request span. */
  traceId: string;
  /** Span identifier surfaced for the active request span. */
  spanId: string;
  /** Trace flags parsed from `traceparent`. */
  traceFlags: string;
  /** Valid incoming W3C tracestate value, when supplied. */
  tracestate?: string;
  /** Monotonic timestamp from `performance.now()`. */
  startedAt: number;
  /** Incoming HTTP method. */
  method: string;
  /** Incoming URL pathname. */
  pathname: string;
  /** Safe application-owned attributes available to middleware. */
  attributes: Record<string, unknown>;
  /** Downstream processes to include in request logging. */
  process: Process[];
  /** Whether request logging should be suppressed. */
  skipLogging: boolean;
}

/** Options for {@link httpContext}. */
export interface HttpContextOptions {
  /** Request/response header carrying the request id. Defaults to `x-request-id`. */
  requestIdHeader?: string;
  /** Generates an id when the request does not provide one. Defaults to `crypto.randomUUID`. */
  requestIdFactory?: (request: Request) => string;
  /** Safe initial attributes; headers and bodies are never copied automatically. */
  attributes?:
    | Record<string, unknown>
    | ((request: Request) => Record<string, unknown>);
}

/**
 * Creates request context with a request id, validated W3C trace data and a
 * monotonic start time. When Deno has an ambient OpenTelemetry span, its
 * context wins and handlers execute inside the same context. Handlers retrieve
 * it with `getRequestContext`.
 */
export function httpContext(options: HttpContextOptions = {}): Middleware {
  const requestIdHeader = options.requestIdHeader ?? "x-request-id";
  return (next) => async (request) => {
    const incomingTraceparent = request.headers.get("traceparent");
    const hasValidTraceparent = Boolean(
      incomingTraceparent && isValidTraceparent(incomingTraceparent),
    );
    const extracted = extractContext(request.headers, {
      keys: (headers) => [...headers.keys()],
      get: (headers, key) => headers.get(key) ?? undefined,
    });
    const ambientTraceparent = spanTraceparent(activeSpanContext());
    const traceparent = ambientTraceparent ??
      (hasValidTraceparent ? incomingTraceparent! : newTraceparent());
    const [, traceId, spanId, traceFlags] = traceparent.split("-");
    const incomingTracestate = request.headers.get("tracestate");
    const suppliedRequestId = request.headers.get(requestIdHeader)?.trim();
    const generatedRequestId = options.requestIdFactory?.(request)?.trim();
    const requestId = suppliedRequestId || generatedRequestId || crypto.randomUUID();
    const attributes = typeof options.attributes === "function"
      ? options.attributes(request)
      : options.attributes;

    const context: HttpRequestContext = {
      requestId,
      traceparent,
      traceId,
      spanId,
      traceFlags,
      ...(hasValidTraceparent && incomingTracestate && isValidTracestate(incomingTracestate)
        ? { tracestate: incomingTracestate }
        : {}),
      startedAt: performance.now(),
      method: request.method,
      pathname: new URL(request.url).pathname,
      attributes: { ...(attributes ?? {}) },
      process: [],
      skipLogging: false,
    };
    setRequestContext(request, context);

    // Deno's Deno.serve instrumentation already activates the SERVER span.
    // Only use extracted propagation when the handler is invoked outside that
    // instrumentation (for example in a unit test or a custom host adapter).
    const executionContext = ambientTraceparent ? otelContext.active() : extracted;
    const response = await otelContext.with(executionContext, () => next(request));
    return setResponseHeader(response, requestIdHeader, requestId);
  };
}

/** Validates the W3C `traceparent` wire format. */
export function isValidTraceparent(value: string): boolean {
  const match = value.match(
    /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/,
  );
  if (!match) return false;
  const [, version, traceId, parentId] = match;
  return version !== "ff" &&
    traceId !== "00000000000000000000000000000000" &&
    parentId !== "0000000000000000";
}

/** Validates the W3C `tracestate` list syntax and size limits. */
export function isValidTracestate(value: string): boolean {
  if (value.length === 0 || value.length > 512 || value.trim() !== value) return false;
  const members = value.split(",");
  if (members.length > 32) return false;
  const keys = new Set<string>();
  for (const rawMember of members) {
    const member = rawMember.trim();
    const separator = member.indexOf("=");
    if (separator <= 0 || separator !== member.lastIndexOf("=")) return false;
    const key = member.slice(0, separator);
    const itemValue = member.slice(separator + 1);
    if (!isValidTracestateKey(key) || !isValidTracestateValue(itemValue) || keys.has(key)) {
      return false;
    }
    keys.add(key);
  }
  return true;
}

function isValidTracestateKey(key: string): boolean {
  return /^[a-z][a-z0-9_\-]{0,255}$/.test(key) ||
    /^[a-z0-9][a-z0-9_\-]{0,240}@[a-z][a-z0-9_\-]{0,13}$/.test(key);
}

function isValidTracestateValue(value: string): boolean {
  return value.length > 0 &&
    value.length <= 256 &&
    value[0] !== " " &&
    value[value.length - 1] !== " " &&
    /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]+$/.test(value);
}

function newTraceparent(): string {
  return `00-${randomNonZeroHex(16)}-${randomNonZeroHex(8)}-01`;
}

function randomNonZeroHex(size: number): string {
  let value: string;
  do {
    const bytes = crypto.getRandomValues(new Uint8Array(size));
    value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } while (/^0+$/.test(value));
  return value;
}

function setResponseHeader(response: Response, name: string, value: string): Response {
  try {
    response.headers.set(name, value);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set(name, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
