// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `config/http` — dependency-focused HTTP transport bootstrap.
 *
 * This entry point provides the `fetch` REST client, native `Deno.serve`
 * server, routing, middleware and request context without loading the optional
 * gRPC runtime or proto loader.
 *
 * @example
 * ```ts
 * import { newHttpServer } from "@pointerbyte/denoforge/config/http";
 *
 * const server = newHttpServer({ healthPath: "" });
 * server.get("/ping", () => Response.json({ pong: true }));
 * const response = await server.handler()(new Request("http://localhost/ping"));
 * console.log(await response.json());
 * ```
 *
 * @module
 */

// HTTP client (config/client/http)
export type {
  /** Typed contract implemented by the HTTP client. */
  Rest,
} from "../client/http/interface.ts";
export {
  /** Defaults shared by every request issued by an HTTP client. */
  type ClientOptions,
  /** Error raised when an HTTP request cannot complete. */
  HttpClientError,
  /** Typed status, headers, and decoded body returned by the client. */
  type HttpResponse,
  /** Headers, query values, cancellation, and timeout for one request. */
  type RequestOptions,
} from "../client/http/models.ts";
export {
  /** Default `fetch`-based implementation of the REST client. */
  ClientHTTP,
  /** Creates a `fetch`-based REST client. */
  newClientHTTP,
} from "../client/http/client.ts";

// HTTP server (config/server/http)
export {
  /** Asynchronous function that handles one HTTP request. */
  type Handler,
  /** Native `Deno.serve` router with middleware and graceful shutdown. */
  HttpServer,
  /** Listener, health-endpoint, and middleware options for an HTTP server. */
  type HttpServerOptions,
  /** HTTP methods accepted by the router. */
  type Method,
  /** Function that wraps an HTTP handler. */
  type Middleware,
  /** Creates a native HTTP server and router. */
  newHttpServer,
  /** Prefix and middleware scope used to register related routes. */
  RouteGroup,
} from "../server/http/server.ts";
export {
  /** Creates request context and propagates validated W3C trace headers. */
  httpContext,
  /** Request-id and initial-attribute options for HTTP context middleware. */
  type HttpContextOptions,
  /** Safe request-scoped metadata exposed to handlers and middleware. */
  type HttpRequestContext,
  /** Validates the W3C `traceparent` wire format. */
  isValidTraceparent,
  /** Validates the W3C `tracestate` list syntax and size limits. */
  isValidTracestate,
  /** Timed downstream operation included in request logs. */
  type Process,
  /** Outcome classification used by traced processes. */
  type Status,
} from "../server/http/context.ts";
