// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `config/grpc` — focused gRPC transport bootstrap.
 *
 * This entry point provides proto loading, the grpc-js client/server runtime
 * adapter, and dependency-free handler/interceptor contracts. Importing it
 * intentionally loads `@grpc/grpc-js` and `@grpc/proto-loader`.
 *
 * @example
 * ```ts
 * import { GrpcServer, loadProto } from "@pointerbyte/denoforge/config/grpc";
 *
 * const proto = loadProto(new URL("../proto/methods.proto", import.meta.url));
 * // deno-lint-ignore no-explicit-any
 * const Methods = (proto.denoforge as any).v1.Methods;
 * const server = new GrpcServer();
 * server.addService(Methods.service, {
 *   Echo: (request) => request,
 * });
 * ```
 *
 * @module
 */

// Dependency-free contracts (config/grpc)
export {
  type GrpcContext,
  GrpcError,
  type GrpcMetadata,
  type GrpcMetadataValue,
  type GrpcServerCall,
  type GrpcStatus,
  type GrpcStatusCodes,
  type ServerInterceptor,
  status,
  status as grpcStatus,
  type UnaryHandler,
} from "./contracts.ts";

// Proto loading (config/proto)
export { loadProto, type LoadProtoOptions } from "../proto/loader.ts";

// gRPC runtime adapter (config/server/grpc)
export { unary } from "../server/grpc/interceptors.ts";
export {
  GrpcServer,
  type GrpcServerOptions,
  newGrpcServer,
  type ServiceHandlers,
} from "../server/grpc/server.ts";

// gRPC client (config/client/grpc)
export { type CallOptions, GrpcClient, newGrpcClient } from "../client/grpc/client.ts";
