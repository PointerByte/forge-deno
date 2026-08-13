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
  type Middleware,
  newClientHTTP,
  newHttpServer,
  type Process,
  type RequestOptions,
  type Rest,
  RouteGroup,
  type Status,
} from "./http/mod.ts";

// gRPC transport (config/grpc)
export {
  type CallOptions,
  GrpcClient,
  type GrpcContext,
  GrpcError,
  type GrpcMetadata,
  type GrpcMetadataValue,
  GrpcServer,
  type GrpcServerCall,
  type GrpcServerOptions,
  type GrpcStatus,
  type GrpcStatusCodes,
  loadProto,
  type LoadProtoOptions,
  newGrpcClient,
  newGrpcServer,
  type ServerInterceptor,
  type ServiceHandlers,
  status as grpcStatus,
  unary,
  type UnaryHandler,
} from "./grpc/mod.ts";
