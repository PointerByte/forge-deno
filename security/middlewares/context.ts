// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared middleware types plus generic request context and authenticated
 * claims stores.
 *
 * Native Deno handlers have no per-request context object, so state is stored
 * in `WeakMap`s keyed by the `Request`. Application context and verified claims
 * remain deliberately independent.
 *
 * @module
 */

/** Native Deno request handler. */
export type Handler = (req: Request) => Response | Promise<Response>;
/** Handler wrapper applied outermost-first. */
export type Middleware = (next: Handler) => Handler;

const claimsStore = new WeakMap<Request, Record<string, unknown>>();
const contextStore = new WeakMap<Request, unknown>();

/** Associates application context with a request without retaining the request. */
export function setRequestContext<T>(req: Request, context: T): void {
  contextStore.set(req, context);
}

/** Returns the application context attached to the exact request object. */
export function getRequestContext<T>(req: Request): T | undefined {
  return contextStore.get(req) as T | undefined;
}

/** Associates verified claims with a request (used by auth middleware). */
export function setClaims(req: Request, claims: Record<string, unknown>): void {
  claimsStore.set(req, claims);
}

/** Returns the verified claims attached to a request, if any. */
export function getClaims<T = Record<string, unknown>>(req: Request): T | undefined {
  return claimsStore.get(req) as T | undefined;
}

/** Builds a JSON error response with the given status. */
export function unauthorized(message: string, status = 401): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
