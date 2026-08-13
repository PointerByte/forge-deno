// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proto loading shared by the gRPC client and server.
 *
 * Wraps `@grpc/proto-loader` + `@grpc/grpc-js` so a `.proto` file becomes a
 * usable gRPC package object with sensible defaults (keep field casing, longs
 * as strings, enums as strings).
 *
 * @module
 */

import * as protoLoader from "@grpc/proto-loader";
import grpc from "@grpc/grpc-js";

/** Options forwarded to `@grpc/proto-loader`. */
export interface LoadProtoOptions {
  /** Preserve field names from the source proto instead of converting to camel case. */
  keepCase?: boolean;
  /** Representation used for 64-bit integer values. */
  longs?: typeof String | typeof Number;
  /** Representation used for enum values. */
  enums?: typeof String;
  /** Populate default values for omitted fields. */
  defaults?: boolean;
  /** Populate virtual oneof discriminator properties. */
  oneofs?: boolean;
  /** Additional directories searched for imported proto files. */
  includeDirs?: string[];
}

const DEFAULTS: protoLoader.Options = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

/**
 * Loads a `.proto` file (path or URL) and returns the generated gRPC package
 * object. Index into it by package + service, e.g.
 * `(pkg.denoforge.v1.Methods)`.
 */
export function loadProto(
  protoPath: string | URL,
  options: LoadProtoOptions = {},
): grpc.GrpcObject {
  const path = protoPath instanceof URL ? fromFileUrl(protoPath) : protoPath;
  const packageDefinition = protoLoader.loadSync(path, { ...DEFAULTS, ...options });
  return grpc.loadPackageDefinition(packageDefinition);
}

/** Resolves a `file://` URL to a filesystem path without importing std. */
function fromFileUrl(url: URL): string {
  if (url.protocol !== "file:") throw new TypeError("loadProto: expected a file:// URL or a path");
  return decodeURIComponent(url.pathname);
}

export { grpc };
