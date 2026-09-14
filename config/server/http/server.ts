// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP server bootstrap.
 *
 * A native HTTP server built on `Deno.serve`: a tiny router with middleware
 * applied outermost-first, nested route groups, a configurable `/health`
 * endpoint and a `shutdown()` that drains in-flight requests. Middleware is
 * the same {@link Middleware} type used across `logger` and `security`.
 *
 * @module
 */

import type { Handler, Middleware } from "../../../security/middlewares/context.ts";
import { activeSpan, setHttpRoute } from "../../../telemetry/mod.ts";

export type { Handler, Middleware };

/** HTTP methods accepted by the router. */
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

interface Route {
  method: Method;
  path: string;
  pattern: URLPattern;
  handler: Handler;
}

/** A prefix + middleware scope for registering related routes. */
export class RouteGroup {
  /** Creates a route group bound to a server, prefix, and middleware chain. */
  constructor(
    private readonly server: HttpServer,
    private readonly prefix: string,
    private readonly groupMiddleware: Middleware[],
  ) {}

  /** Creates a nested group, inheriting this group's prefix and middleware. */
  group(prefix: string, ...middleware: Middleware[]): RouteGroup {
    return new RouteGroup(
      this.server,
      joinPath(this.prefix, prefix),
      [...this.groupMiddleware, ...middleware],
    );
  }

  /** Registers a route relative to the group prefix, with group middleware. */
  handle(method: Method, path: string, handler: Handler, ...middleware: Middleware[]): this {
    this.server.handle(
      method,
      joinPath(this.prefix, path),
      handler,
      ...this.groupMiddleware,
      ...middleware,
    );
    return this;
  }

  /** Registers a GET route relative to the group prefix. */
  get(path: string, handler: Handler, ...mw: Middleware[]): this {
    return this.handle("GET", path, handler, ...mw);
  }
  /** Registers a POST route relative to the group prefix. */
  post(path: string, handler: Handler, ...mw: Middleware[]): this {
    return this.handle("POST", path, handler, ...mw);
  }
  /** Registers a PUT route relative to the group prefix. */
  put(path: string, handler: Handler, ...mw: Middleware[]): this {
    return this.handle("PUT", path, handler, ...mw);
  }
  /** Registers a PATCH route relative to the group prefix. */
  patch(path: string, handler: Handler, ...mw: Middleware[]): this {
    return this.handle("PATCH", path, handler, ...mw);
  }
  /** Registers a DELETE route relative to the group prefix. */
  delete(path: string, handler: Handler, ...mw: Middleware[]): this {
    return this.handle("DELETE", path, handler, ...mw);
  }
}

/** Options for {@link HttpServer}. */
export interface HttpServerOptions {
  /** Port to listen on. Defaults to 8080. */
  port?: number;
  /** Hostname to bind. Defaults to "0.0.0.0". */
  hostname?: string;
  /** Path of the health endpoint. Defaults to "/health". Set to "" to disable. */
  healthPath?: string;
  /**
   * Optional replacement for the built-in health response. This customizes the
   * one built-in route; consumers do not need to register the path themselves.
   */
  healthHandler?: Handler;
  /** Global middleware applied to every route. */
  middleware?: Middleware[];
}

/** A minimal HTTP server over `Deno.serve`. */
export class HttpServer {
  readonly #routes: Route[] = [];
  readonly #global: Middleware[];
  readonly #port: number;
  readonly #hostname: string;
  readonly #healthPath: string;
  // Avoid referencing the Deno namespace in type annotations to keep this
  // module compatible with TypeScript environments that don't provide Deno
  // types. At runtime this holds the value returned by Deno.serve, which
  // exposes a shutdown() method.
  // deno-lint-ignore no-explicit-any
  #server?: any;

  /** Creates an HTTP server with routing, middleware, and optional health endpoint. */
  constructor(options: HttpServerOptions = {}) {
    this.#port = options.port ?? 8080;
    this.#hostname = options.hostname ?? "0.0.0.0";
    this.#healthPath = options.healthPath ?? "/health";
    this.#global = options.middleware ?? [];
    if (this.#healthPath) {
      this.handle(
        "GET",
        this.#healthPath,
        options.healthHandler ??
          (() =>
            new Response(JSON.stringify({ status: "ok" }), {
              headers: { "content-type": "application/json" },
            })),
      );
    }
  }

  /** Adds a global middleware applied to every route. */
  use(...middleware: Middleware[]): this {
    this.#global.push(...middleware);
    return this;
  }

  /** Opens a route group under `prefix` with optional group middleware. */
  group(prefix: string, ...middleware: Middleware[]): RouteGroup {
    return new RouteGroup(this, prefix, middleware);
  }

  /** Registers a single route, wrapping the handler with its middleware. */
  handle(method: Method, path: string, handler: Handler, ...middleware: Middleware[]): this {
    const wrapped = middleware.reduceRight<Handler>((next, mw) => mw(next), handler);
    this.#routes.push({
      method,
      path,
      pattern: new URLPattern({ pathname: path }),
      handler: wrapped,
    });
    return this;
  }

  /** Registers a GET route. */
  get(path: string, handler: Handler, ...mw: Middleware[]): this {
    return this.handle("GET", path, handler, ...mw);
  }
  /** Registers a POST route. */
  post(path: string, handler: Handler, ...mw: Middleware[]): this {
    return this.handle("POST", path, handler, ...mw);
  }
  /** Registers a PUT route. */
  put(path: string, handler: Handler, ...mw: Middleware[]): this {
    return this.handle("PUT", path, handler, ...mw);
  }
  /** Registers a PATCH route. */
  patch(path: string, handler: Handler, ...mw: Middleware[]): this {
    return this.handle("PATCH", path, handler, ...mw);
  }
  /** Registers a DELETE route. */
  delete(path: string, handler: Handler, ...mw: Middleware[]): this {
    return this.handle("DELETE", path, handler, ...mw);
  }

  /** The composed root handler (global middleware + router). Useful for tests. */
  handler(): Handler {
    return this.#global.reduceRight<Handler>((next, mw) => mw(next), (req) => this.#route(req));
  }

  /** Starts listening. Returns once the listener is bound. */
  // deno-lint-ignore no-explicit-any
  listen(): any {
    const root = this.handler();
    this.#server = Deno.serve(
      { port: this.#port, hostname: this.#hostname },
      (req) => root(req),
    );
    return this.#server;
  }

  /** Gracefully drains in-flight requests and stops the listener. */
  async shutdown(): Promise<void> {
    await this.#server?.shutdown();
  }

  async #route(req: Request): Promise<Response> {
    for (const route of this.#routes) {
      if (route.method !== req.method) continue;
      if (route.pattern.test(req.url)) {
        // Deno already owns the HTTP SERVER span. Annotate that ambient span
        // with the route now that Forge's router has resolved it.
        setHttpRoute(activeSpan(), req.method, route.path);
        return await route.handler(req);
      }
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
}

/** Factory constructor. */
export function newHttpServer(options: HttpServerOptions = {}): HttpServer {
  return new HttpServer(options);
}

function joinPath(a: string, b: string): string {
  const left = a.replace(/\/+$/, "");
  const right = b.startsWith("/") ? b : `/${b}`;
  return `${left}${right}` || "/";
}
