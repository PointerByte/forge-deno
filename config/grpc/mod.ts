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
  /** Creates SERVER spans and propagates W3C context for unary RPCs. */
  grpcTelemetry,
} from "../../telemetry/grpc.ts";
export type { GrpcMetadataCarrier } from "../../telemetry/grpc.ts";

export {
  /** Per-call context handed to unary handlers and interceptors. */
  type GrpcContext,
  /** RPC failure carrying a standard gRPC status code. */
  GrpcError,
  /** Structural metadata collection used by dependency-free interceptors. */
  type GrpcMetadata,
  /** String or binary value accepted in gRPC metadata. */
  type GrpcMetadataValue,
  /** Dependency-free view of a unary server call. */
  type GrpcServerCall,
  /** Union of the standard numeric gRPC status codes. */
  type GrpcStatus,
  /** Bidirectional mapping contract for gRPC status names and codes. */
  type GrpcStatusCodes,
  /** Function that wraps the next unary handler in an interceptor chain. */
  type ServerInterceptor,
  /** Frozen bidirectional mapping of gRPC status names and codes. */
  status,
  /** Alias for {@link status} that avoids collisions in aggregated imports. */
  status as grpcStatus,
  /** Unary business-handler contract with a request context. */
  type UnaryHandler,
} from "./contracts.ts";

// Proto loading (config/proto)
export {
  /** Loads a `.proto` file into a grpc-js package object. */
  loadProto,
  /** Field, numeric, enum, default, and import options for proto loading. */
  type LoadProtoOptions,
} from "../proto/loader.ts";

// gRPC runtime adapter (config/server/grpc)
export {
  /** Composes a unary handler and interceptors into a grpc-js handler. */
  unary,
} from "../server/grpc/interceptors.ts";
export {
  /** Ergonomic grpc-js server wrapper with interceptor support. */
  GrpcServer,
  /** Global interceptor options for a gRPC server. */
  type GrpcServerOptions,
  /** Creates a gRPC server wrapper. */
  newGrpcServer,
  /** Map from service method names to unary handlers. */
  type ServiceHandlers,
} from "../server/grpc/server.ts";

// gRPC client (config/client/grpc)
export {
  /** Metadata, bearer token, and deadline options for one unary call. */
  type CallOptions,
  /** Promisified gRPC client wrapper for a generated service. */
  GrpcClient,
  /** Client-level options for built-in OpenTelemetry instrumentation. */
  type GrpcClientOptions,
  /** Creates a promisified gRPC client wrapper. */
  newGrpcClient,
} from "../client/grpc/client.ts";
