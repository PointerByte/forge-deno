// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Models for the REST client.
 *
 * @module
 */

/** Per-request options. */
export interface RequestOptions {
  /** Extra headers merged over the client defaults. */
  headers?: Record<string, string>;
  /** Query-string parameters appended to the URL. */
  query?: Record<string, string | number | boolean>;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Per-request timeout in milliseconds (overrides the client default). */
  timeoutMs?: number;
}

/** A typed HTTP response envelope. */
export interface HttpResponse<T> {
  /** HTTP status code. */
  status: number;
  /** True for 2xx responses. */
  ok: boolean;
  /** Parsed response body (JSON, or raw text when not JSON). */
  data: T;
  /** Response headers. */
  headers: Headers;
}

/** Options accepted by the client constructor. */
export interface ClientOptions {
  /** Base URL prepended to every request path. */
  baseUrl?: string;
  /** Headers sent with every request. */
  headers?: Record<string, string>;
  /** Default timeout in milliseconds applied when a request omits one. */
  timeoutMs?: number;
}

/** Raised when a request fails to complete (network, timeout, abort). */
export class HttpClientError extends Error {
  /** Stable error class name. */
  override name = "HttpClientError";
  /** Creates a client failure with an optional underlying cause. */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
