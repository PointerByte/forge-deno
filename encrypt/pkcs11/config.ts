// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Option resolution for the PKCS#11 provider.
 *
 * Validation runs on the first operation rather than in the constructor, so a
 * misconfigured provider fails at the point of use with a descriptive error —
 * the same deferral the Azure backend applies to credential resolution.
 *
 * @module
 */

import {
  Pkcs11KeyUriRequiredError,
  Pkcs11ModuleRequiredError,
  Pkcs11PinRequiredError,
  Pkcs11TokenRequiredError,
} from "./errors.ts";
import type { PinProvider, Pkcs11Module, Pkcs11Options } from "./interface.ts";
import { type KeyUri, parseKeyUri } from "./uri.ts";

/** Provider name reported in `KeyData.provider`. */
export const PROVIDER = "pkcs11";

/**
 * Bounds three things at once: sessions held open on the token, concurrent
 * operations, and pending FFI calls. They are the same resource, so they get
 * the same number.
 */
export const DEFAULT_MAX_SESSIONS = 8;

/** `CKA_LABEL` prefixes for generated keys, mirroring the other backends. */
export const KeyLabelPrefix = {
  /** Prefix for generated AES keys. */
  Symmetric: "GoForge-symmetric",
  /** Prefix for generated RSA key pairs. */
  Rsa: "GoForge-rsa",
  /** Prefix for generated ECDH key pairs. */
  Ecdh: "GoForge-ecdh",
  /** Prefix for generated Ed25519 key pairs. */
  Ed25519: "GoForge-ed25519",
  /** Prefix for generated HMAC keys. */
  Hmac: "GoForge-hmac",
} as const;

/**
 * The HKDF info prefix the local provider mixes in, repeated here so an
 * in-hardware HKDF derives the same key the software path derives.
 */
export const ECDH_HKDF_INFO_PREFIX = "denoforge/ecdh/";

/** Options with every default applied. */
export interface ResolvedOptions {
  /** Path to the vendor PKCS#11 shared library. */
  modulePath: string;
  /** Token label, or the empty string when the slot id selects the token. */
  tokenLabel: string;
  /** Slot id, when one was supplied. */
  slotId?: number;
  /** Default key URI, or the empty string. */
  keyUri: string;
  /** Session bound; always at least one. */
  maxSessions: number;
  /** The PIN provider, when one was supplied. */
  pin?: PinProvider;
  /** Whether ECDH may read a derived secret out of the token. */
  allowSecretExtraction: boolean;
  /** Whether `deactivateKey` may destroy an object it cannot disable. */
  deactivateDestroys: boolean;
  /** Whether `rotateKey` disables the previous key. */
  rotateDisablesPrevious: boolean;
  /** An injected token implementation, when one was supplied. */
  module?: Pkcs11Module;
}

/** Applies the defaults an unset option carries. */
export function resolveOptions(options: Pkcs11Options = {}): ResolvedOptions {
  return {
    modulePath: (options.modulePath ?? "").trim(),
    tokenLabel: (options.tokenLabel ?? "").trim(),
    slotId: options.slotId,
    keyUri: (options.keyUri ?? "").trim(),
    maxSessions: options.maxSessions !== undefined && options.maxSessions > 0
      ? options.maxSessions
      : DEFAULT_MAX_SESSIONS,
    pin: options.pin,
    allowSecretExtraction: options.allowSecretExtraction ?? true,
    deactivateDestroys: options.deactivateDestroys ?? false,
    rotateDisablesPrevious: options.rotateDisablesPrevious ?? false,
    module: options.module,
  };
}

/**
 * Reports the first missing setting.
 *
 * An injected module still needs a token and a PIN, but not a library path:
 * there is nothing to `dlopen`.
 */
export function validateOptions(options: ResolvedOptions): void {
  if (!options.module && options.modulePath === "") throw new Pkcs11ModuleRequiredError();
  if (options.tokenLabel === "" && options.slotId === undefined) {
    throw new Pkcs11TokenRequiredError();
  }
  if (!options.pin) throw new Pkcs11PinRequiredError();
}

/**
 * Returns the key reference for an operation, falling back to the configured
 * default the way the cloud backends fall back to their configured key id.
 */
export function resolveKeyUri(options: ResolvedOptions, reference: string): KeyUri {
  const trimmed = reference.trim();
  if (trimmed !== "") return parseKeyUri(trimmed);
  if (options.keyUri !== "") return parseKeyUri(options.keyUri);
  throw new Pkcs11KeyUriRequiredError();
}
