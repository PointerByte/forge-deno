// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `security` — JWT services, cookie auth and HTTP security middleware.
 *
 * @example
 * ```ts
 * import { createService, jwtMiddleware } from "@pointerbyte/denoforge/security";
 *
 * const jwt = createService({ algorithm: "HS256", hmacSecret: "s3cr3t" });
 * const token = await jwt.sign({ sub: "user-1", role: "admin" });
 * const auth = jwtMiddleware(jwt);
 * ```
 *
 * @module
 */

export * from "./auth/jwt/jwt.ts";
export * from "./auth/cookies/cookies.ts";
export {
  getClaims,
  getRequestContext,
  type Handler,
  type Middleware,
  setClaims,
  setRequestContext,
  unauthorized,
} from "./middlewares/context.ts";
export { securityHeaders, type SecurityHeadersOptions } from "./middlewares/headers.ts";
export { jwtMiddleware, type JWTMiddlewareOptions } from "./middlewares/jwt.ts";
export { cookieMiddleware } from "./middlewares/cookies.ts";
export {
  grpcClaims,
  type GrpcContext,
  grpcJwtInterceptor,
  type GrpcJWTOptions,
  type GrpcMetadata,
  type GrpcMetadataValue,
  type GrpcServerCall,
  type ServerInterceptor,
} from "./middlewares/grpc_jwt.ts";
