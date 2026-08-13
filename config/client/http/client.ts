// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `fetch`-based REST client.
 *
 * A REST client that wraps the platform `fetch` behind a generic, typed
 * surface ({@link Rest}). JSON bodies are encoded/decoded automatically and
 * per-request timeouts are honoured through an {@link AbortSignal}.
 *
 * @module
 */

import type { Rest } from "./interface.ts";
import {
  type ClientOptions,
  HttpClientError,
  type HttpResponse,
  type RequestOptions,
} from "./models.ts";

/** Default REST client implementation. */
export class ClientHTTP implements Rest {
  readonly #baseUrl: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs?: number;

  /** Creates a REST client with optional base URL, headers, and default timeout. */
  constructor(options: ClientOptions = {}) {
    this.#baseUrl = options.baseUrl?.replace(/\/+$/, "") ?? "";
    this.#headers = options.headers ?? {};
    this.#timeoutMs = options.timeoutMs;
  }

  /** Sends a GET request and returns a typed response envelope. */
  get<T = unknown>(path: string, options?: RequestOptions): Promise<HttpResponse<T>> {
    return this.#request<T>("GET", path, undefined, options);
  }
  /** Sends a POST request with an optional body. */
  post<T = unknown>(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<HttpResponse<T>> {
    return this.#request<T>("POST", path, body, options);
  }
  /** Sends a PUT request with an optional body. */
  put<T = unknown>(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<HttpResponse<T>> {
    return this.#request<T>("PUT", path, body, options);
  }
  /** Sends a PATCH request with an optional body. */
  patch<T = unknown>(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<HttpResponse<T>> {
    return this.#request<T>("PATCH", path, body, options);
  }
  /** Sends a DELETE request and returns a typed response envelope. */
  delete<T = unknown>(path: string, options?: RequestOptions): Promise<HttpResponse<T>> {
    return this.#request<T>("DELETE", path, undefined, options);
  }

  #buildUrl(path: string, query?: RequestOptions["query"]): string {
    const base = path.startsWith("http")
      ? path
      : `${this.#baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
    if (!query) return base;
    const url = new URL(base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    return url.toString();
  }

  async #request<T>(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions = {},
  ): Promise<HttpResponse<T>> {
    const headers = new Headers({ ...this.#headers, ...(options.headers ?? {}) });
    let payload: BodyInit | undefined;
    if (body !== undefined) {
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      payload = headers.get("content-type")?.includes("application/json")
        ? JSON.stringify(body)
        : (body as BodyInit);
    }

    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const signal = composeSignal(options.signal, timeoutMs);

    let response: Response;
    try {
      response = await fetch(this.#buildUrl(path, options.query), {
        method,
        headers,
        body: payload,
        signal,
      });
    } catch (cause) {
      throw new HttpClientError(`http client: ${method} ${path} failed`, { cause });
    }

    const data = await parseBody<T>(response);
    return { status: response.status, ok: response.ok, data, headers: response.headers };
  }
}

/** Factory constructor. */
export function newClientHTTP(options: ClientOptions = {}): ClientHTTP {
  return new ClientHTTP(options);
}

/** Combines a caller signal with an optional timeout into one signal. */
function composeSignal(signal?: AbortSignal, timeoutMs?: number): AbortSignal | undefined {
  if (timeoutMs && timeoutMs > 0) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  }
  return signal;
}

async function parseBody<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return undefined as T;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }
  return text as T;
}
