// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * gRPC unary JWT authentication interceptor.
 *
 * Reads a `Bearer` token from the call's `authorization` metadata, verifies it
 * with a JWT {@link Service}, stores the claims on `ctx.state.claims` for
 * downstream handlers, and fails the RPC with `UNAUTHENTICATED` otherwise. Read
 * the claims with {@link grpcClaims}.
 *
 * @module
 */

import {
  type GrpcContext,
  GrpcError,
  type ServerInterceptor,
  status,
} from "../../config/grpc/contracts.ts";
import type { Service, Validator } from "../auth/jwt/jwt.ts";

export type {
  GrpcContext,
  GrpcMetadata,
  GrpcMetadataValue,
  GrpcServerCall,
  ServerInterceptor,
} from "../../config/grpc/contracts.ts";

const CLAIMS_KEY = "claims";

/** Options for {@link grpcJwtInterceptor}. */
export interface GrpcJWTOptions {
  /** Metadata key to read. Defaults to `authorization`. */
  metadataKey?: string;
  /** Scheme prefix to strip. Defaults to `Bearer`. */
  scheme?: string;
  /** Extra validators run on every request. */
  validators?: Validator[];
}

/** Returns an interceptor enforcing a valid bearer JWT on each unary RPC. */
export function grpcJwtInterceptor(
  service: Service,
  options: GrpcJWTOptions = {},
): ServerInterceptor {
  const key = options.metadataKey ?? "authorization";
  const scheme = (options.scheme ?? "Bearer").toLowerCase();
  const validators = options.validators ?? [];

  return async (ctx: GrpcContext, next) => {
    const raw = String(ctx.metadata.get(key)[0] ?? "");
    if (!raw) throw new GrpcError(status.UNAUTHENTICATED, "authorization metadata is required");

    const [prefix, token] = raw.split(" ", 2);
    if (!token || prefix.toLowerCase() !== scheme) {
      throw new GrpcError(status.UNAUTHENTICATED, "invalid authorization scheme");
    }

    try {
      const verified = await service.verify(token, ...validators);
      ctx.state[CLAIMS_KEY] = verified.claims;
    } catch {
      throw new GrpcError(status.UNAUTHENTICATED, "invalid or expired token");
    }
    return next();
  };
}

/** Returns the verified claims stored by {@link grpcJwtInterceptor}, if any. */
export function grpcClaims<T = Record<string, unknown>>(ctx: GrpcContext): T | undefined {
  return ctx.state[CLAIMS_KEY] as T | undefined;
}
