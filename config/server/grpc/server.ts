// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * gRPC server bootstrap.
 *
 * Wraps `@grpc/grpc-js` with the same ergonomics as the HTTP server: a
 * server-wide interceptor chain (logging, auth, …), simple service
 * registration from a handler map, promisified bind, and graceful shutdown.
 *
 * @example
 * ```ts
 * import { loadProto } from "@pointerbyte/denoforge/config";
 * import { GrpcServer } from "@pointerbyte/denoforge/config";
 *
 * const proto = loadProto(new URL("../proto/methods.proto", import.meta.url));
 * const Methods = (proto.denoforge as any).v1.Methods;
 *
 * const server = new GrpcServer();
 * server.addService(Methods.service, {
 *   Echo: (req) => ({ message: req.message }),
 *   Health: () => ({ status: "ok" }),
 * });
 * const port = await server.listen("127.0.0.1:50051");
 * ```
 *
 * @module
 */

import grpc from "@grpc/grpc-js";
import { type ServerInterceptor, unary, type UnaryHandler } from "./interceptors.ts";

/** Options for {@link GrpcServer}. */
export interface GrpcServerOptions {
  /** Interceptors applied to every registered method, outermost-first. */
  interceptors?: ServerInterceptor[];
}

/** A map of method name -> unary handler for a single service. */
export type ServiceHandlers = Record<string, UnaryHandler>;

/** Ergonomic wrapper around `grpc.Server`. */
export class GrpcServer {
  readonly #server: grpc.Server;
  readonly #interceptors: ServerInterceptor[];

  /** Creates a gRPC server with an optional global interceptor chain. */
  constructor(options: GrpcServerOptions = {}) {
    this.#server = new grpc.Server();
    this.#interceptors = options.interceptors ?? [];
  }

  /**
   * Registers a service. Each handler is wrapped with the server-wide
   * interceptors followed by any per-service interceptors.
   */
  addService(
    service: grpc.ServiceDefinition,
    handlers: ServiceHandlers,
    ...interceptors: ServerInterceptor[]
  ): this {
    const chain = [...this.#interceptors, ...interceptors];
    const impl: Record<string, grpc.UntypedHandleCall> = {};
    for (const [name, handler] of Object.entries(handlers)) {
      impl[name] = unary(handler, ...chain);
    }
    this.#server.addService(service, impl);
    return this;
  }

  /**
   * Binds and starts the server. Returns the bound port. Defaults to insecure
   * credentials; pass TLS `grpc.ServerCredentials` for mTLS.
   */
  listen(address: string, credentials?: grpc.ServerCredentials): Promise<number> {
    const creds = credentials ?? grpc.ServerCredentials.createInsecure();
    return new Promise<number>((resolve, reject) => {
      this.#server.bindAsync(address, creds, (err, port) => {
        if (err) return reject(err);
        resolve(port);
      });
    });
  }

  /** Gracefully drains in-flight RPCs and stops the server. */
  shutdown(): Promise<void> {
    return new Promise<void>((resolve) => this.#server.tryShutdown(() => resolve()));
  }

  /** Immediately cancels in-flight RPCs and stops the server. */
  forceShutdown(): void {
    this.#server.forceShutdown();
  }

  /** Escape hatch: the underlying `grpc.Server`. */
  raw(): grpc.Server {
    return this.#server;
  }
}

/** Factory constructor. */
export function newGrpcServer(options: GrpcServerOptions = {}): GrpcServer {
  return new GrpcServer(options);
}
