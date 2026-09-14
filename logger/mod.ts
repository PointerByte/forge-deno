// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `logger` — structured, sanitizable, leveled logging with HTTP middleware,
 * emitting the GoForge log format.
 *
 * @example
 * ```ts
 * // Run with LOGGER_SENSIBLEKEYS=password,authorization and
 * // --allow-env=LOGGER_SENSIBLEKEYS.
 * import { initLogger, LogLevel } from "@pointerbyte/denoforge/logger";
 *
 * const log = initLogger({
 *   level: LogLevel.Debug,
 *   formatter: "json", // "json", "text" (default) or a custom template
 *   service: { name: "api", version: "1.0.0" },
 * });
 * log.info("user.login", { userId: 42, password: "hunter2" }); // password redacted
 * // {"level":"INFO","timestamp":"2026-07-05T12:00:00.000","traceID":"",
 * //  "message":"user.login","details":{"system":"api","userId":42,
 * //  "password":"[REDACTED]"},"method":"main.ts","line":9,"latency":0}
 * ```
 *
 * HTTP logging can be automatic with `httpLogger(log)`, or emitted directly
 * from a handler so the logger records that handler's call site:
 *
 * @example Direct HTTP logging
 * ```ts
 * const response = Response.json({ ok: true });
 * const entry = buildHttpLogEntry(request, { response }, {
 *   skipPaths: ["/health"],
 *   includeHeaders: false,
 * });
 * if (entry?.level === "error") log.error(entry.message, entry.details);
 * else if (entry) log.info(entry.message, entry.details);
 * return response;
 * ```
 *
 * @module
 */

export * from "./common/enums.ts";
export * from "./formatter/models.ts";
export * from "./formatter/format.ts";
export * from "./sanitizer/sanitizer.ts";
export * from "./sink/file.ts";
export {
  disableModeTest,
  enableModeTest,
  initLogger,
  Logger,
  type LoggerOptions,
  type Sink,
} from "./builder/builder.ts";
export {
  buildHttpLogEntry,
  type Handler,
  type HttpLogEntry,
  type HttpLogEntryOptions,
  httpLogger,
  type HttpLoggerOptions,
  type HttpLogOutcome,
  type Middleware,
  type PathMatcher,
} from "./middlewares/http.ts";
export {
  type GrpcContext,
  grpcLogger,
  type GrpcMetadata,
  type GrpcMetadataValue,
  type GrpcServerCall,
  type ServerInterceptor,
} from "./middlewares/grpc.ts";
