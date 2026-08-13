// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * # GoForge component runtime
 *
 * A lazy, integrity-checked runtime for GoForge's canonical JSON ABI v1. Generated component glue is
 * supplied through an injected factory only after the release-bundle manifest and every artifact
 * have passed exact checksum and version validation. Each instance's separate portable contract
 * manifest is validated before its first dispatch.
 *
 * Native adapters require an explicit per-call route and manifest approval. Component failures never
 * trigger automatic fallback, especially for cryptographic and security operations.
 *
 * @example Encode an operation-specific binary field without loading a component
 * ```ts
 * import { decodeAbiBase64, encodeAbiBase64 } from "@pointerbyte/denoforge/wasm";
 *
 * const encoded = encodeAbiBase64(new Uint8Array([1, 2, 3]));
 * const decoded = decodeAbiBase64(encoded);
 * console.log(decoded.length); // 3
 * ```
 *
 * @module
 */

export * from "./adapters.ts";
export * from "./codec.ts";
export * from "./component.ts";
export * from "./contracts.ts";
export * from "./errors.ts";
export * from "./manifest.ts";
export * from "./native.ts";
export * from "./runtime.ts";
export * from "./wasi.ts";
