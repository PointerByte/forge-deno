// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * REST client contract: a typed REST surface whose generic methods cover
 * both raw and typed responses through TypeScript generics.
 *
 * @module
 */

import type { HttpResponse, RequestOptions } from "./models.ts";

/** A typed REST client (mirrors `IRest` / `IRestGeneric`). */
export interface Rest {
  /** Sends a GET request and returns a typed response envelope. */
  get<T = unknown>(path: string, options?: RequestOptions): Promise<HttpResponse<T>>;
  /** Sends a POST request with an optional body. */
  post<T = unknown>(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<HttpResponse<T>>;
  /** Sends a PUT request with an optional body. */
  put<T = unknown>(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<HttpResponse<T>>;
  /** Sends a PATCH request with an optional body. */
  patch<T = unknown>(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<HttpResponse<T>>;
  /** Sends a DELETE request and returns a typed response envelope. */
  delete<T = unknown>(path: string, options?: RequestOptions): Promise<HttpResponse<T>>;
}
