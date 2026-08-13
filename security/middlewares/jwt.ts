// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bearer-token JWT authentication middleware.
 *
 * Extracts a `Bearer` token from the `Authorization` header, verifies it with
 * a JWT {@link Service}, stashes the claims for downstream handlers via
 * {@link setClaims}, and returns 401 on failure.
 *
 * @module
 */

import type { Service, Validator } from "../auth/jwt/jwt.ts";
import { type Middleware, setClaims, unauthorized } from "./context.ts";

/** Options for {@link jwtMiddleware}. */
export interface JWTMiddlewareOptions {
  /** Header to read the token from. Defaults to `Authorization`. */
  header?: string;
  /** Scheme prefix to strip. Defaults to `Bearer`. */
  scheme?: string;
  /** Extra validators run on every request. */
  validators?: Validator[];
}

/** Returns a middleware enforcing a valid bearer JWT on each request. */
export function jwtMiddleware(service: Service, options: JWTMiddlewareOptions = {}): Middleware {
  const headerName = options.header ?? "Authorization";
  const scheme = (options.scheme ?? "Bearer").toLowerCase();
  const validators = options.validators ?? [];

  return (next) => async (req) => {
    const raw = req.headers.get(headerName);
    if (!raw) return unauthorized("authorization header is required");

    const [prefix, token] = raw.split(" ", 2);
    if (!token || prefix.toLowerCase() !== scheme) {
      return unauthorized("invalid authorization scheme");
    }

    try {
      const verified = await service.verify(token, ...validators);
      setClaims(req, verified.claims);
    } catch {
      return unauthorized("invalid or expired token");
    }
    return next(req);
  };
}
