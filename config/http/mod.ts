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
export type { Rest } from "../client/http/interface.ts";
export {
  type ClientOptions,
  HttpClientError,
  type HttpResponse,
  type RequestOptions,
} from "../client/http/models.ts";
export { ClientHTTP, newClientHTTP } from "../client/http/client.ts";

// HTTP server (config/server/http)
export {
  type Handler,
  HttpServer,
  type HttpServerOptions,
  type Method,
  type Middleware,
  newHttpServer,
  RouteGroup,
} from "../server/http/server.ts";
export {
  httpContext,
  type HttpContextOptions,
  type HttpRequestContext,
  isValidTraceparent,
  isValidTracestate,
  type Process,
  type Status,
} from "../server/http/context.ts";
