// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP request/response logging middleware.
 *
 * Targets the native `Request -> Response` handler shape used by `Deno.serve`,
 * so it composes with the {@link Middleware} type from `config/server`. The
 * signature is structural, so no import coupling is needed.
 *
 * @module
 */

import { getRequestContext } from "../../security/middlewares/context.ts";
import type { Logger } from "../builder/builder.ts";
import { normalizeLatency, normalizeProcessLatency } from "../formatter/latency.ts";
import type { Process } from "../formatter/models.ts";

/** Native Deno request handler. */
export type Handler = (req: Request) => Response | Promise<Response>;
/** Handler wrapper, applied outermost-first. */
export type Middleware = (next: Handler) => Handler;

/** A pathname matcher used to exclude operational endpoints from HTTP logs. */
export type PathMatcher = string | RegExp;

/** The response or error produced while handling an HTTP request. */
export type HttpLogOutcome =
  | { response: Response }
  | { error: unknown; status?: number };

/** Common options used by {@link buildHttpLogEntry} and {@link httpLogger}. */
export interface HttpLogEntryOptions {
  /**
   * Header carrying the correlation id surfaced as the entry's `traceID`.
   * Defaults to `x-trace-id` (GoForge's `common.TraceIDHeader`).
   */
  requestIdHeader?: string;
  /** Exact strings or regular expressions matched against the URL pathname only. */
  skipPaths?: readonly PathMatcher[];
  /** Post-handler predicate. Throwing suppresses the log without changing the outcome. */
  shouldLog?: (request: Request, outcome: HttpLogOutcome) => boolean;
  /** Include request headers in `details`. Defaults to true for compatibility. */
  includeHeaders?: boolean;
  /** Monotonic start time, normally supplied by middleware or request context. */
  startedAt?: number;
  /** Downstream processes to place in the logger's canonical `process` field. */
  process?: readonly Process[];
}

/** Options for {@link httpLogger}. */
export type HttpLoggerOptions = HttpLogEntryOptions;

/** A side-effect-free HTTP log description ready for an explicit logger call. */
export interface HttpLogEntry {
  /** Logger method that should receive the entry. */
  level: "info" | "error";
  /** Stable event name. */
  message: string;
  /** Canonical structured attributes for the event. */
  details: Record<string, unknown>;
}

interface StoredHttpContext {
  requestId?: string;
  startedAt?: number;
  attributes?: Record<string, unknown>;
  process?: Process[];
  skipLogging?: boolean;
}

/**
 * Builds the canonical attributes for one HTTP log without invoking a logger,
 * altering the outcome, or reading either body.
 */
export function buildHttpLogEntry(
  request: Request,
  outcome: HttpLogOutcome,
  options: HttpLogEntryOptions = {},
): HttpLogEntry | undefined {
  const pathname = new URL(request.url).pathname;
  if (matchesSkippedPath(pathname, options.skipPaths)) return undefined;

  const context = getRequestContext<StoredHttpContext>(request);
  if (context?.skipLogging) return undefined;

  try {
    if (options.shouldLog && !options.shouldLog(request, outcome)) return undefined;
  } catch {
    return undefined;
  }

  const idHeader = options.requestIdHeader ?? "x-trace-id";
  const traceID = request.headers.get(idHeader) ?? context?.requestId;
  const startedAt = options.startedAt ?? context?.startedAt;
  const latency = startedAt === undefined ? 0 : normalizeLatency(performance.now() - startedAt);
  const process = options.process ?? context?.process;
  const details: Record<string, unknown> = {
    ...(context?.attributes ?? {}),
    method: request.method,
    path: pathname,
    ...(options.includeHeaders === false ? {} : { headers: request.headers }),
    latency,
    ...(traceID ? { traceID } : {}),
    ...(process?.length ? { process: process.map((item) => normalizeProcessLatency(item)) } : {}),
  };

  // Context attributes are service-owned, but `includeHeaders: false` is a
  // hard privacy boundary for this entry. Do not let an attribute accidentally
  // reintroduce the request headers when a consumer opts out.
  if (options.includeHeaders === false) delete details.headers;

  if ("response" in outcome) {
    details.status = outcome.response.status;
    return { level: "info", message: "http.request", details };
  }

  if (outcome.status !== undefined) details.status = outcome.status;
  details.error = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
  return { level: "error", message: "http.request.error", details };
}

/**
 * Returns a middleware that logs one structured line per request. The request
 * method, path and headers land in `details` and the elapsed time in the
 * top-level `latency`, mirroring GoForge's HTTP middleware log shape.
 * Failures are logged at error level and re-thrown so downstream error
 * handling still runs.
 */
export function httpLogger(logger: Logger, options: HttpLoggerOptions = {}): Middleware {
  return (next) => async (req) => {
    const startedAt = performance.now();
    try {
      const res = await next(req);
      emit(logger, buildHttpLogEntry(req, { response: res }, { ...options, startedAt }));
      return res;
    } catch (err) {
      emit(logger, buildHttpLogEntry(req, { error: err }, { ...options, startedAt }));
      throw err;
    }
  };
}

function emit(logger: Logger, entry: HttpLogEntry | undefined): void {
  if (!entry) return;
  if (entry.level === "error") logger.error(entry.message, entry.details);
  else logger.info(entry.message, entry.details);
}

function matchesSkippedPath(
  pathname: string,
  matchers: readonly PathMatcher[] | undefined,
): boolean {
  return matchers?.some((matcher) => {
    if (typeof matcher === "string") return pathname === matcher;
    const flags = matcher.flags.replaceAll("g", "").replaceAll("y", "");
    return new RegExp(matcher.source, flags).test(pathname);
  }) ?? false;
}
