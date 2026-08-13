// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Security headers middleware.
 *
 * Applies a conservative set of security headers to every response. Defaults
 * can be overridden or extended via {@link SecurityHeadersOptions.headers}.
 *
 * @module
 */

import type { Middleware } from "./context.ts";

/** Options for {@link securityHeaders}. */
export interface SecurityHeadersOptions {
  /** Extra/overriding headers merged on top of the secure defaults. */
  headers?: Record<string, string>;
}

const DEFAULT_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-XSS-Protection": "0",
};

/** Returns a middleware that adds security headers to each response. */
export function securityHeaders(options: SecurityHeadersOptions = {}): Middleware {
  const merged = { ...DEFAULT_HEADERS, ...(options.headers ?? {}) };
  return (next) => async (req) => {
    const res = await next(req);
    const headers = new Headers(res.headers);
    for (const [key, value] of Object.entries(merged)) headers.set(key, value);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}
