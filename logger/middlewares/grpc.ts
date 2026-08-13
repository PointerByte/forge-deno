// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * gRPC unary logging interceptor.
 *
 * Logs one structured line per RPC with the method in `details`, the outcome
 * and the elapsed time in the top-level `latency`, mirroring GoForge's gRPC
 * interceptor log shape. It is a {@link ServerInterceptor}, so it plugs into a
 * {@link GrpcServer}'s interceptor chain exactly like {@link httpLogger} plugs
 * into the HTTP one.
 *
 * @module
 */

import type { GrpcContext, ServerInterceptor } from "../../config/grpc/contracts.ts";
import type { Logger } from "../builder/builder.ts";

export type {
  GrpcContext,
  GrpcMetadata,
  GrpcMetadataValue,
  GrpcServerCall,
  ServerInterceptor,
} from "../../config/grpc/contracts.ts";

/** Returns an interceptor that logs each unary RPC via `logger`. */
export function grpcLogger(logger: Logger): ServerInterceptor {
  return async (ctx: GrpcContext, next) => {
    const start = performance.now();
    try {
      const res = await next();
      logger.info("grpc.request", {
        method: ctx.method,
        status: "OK",
        latency: Math.round(performance.now() - start),
      });
      return res;
    } catch (err) {
      logger.error("grpc.request.error", {
        method: ctx.method,
        latency: Math.round(performance.now() - start),
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };
}
