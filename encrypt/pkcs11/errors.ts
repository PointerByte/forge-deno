// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Error taxonomy for the PKCS#11 provider.
 *
 * Every class extends the module-wide {@link EncryptError}, so a caller that
 * only cares that encryption failed keeps catching one type, while a caller
 * that must distinguish "the token cannot do this" from "the configuration is
 * incomplete" can branch on the concrete class. These mirror forge-go's
 * `pkcs11.Err*` sentinel values; Go compares them with `errors.Is`, TypeScript
 * with `instanceof`.
 *
 * @module
 */

import { EncryptError } from "../errors.ts";

/** Base class for every failure raised by the PKCS#11 provider. */
export class Pkcs11Error extends EncryptError {
  /** Stable error class name. */
  override name = "Pkcs11Error";
}

/**
 * Thrown when the runtime cannot load a PKCS#11 library at all: `Deno.dlopen`
 * is missing (Deno Deploy, a browser-like host) or `--allow-ffi` was not
 * granted.
 *
 * This is the Deno counterpart of forge-go's `ErrUnavailable`, which reports
 * a binary built without the `pkcs11` build tag or without cgo. Both mean the
 * same thing to a caller: the process cannot reach a token, and no amount of
 * configuration will change that.
 */
export class Pkcs11UnavailableError extends Pkcs11Error {
  /** Stable error class name. */
  override name = "Pkcs11UnavailableError";
  /** Reports that FFI is unavailable, naming the reason when one is known. */
  constructor(reason?: string, options?: ErrorOptions) {
    super(
      `pkcs11: FFI is not available in this runtime${
        reason ? `: ${reason}` : ""
      }; run with --allow-ffi on a Deno runtime that supports Deno.dlopen`,
      options,
    );
  }
}

/** Thrown when no PKCS#11 library path was supplied. */
export class Pkcs11ModuleRequiredError extends Pkcs11Error {
  /** Stable error class name. */
  override name = "Pkcs11ModuleRequiredError";
  /** Reports the missing `modulePath` option. */
  constructor() {
    super("pkcs11: module path is required");
  }
}

/** Thrown when neither a token label nor a slot id was supplied. */
export class Pkcs11TokenRequiredError extends Pkcs11Error {
  /** Stable error class name. */
  override name = "Pkcs11TokenRequiredError";
  /** Reports the missing `tokenLabel`/`slotId` options. */
  constructor() {
    super("pkcs11: token label or slot id is required");
  }
}

/**
 * Thrown when no PIN provider was supplied. The PIN is never read from
 * configuration — see {@link PinProvider}.
 */
export class Pkcs11PinRequiredError extends Pkcs11Error {
  /** Stable error class name. */
  override name = "Pkcs11PinRequiredError";
  /** Reports the missing `pin` option. */
  constructor() {
    super("pkcs11: pin provider is required");
  }
}

/** Thrown when an operation needs a key reference and none was available. */
export class Pkcs11KeyUriRequiredError extends Pkcs11Error {
  /** Stable error class name. */
  override name = "Pkcs11KeyUriRequiredError";
  /** Reports that neither the request nor `keyUri` carried a reference. */
  constructor() {
    super("pkcs11: key uri is required");
  }
}

/** Thrown when no object on the token matches the supplied key URI. */
export class Pkcs11KeyNotFoundError extends Pkcs11Error {
  /** Stable error class name. */
  override name = "Pkcs11KeyNotFoundError";
  /** Reports the URI that matched nothing, plus optional context. */
  constructor(uri: string, detail?: string) {
    super(`pkcs11: no object matches the key uri: ${detail ? `${detail}: ` : ""}${uri}`);
  }
}

/**
 * Thrown when the token rejects the SHA-256 OAEP parameters this provider
 * pins.
 *
 * The parameters are not negotiable: every other backend encrypts RSA-OAEP
 * with SHA-256 and MGF1-SHA256, so a token-side downgrade to SHA-1 would
 * produce ciphertext the local backend cannot read, besides being weaker.
 * SoftHSM2 is the common case, as it hardcodes OAEP to SHA-1.
 */
export class Pkcs11OaepHashUnsupportedError extends Pkcs11Error {
  /** Stable error class name. */
  override name = "Pkcs11OaepHashUnsupportedError";
  /** Reports the token's refusal of SHA-256 OAEP. */
  constructor(options?: ErrorOptions) {
    super(
      "pkcs11: token does not accept RSA-OAEP with SHA-256; the parameters are fixed for " +
        "cross-backend compatibility",
      options,
    );
  }
}

/**
 * Thrown when the token policy forbids reading the derived shared secret,
 * which makes the interoperable ECDH payload format impossible to produce.
 * See {@link Pkcs11Options.allowSecretExtraction}.
 */
export class Pkcs11SecretNotExtractableError extends Pkcs11Error {
  /** Stable error class name. */
  override name = "Pkcs11SecretNotExtractableError";
  /** Reports that ECDH cannot complete without extracting the secret. */
  constructor(options?: ErrorOptions) {
    super(
      "pkcs11: token policy forbids extracting the derived secret; ECDH is unavailable on " +
        "this token",
      options,
    );
  }
}

/**
 * Thrown when the token did not advertise a mechanism an operation needs.
 *
 * This is deliberately not a silent fallback to software: a caller asking for
 * a hardware-backed operation must be told when the hardware cannot perform
 * it, or it would believe work happened in the token when it did not.
 */
export class Pkcs11UnsupportedMechanismError extends Pkcs11Error {
  /** Stable error class name. */
  override name = "Pkcs11UnsupportedMechanismError";
  /** The CKM_ name of the mechanism the token does not advertise. */
  readonly mechanism: string;
  /** Reports the missing mechanism by its spec name. */
  constructor(mechanism: string) {
    super(`pkcs11: token does not support mechanism ${mechanism}`);
    this.mechanism = mechanism;
  }
}

/**
 * Thrown when a Cryptoki call returns a non-zero `CK_RV`. The numeric code and
 * its spec name are kept on the error so callers can branch on a specific
 * token condition (a locked PIN, a removed device) without parsing messages.
 */
export class Pkcs11TokenError extends Pkcs11Error {
  /** Stable error class name. */
  override name = "Pkcs11TokenError";
  /** The raw `CK_RV` value. */
  readonly code: number;
  /** The canonical `CKR_` name, or a numeric rendering when unnamed. */
  readonly ckr: string;
  /** Reports the failing Cryptoki function and its return value. */
  constructor(fn: string, code: number, ckr: string) {
    super(`pkcs11: ${fn} failed: ${ckr}`);
    this.code = code;
    this.ckr = ckr;
  }
}
