// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cookie-based JWT authentication.
 *
 * Reads the token from a standard `Request` cookie using `@std/http/cookie`
 * and validates it through the JWT {@link Service}.
 *
 * @module
 */

import { getCookies } from "@std/http/cookie";
import type { Service, Token, Validator } from "../jwt/jwt.ts";

/** Default cookie name used to read bearer JWTs from HTTP requests. */
export const DEFAULT_COOKIE_NAME = "access_token";

/** Raised when cookie-based authentication cannot read or validate a token. */
export class CookieError extends Error {
  /** Stable error class name. */
  override name = "CookieError";
}

/** Options for {@link newCookieService}. */
export interface CookieServiceOptions {
  /** JWT service used to verify cookie values. */
  jwtService: Service;
  /** Cookie name; defaults to {@link DEFAULT_COOKIE_NAME}. */
  cookieName?: string;
}

/** Extracts and validates JWTs carried in an HTTP cookie. */
export class CookieService {
  readonly #jwt: Service;
  readonly #cookieName: string;

  /** Creates a cookie authentication service. */
  constructor(options: CookieServiceOptions) {
    if (!options.jwtService) throw new CookieError("cookies: jwt service is required");
    this.#jwt = options.jwtService;
    this.#cookieName = options.cookieName?.trim() || DEFAULT_COOKIE_NAME;
  }

  /** The configured cookie name. */
  cookieName(): string {
    return this.#cookieName;
  }

  /** Returns the raw token from the request cookie, or throws if absent. */
  tokenFromRequest(request: Request): string {
    const token = getCookies(request.headers)[this.#cookieName];
    if (!token) throw new CookieError("cookies: auth cookie is required");
    return token;
  }

  /** Verifies the cookie token; rejects if missing or invalid. */
  async validateRequest(request: Request, ...validators: Validator[]): Promise<void> {
    await this.#jwt.verify(this.tokenFromRequest(request), ...validators);
  }

  /** Verifies the cookie token and returns the decoded claims. */
  async read<T = Record<string, unknown>>(
    request: Request,
    ...validators: Validator[]
  ): Promise<T> {
    const token = await this.#jwt.verify(this.tokenFromRequest(request), ...validators);
    return token.claims as T;
  }

  /** Verifies the cookie token and returns the full decoded {@link Token}. */
  decode(request: Request, ...validators: Validator[]): Promise<Token> {
    return this.#jwt.verify(this.tokenFromRequest(request), ...validators);
  }
}

/** Constructs a {@link CookieService}. */
export function newCookieService(options: CookieServiceOptions): CookieService {
  return new CookieService(options);
}
