// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * # DenoForge
 *
 * A modular toolkit for Deno service-oriented applications: cryptography,
 * structured logging, security/JWT, background jobs & workers and HTTP tooling.
 *
 * Each capability is exposed as a namespace and as an independent import
 * specifier:
 *
 * | Namespace | Import specifier |
 * | --------- | ---------------- |
 * | {@link encrypt}  | `@pointerbyte/denoforge/encrypt` |
 * | {@link logger}   | `@pointerbyte/denoforge/logger`  |
 * | {@link security} | `@pointerbyte/denoforge/security`|
 * | {@link tools}    | `@pointerbyte/denoforge/tools`   |
 * | {@link config}   | `@pointerbyte/denoforge/config`  |
 * | {@link telemetry}| `@pointerbyte/denoforge/telemetry`|
 * | {@link wasm}     | `@pointerbyte/denoforge/wasm`    |
 *
 * Prefer the per-module specifiers for smaller dependency graphs; this root
 * barrel namespaces every module so names that repeat across modules (e.g.
 * `Service`, `Middleware`, `Handler`) never collide.
 *
 * @example
 * ```ts
 * import { encrypt, security } from "@pointerbyte/denoforge";
 *
 * const enc = encrypt.newLocalProvider();
 * const jwt = security.createService({ algorithm: "HS256", hmacSecret: "x" });
 * ```
 *
 * @module
 */

export * as encrypt from "./encrypt/mod.ts";
export * as logger from "./logger/mod.ts";
export * as security from "./security/mod.ts";
export * as tools from "./tools/mod.ts";
export * as config from "./config/mod.ts";
export * as telemetry from "./telemetry/mod.ts";
export * as wasm from "./wasm/mod.ts";
