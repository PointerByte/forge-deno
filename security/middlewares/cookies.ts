// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cookie JWT authentication middleware.
 *
 * Validates the JWT carried in a cookie via {@link CookieService}, stashes
 * claims for downstream handlers and returns 401 on failure.
 *
 * @module
 */

import type { CookieService } from "../auth/cookies/cookies.ts";
import type { Validator } from "../auth/jwt/jwt.ts";
import { type Middleware, setClaims, unauthorized } from "./context.ts";

/** Returns a middleware enforcing a valid JWT cookie on each request. */
export function cookieMiddleware(
  service: CookieService,
  ...validators: Validator[]
): Middleware {
  return (next) => async (req) => {
    try {
      const claims = await service.read(req, ...validators);
      setClaims(req, claims as Record<string, unknown>);
    } catch {
      return unauthorized("invalid or missing auth cookie");
    }
    return next(req);
  };
}
