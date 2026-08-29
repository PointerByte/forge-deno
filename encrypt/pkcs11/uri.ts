// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 7512 `pkcs11:` key URIs.
 *
 * The scheme prefix is the discriminator the repository uses to tell a token
 * reference from local key material, which makes the routing decision exact
 * rather than heuristic: a value that starts with `pkcs11:` addresses an
 * object on the token, anything else is Base64 key material handled by the
 * local provider.
 *
 * @module
 */

import { Pkcs11Error } from "./errors.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The RFC 7512 scheme prefix. */
export const URI_SCHEME = "pkcs11:";

/** PKCS#11 `CKO_` object classes, as used by the URI `type` attribute. */
export const ObjectClass = {
  /** `CKO_DATA`. */
  Data: 0x00000000,
  /** `CKO_CERTIFICATE`. */
  Certificate: 0x00000001,
  /** `CKO_PUBLIC_KEY`. */
  PublicKey: 0x00000002,
  /** `CKO_PRIVATE_KEY`. */
  PrivateKey: 0x00000003,
  /** `CKO_SECRET_KEY`. */
  SecretKey: 0x00000004,
} as const;
/** Union of the supported `CKO_` object classes. */
export type ObjectClass = (typeof ObjectClass)[keyof typeof ObjectClass];

/**
 * A parsed `pkcs11:` URI. Only the path attributes the provider acts on are
 * modelled; query attributes are ignored (and the PIN-bearing ones rejected)
 * because the PIN is supplied through a pin provider.
 */
export interface KeyUri {
  /** `CKA_LABEL` of the token (the `token` attribute). */
  token?: string;
  /** `CKA_LABEL` of the key object (the `object` attribute). */
  object?: string;
  /** Raw `CKA_ID` bytes (the `id` attribute, percent-decoded). */
  id?: Uint8Array;
  /** Object class implied by the `type` attribute, when it was present. */
  class?: ObjectClass;
}

const TYPE_TO_CLASS: Record<string, ObjectClass> = {
  private: ObjectClass.PrivateKey,
  public: ObjectClass.PublicKey,
  "secret-key": ObjectClass.SecretKey,
  cert: ObjectClass.Certificate,
  data: ObjectClass.Data,
};

const CLASS_TO_TYPE = new Map<ObjectClass, string>(
  Object.entries(TYPE_TO_CLASS).map(([name, value]) => [value, name]),
);

/**
 * Reports whether `reference` is a PKCS#11 URI. Callers use it to route
 * between the token and the local provider.
 */
export function isKeyUri(reference: string): boolean {
  return reference.trim().startsWith(URI_SCHEME);
}

/** Maps the RFC 7512 `type` attribute to a `CKO_` class. */
export function classFromType(value: string): ObjectClass {
  const found = TYPE_TO_CLASS[value];
  if (found === undefined) {
    throw new Pkcs11Error(`pkcs11: unsupported object type ${JSON.stringify(value)} in key uri`);
  }
  return found;
}

/** Maps a `CKO_` class back to its RFC 7512 `type` attribute. */
export function typeFromClass(value: ObjectClass): string {
  const found = CLASS_TO_TYPE.get(value);
  if (found === undefined) {
    throw new Pkcs11Error(`pkcs11: unsupported object class ${value}`);
  }
  return found;
}

/**
 * Refuses a URI that tries to carry the token PIN.
 *
 * RFC 7512 allows `pin-value` and `pin-source` as query attributes, but
 * honouring them would put the PIN in configuration, in logs, and in every
 * `keyRef` this provider returns. The PIN comes from a pin provider and from
 * nowhere else.
 */
function rejectPinAttributes(query: string): void {
  if (!query) return;
  for (const segment of query.split("&")) {
    const name = segment.split("=", 1)[0];
    if (name === "pin-value" || name === "pin-source") {
      throw new Pkcs11Error(
        `pkcs11: key uri must not carry ${JSON.stringify(name)}; supply the pin with the ` +
          "pin option",
      );
    }
  }
}

/**
 * Percent-decodes one attribute value into raw bytes, rejecting malformed
 * escapes.
 *
 * Decoding stops at bytes deliberately: `CKA_ID` is arbitrary binary, and
 * `decodeURIComponent` would insist every escape sequence form valid UTF-8 and
 * throw on the ones that do not. Go reaches the same result with
 * `url.PathUnescape`, whose result is a byte string.
 */
function unescapeAttribute(name: string, raw: string): Uint8Array {
  const out: number[] = [];
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (char !== "%") {
      // Non-escaped characters are ASCII in a well-formed URI; a stray
      // multi-byte character is encoded as its own UTF-8 bytes rather than
      // rejected, matching Go's tolerance here.
      for (const byte of encoder.encode(char)) out.push(byte);
      continue;
    }
    const hex = raw.slice(index + 1, index + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
      throw new Pkcs11Error(
        `pkcs11: decode attribute ${JSON.stringify(name)} in key uri: invalid escape ` +
          JSON.stringify(raw.slice(index, index + 3)),
      );
    }
    out.push(Number.parseInt(hex, 16));
    index += 2;
  }
  return Uint8Array.from(out);
}

/**
 * Parses an RFC 7512 `pkcs11:` URI. Attributes are separated by `;` and
 * percent-encoded, so a `CKA_ID` holding arbitrary bytes round-trips.
 */
export function parseKeyUri(reference: string): KeyUri {
  const trimmed = reference.trim();
  if (!isKeyUri(trimmed)) {
    throw new Pkcs11Error(`pkcs11: ${JSON.stringify(trimmed)} is not a pkcs11 uri`);
  }

  let body = trimmed.slice(URI_SCHEME.length);
  // RFC 7512 separates the path component from the query component with "?".
  const queryStart = body.indexOf("?");
  if (queryStart >= 0) {
    rejectPinAttributes(body.slice(queryStart + 1));
    body = body.slice(0, queryStart);
  }
  if (body === "") {
    throw new Pkcs11Error(`pkcs11: key uri ${JSON.stringify(trimmed)} has no attributes`);
  }

  const parsed: KeyUri = {};
  for (const segment of body.split(";")) {
    if (segment === "") continue;
    const separator = segment.indexOf("=");
    if (separator < 0) {
      throw new Pkcs11Error(`pkcs11: malformed attribute ${JSON.stringify(segment)} in key uri`);
    }
    const name = segment.slice(0, separator);
    const value = unescapeAttribute(name, segment.slice(separator + 1));

    switch (name) {
      case "token":
        parsed.token = decoder.decode(value);
        break;
      case "object":
        parsed.object = decoder.decode(value);
        break;
      case "id":
        parsed.id = value;
        break;
      case "type":
        parsed.class = classFromType(decoder.decode(value));
        break;
      default:
        // Unknown attributes (model, manufacturer, serial, library-*) are
        // accepted and ignored so a vendor-supplied URI still parses.
        break;
    }
  }

  if (!parsed.object && !(parsed.id && parsed.id.length > 0)) {
    throw new Pkcs11Error(`pkcs11: key uri ${JSON.stringify(trimmed)} must set object or id`);
  }
  return parsed;
}

/**
 * Formats a URI back to its RFC 7512 form. Attribute order is fixed so the
 * value is stable and comparable across calls.
 */
export function formatKeyUri(uri: KeyUri): string {
  const parts: string[] = [];
  if (uri.token) parts.push(`token=${escapeAttribute(encoder.encode(uri.token))}`);
  if (uri.object) parts.push(`object=${escapeAttribute(encoder.encode(uri.object))}`);
  if (uri.id && uri.id.length > 0) parts.push(`id=${escapeAttribute(uri.id)}`);
  if (uri.class !== undefined) parts.push(`type=${typeFromClass(uri.class)}`);
  return URI_SCHEME + parts.join(";");
}

/** Renders `CKA_ID` as lowercase hexadecimal, for `KeyData.keyId`. */
export function keyUriHexId(uri: KeyUri): string {
  if (!uri.id) return "";
  return Array.from(uri.id, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Reports whether `byte` can appear literally in an attribute value. RFC 7512
 * builds on RFC 3986 unreserved characters plus the path-safe subset that does
 * not collide with the `;` and `=` separators.
 */
function unreservedAttributeByte(byte: number): boolean {
  const char = String.fromCharCode(byte);
  if (/[A-Za-z0-9]/.test(char)) return true;
  return "-._~:[]@!$'()*+,".includes(char);
}

/**
 * Percent-encodes every byte that is not attribute-safe, so binary `CKA_ID`
 * values survive a format/parse round trip.
 */
function escapeAttribute(value: Uint8Array): string {
  let out = "";
  for (const byte of value) {
    out += unreservedAttributeByte(byte)
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}
