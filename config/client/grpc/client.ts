// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * gRPC client wrapper.
 *
 * Wraps a `@grpc/grpc-js` service client constructor with a promisified unary
 * call helper, per-call metadata (including a `Bearer` token shortcut) and
 * deadlines.
 *
 * @example
 * ```ts
 * import { GrpcClient, loadProto } from "@pointerbyte/denoforge/config";
 *
 * const proto = loadProto(new URL("../proto/methods.proto", import.meta.url));
 * const Methods = (proto.denoforge as any).v1.Methods;
 *
 * const client = new GrpcClient(Methods, "127.0.0.1:50051");
 * const res = await client.unary<{ message: string }, { message: string }>(
 *   "Echo",
 *   { message: "hi" },
 *   { bearer: token },
 * );
 * client.close();
 * ```
 *
 * @module
 */

import grpc from "@grpc/grpc-js";

/** Per-call options. */
export interface CallOptions {
  /** Extra metadata entries (string values). */
  metadata?: Record<string, string>;
  /** Sets an `authorization: Bearer <token>` metadata entry. */
  bearer?: string;
  /** Deadline in milliseconds from now. */
  deadlineMs?: number;
}

type UnaryFn = (
  request: unknown,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
  callback: (err: grpc.ServiceError | null, value?: unknown) => void,
) => void;

/** Promisified gRPC client for a single service. */
export class GrpcClient {
  readonly #client: grpc.Client;

  /** Creates a promisified wrapper around a generated grpc-js service client. */
  constructor(
    ServiceClient: grpc.ServiceClientConstructor,
    address: string,
    credentials?: grpc.ChannelCredentials,
  ) {
    const creds = credentials ?? grpc.credentials.createInsecure();
    this.#client = new ServiceClient(address, creds);
  }

  /** Invokes a unary method and resolves with the typed response. */
  unary<Req, Res>(method: string, request: Req, options: CallOptions = {}): Promise<Res> {
    const fn = (this.#client as unknown as Record<string, UnaryFn>)[method];
    if (typeof fn !== "function") {
      return Promise.reject(new Error(`grpc client: unknown unary method "${method}"`));
    }

    const metadata = new grpc.Metadata();
    for (const [key, value] of Object.entries(options.metadata ?? {})) metadata.set(key, value);
    if (options.bearer) metadata.set("authorization", `Bearer ${options.bearer}`);

    const callOptions: grpc.CallOptions = {};
    if (options.deadlineMs && options.deadlineMs > 0) {
      callOptions.deadline = new Date(Date.now() + options.deadlineMs);
    }

    return new Promise<Res>((resolve, reject) => {
      fn.call(this.#client, request, metadata, callOptions, (err, value) => {
        if (err) return reject(err);
        resolve(value as Res);
      });
    });
  }

  /** Closes the underlying channel. */
  close(): void {
    this.#client.close();
  }

  /** Escape hatch: the underlying grpc-js client. */
  raw(): grpc.Client {
    return this.#client;
  }
}

/** Factory constructor. */
export function newGrpcClient(
  ServiceClient: grpc.ServiceClientConstructor,
  address: string,
  credentials?: grpc.ChannelCredentials,
): GrpcClient {
  return new GrpcClient(ServiceClient, address, credentials);
}
