// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `encrypt/pkcs11` — PKCS#11 (hardware or network HSM) cryptography.
 *
 * The provider implements the same repositories as `encrypt/local`, so it drops
 * into the same call sites, and routes each operation by key reference: an RFC
 * 7512 `pkcs11:` URI addresses an object on the token, anything else is Base64
 * key material handled locally.
 *
 * Unlike the cloud backends, which need only a network call, this one needs FFI
 * — `Deno.dlopen` and the `--allow-ffi` permission — because it loads the
 * vendor's PKCS#11 shared library. Where that is unavailable, the first
 * operation raises {@link Pkcs11UnavailableError}; nothing is loaded at
 * construction time. That mirrors forge-go, where the same package is compiled
 * only under the `pkcs11` build tag and otherwise returns `ErrUnavailable`.
 *
 * @example
 * ```ts
 * import { newPkcs11Provider } from "@pointerbyte/denoforge/encrypt/pkcs11";
 *
 * const hsm = newPkcs11Provider({
 *   modulePath: "/usr/lib64/pkcs11/libsofthsm2.so",
 *   tokenLabel: "forge-hsm",
 *   pin: () => Deno.readTextFile("/run/secrets/hsm-pin"),
 * });
 *
 * const signature = await hsm.signRSAPSS(
 *   "pkcs11:token=forge-hsm;object=jwt-signing;type=private",
 *   payload,
 * );
 * await hsm.close();
 * ```
 *
 * @module
 */

export * from "./interface.ts";
export * from "./errors.ts";
// Every PKCS#11 error extends the module-wide base, so it belongs to this
// entrypoint's surface too.
export { EncryptError, UnsupportedOperationError } from "../errors.ts";
export {
  classFromType,
  formatKeyUri,
  isKeyUri,
  type KeyUri,
  keyUriHexId,
  ObjectClass,
  parseKeyUri,
  typeFromClass,
  URI_SCHEME,
} from "./uri.ts";
export {
  type Attribute,
  AttributeType,
  boolAttribute,
  boolValue,
  bytesAttribute,
  findAttribute,
  hasAttribute,
  KeyType,
  Mechanism,
  mechanismName,
  ReturnValue,
  returnValueName,
  textAttribute,
  ulongAttribute,
  ulongValue,
} from "./cryptoki.ts";
export { loadModule } from "./ffi.ts";
export { newPkcs11Provider, Pkcs11Provider } from "./repository.ts";
// The provider implements the same repositories as the local one, so its
// public surface speaks the whole request/response vocabulary rather than the
// narrow slice the cloud backends need.
export * from "../models/models.ts";
export * from "../common/enums.ts";
