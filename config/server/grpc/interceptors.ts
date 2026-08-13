// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side unary interceptors and the handler composer.
 *
 * gRPC handlers are wrapped with an interceptor chain analogous to a server
 * middleware stack: each {@link ServerInterceptor} runs around the next one and
 * can short-circuit (e.g. auth) by throwing a {@link GrpcError}. {@link unary}
 * turns a plain `(request, ctx) => response` handler plus interceptors into a
 * `@grpc/grpc-js`-compatible unary handler.
 *
 * @module
 */

import grpc from "@grpc/grpc-js";
import {
  type GrpcContext,
  GrpcError,
  type GrpcMetadata,
  type GrpcServerCall,
  type ServerInterceptor,
  type UnaryHandler,
} from "../../grpc/contracts.ts";

// Preserve the existing direct-module exports while the implementation below
// remains the grpc-js runtime adapter.
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
  type UnaryHandler,
} from "../../grpc/contracts.ts";

/** Maps an arbitrary thrown value to a grpc-js service error. */
function toServiceError(err: unknown): grpc.ServiceError {
  if (err instanceof GrpcError) {
    return Object.assign(new Error(err.message), { code: err.code }) as grpc.ServiceError;
  }
  const message = err instanceof Error ? err.message : String(err);
  return Object.assign(new Error(message), { code: grpc.status.INTERNAL }) as grpc.ServiceError;
}

/**
 * Composes a unary handler with interceptors into a grpc-js handler. The
 * interceptors run outermost-first, exactly like HTTP middleware.
 */
export function unary<Req, Res>(
  handler: UnaryHandler<Req, Res>,
  ...interceptors: ServerInterceptor[]
): grpc.handleUnaryCall<Req, Res> {
  return (call: grpc.ServerUnaryCall<Req, Res>, callback: grpc.sendUnaryData<Res>) => {
    const ctx: GrpcContext = {
      method: call.getPath?.() ?? "",
      metadata: call.metadata as unknown as GrpcMetadata,
      call: call as unknown as GrpcServerCall,
      state: {},
    };
    const invoke = () => Promise.resolve().then(() => handler(call.request, ctx));
    const chain = interceptors.reduceRight<() => Promise<unknown>>(
      (next, interceptor) => () => interceptor(ctx, next),
      invoke,
    );
    // Defer into a microtask so a synchronous throw anywhere in the chain
    // becomes a rejection routed to the callback instead of escaping.
    Promise.resolve().then(chain).then(
      (res) => callback(null, res as Res),
      (err) => callback(toServiceError(err), null),
    );
  };
}
