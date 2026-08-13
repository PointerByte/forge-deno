// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `config` — transport bootstrap: a `fetch`-based REST client and a native
 * `Deno.serve` HTTP server, plus a `@grpc/grpc-js`-backed gRPC client/server
 * with an interceptor chain. All come with middleware, graceful shutdown and a
 * shared, composable interceptor/middleware model.
 *
 * @module
 */

// HTTP transport (config/http)
export {
  ClientHTTP,
  type ClientOptions,
  /** Asynchronous function that handles one HTTP request. */
  type Handler,
  HttpClientError,
  httpContext,
  type HttpContextOptions,
  type HttpRequestContext,
  type HttpResponse,
  HttpServer,
  type HttpServerOptions,
  isValidTraceparent,
  isValidTracestate,
  type Method,
  /** Function that wraps an HTTP handler. */
  type Middleware,
  newClientHTTP,
  newHttpServer,
  /** Timed downstream operation included in request logs. */
  type Process,
  type RequestOptions,
  type Rest,
  RouteGroup,
  /** Outcome classification used by traced processes. */
  type Status,
} from "./http/mod.ts";

// gRPC transport (config/grpc)
export {
  type CallOptions,
  GrpcClient,
  /** Per-call context handed to unary handlers and interceptors. */
  type GrpcContext,
  GrpcError,
  /** Structural metadata collection used by dependency-free interceptors. */
  type GrpcMetadata,
  /** String or binary value accepted in gRPC metadata. */
  type GrpcMetadataValue,
  GrpcServer,
  /** Dependency-free view of a unary server call. */
  type GrpcServerCall,
  type GrpcServerOptions,
  type GrpcStatus,
  type GrpcStatusCodes,
  loadProto,
  type LoadProtoOptions,
  newGrpcClient,
  newGrpcServer,
  /** Function that wraps the next unary handler in an interceptor chain. */
  type ServerInterceptor,
  type ServiceHandlers,
  status as grpcStatus,
  unary,
  type UnaryHandler,
} from "./grpc/mod.ts";
