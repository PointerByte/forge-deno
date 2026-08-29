// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Object lookup and public-key reconstruction.
 *
 * A token hands back a public key as its raw components — `CKA_MODULUS` and
 * `CKA_PUBLIC_EXPONENT`, or `CKA_EC_POINT` and `CKA_EC_PARAMS` — while every
 * backend in this module reports public keys as Base64 SPKI. The DER writer
 * here closes that gap; Go gets it from `crypto/x509`, which has no Web Crypto
 * equivalent that accepts bare components.
 *
 * @module
 */

import {
  type Attribute,
  AttributeType,
  bytesAttribute,
  EC_PARAMS,
  findAttribute,
  ulongAttribute,
} from "./cryptoki.ts";
import { Pkcs11Error, Pkcs11KeyNotFoundError } from "./errors.ts";
import type { ObjectHandle, Pkcs11Module, SessionHandle } from "./interface.ts";
import { formatKeyUri, type KeyUri, ObjectClass } from "./uri.ts";
import { toBase64 } from "../utilities/utilities.ts";

/** Ed25519 public keys are always 32 bytes. */
const ED25519_PUBLIC_KEY_BYTES = 32;

// --- Object lookup ----------------------------------------------------------

/** Resolves a key URI to exactly one object handle. */
export async function findObject(
  mod: Pkcs11Module,
  session: SessionHandle,
  uri: KeyUri,
  objectClass: ObjectClass | undefined,
): Promise<ObjectHandle> {
  const template: Attribute[] = [];
  if (objectClass !== undefined) {
    template.push(ulongAttribute(AttributeType.Class, objectClass));
  }
  if (uri.object) template.push(bytesAttribute(AttributeType.Label, encode(uri.object)));
  if (uri.id && uri.id.length > 0) template.push(bytesAttribute(AttributeType.Id, uri.id));

  const handles = await mod.findObjects(session, template);
  if (handles.length === 0) throw new Pkcs11KeyNotFoundError(formatKeyUri(uri));
  return handles[0];
}

/**
 * Finds the object a URI names, honouring an explicit `type` attribute and
 * otherwise falling back to the class the operation needs.
 */
export async function resolveObject(
  mod: Pkcs11Module,
  session: SessionHandle,
  uri: KeyUri,
  fallback: ObjectClass,
): Promise<ObjectHandle> {
  if (uri.class !== undefined) return findObject(mod, session, uri, uri.class);
  try {
    return await findObject(mod, session, uri, fallback);
  } catch {
    return findObject(mod, session, uri, undefined);
  }
}

/**
 * Locates the public half of a key.
 *
 * Tokens vary widely here: some store a matching `CKO_PUBLIC_KEY`, many
 * smartcards and HSMs store only the private key alongside an X.509
 * certificate. Trying all three in order is what separates a `getKey` that
 * works on real hardware from one that only works on SoftHSM.
 */
export async function publicObjectFor(
  mod: Pkcs11Module,
  session: SessionHandle,
  uri: KeyUri,
): Promise<{ handle: ObjectHandle; objectClass: ObjectClass }> {
  const attempt = async (
    candidate: KeyUri,
    objectClass: ObjectClass,
  ): Promise<ObjectHandle | undefined> => {
    try {
      return await findObject(mod, session, candidate, objectClass);
    } catch {
      return undefined;
    }
  };

  const direct = await attempt(uri, ObjectClass.PublicKey);
  if (direct !== undefined) return { handle: direct, objectClass: ObjectClass.PublicKey };

  if (uri.id && uri.id.length > 0) {
    const byId: KeyUri = { token: uri.token, id: uri.id };
    const publicById = await attempt(byId, ObjectClass.PublicKey);
    if (publicById !== undefined) {
      return { handle: publicById, objectClass: ObjectClass.PublicKey };
    }
    const certificateById = await attempt(byId, ObjectClass.Certificate);
    if (certificateById !== undefined) {
      return { handle: certificateById, objectClass: ObjectClass.Certificate };
    }
  }

  const certificate = await attempt(uri, ObjectClass.Certificate);
  if (certificate !== undefined) {
    return { handle: certificate, objectClass: ObjectClass.Certificate };
  }
  throw new Pkcs11KeyNotFoundError(formatKeyUri(uri), "no public key or certificate");
}

// --- Public key reconstruction ---------------------------------------------

/**
 * Builds a Base64 SPKI RSA public key from `CKA_MODULUS` and
 * `CKA_PUBLIC_EXPONENT`, which is the encoding every other backend returns in
 * `KeyData.publicKey`.
 */
export function rsaPublicKeyFrom(attributes: Attribute[]): string {
  const modulus = findAttribute(attributes, AttributeType.Modulus);
  if (!modulus) throw new Pkcs11Error("pkcs11: object has no CKA_MODULUS");
  const exponent = findAttribute(attributes, AttributeType.PublicExponent);
  if (!exponent) throw new Pkcs11Error("pkcs11: object has no CKA_PUBLIC_EXPONENT");
  if (isZero(modulus) || isZero(exponent)) {
    throw new Pkcs11Error("pkcs11: object has an unusable rsa public key");
  }

  const algorithm = sequence(concat(OID_RSA_ENCRYPTION, DER_NULL));
  const key = sequence(concat(integer(modulus), integer(exponent)));
  return toBase64(sequence(concat(algorithm, bitString(key))));
}

/**
 * Builds a Base64 SPKI ECDH public key from `CKA_EC_POINT` and
 * `CKA_EC_PARAMS`.
 */
export function ecdhPublicKeyFrom(attributes: Attribute[]): string {
  const point = ecPointFrom(attributes);
  const params = findAttribute(attributes, AttributeType.EcParams);
  if (!params) throw new Pkcs11Error("pkcs11: object has no CKA_EC_PARAMS");
  // Validate the curve before emitting a key that names it.
  curveFromEcParams(params);

  const algorithm = sequence(concat(OID_EC_PUBLIC_KEY, params));
  return toBase64(sequence(concat(algorithm, bitString(point))));
}

/** Builds a Base64 SPKI Ed25519 public key from `CKA_EC_POINT`. */
export function ed25519PublicKeyFrom(attributes: Attribute[]): string {
  const point = ecPointFrom(attributes);
  if (point.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Pkcs11Error(
      `pkcs11: ed25519 public key has ${point.length} bytes, want ${ED25519_PUBLIC_KEY_BYTES}`,
    );
  }
  return toBase64(sequence(concat(sequence(EC_PARAMS["Ed25519"]), bitString(point))));
}

/**
 * Extracts the Base64 SPKI public key from a `CKO_CERTIFICATE` object's
 * `CKA_VALUE`, which holds the DER X.509 certificate.
 */
export function certificatePublicKey(attributes: Attribute[]): string {
  const der = findAttribute(attributes, AttributeType.Value);
  if (!der) throw new Pkcs11Error("pkcs11: certificate object has no CKA_VALUE");
  return toBase64(subjectPublicKeyInfo(der));
}

/** Reads and unwraps `CKA_EC_POINT`. */
export function ecPointFrom(attributes: Attribute[]): Uint8Array {
  const raw = findAttribute(attributes, AttributeType.EcPoint);
  if (!raw) throw new Pkcs11Error("pkcs11: object has no CKA_EC_POINT");
  return decodeEcPoint(raw);
}

/**
 * Extracts the SEC1 point from `CKA_EC_POINT`.
 *
 * The specification says the value is an ASN.1 OCTET STRING wrapping the
 * point, but several tokens return the bare point. The two cases are ambiguous
 * because `0x04` is both the OCTET STRING tag and the uncompressed-point
 * prefix, so the DER reading is only accepted when the unwrapped length is
 * consistent with an uncompressed point.
 */
export function decodeEcPoint(value: Uint8Array): Uint8Array {
  if (value.length === 0) throw new Pkcs11Error("pkcs11: empty CKA_EC_POINT");

  const unwrapped = readOctetString(value);
  if (unwrapped && isPlausibleEcPoint(unwrapped)) return unwrapped;
  if (isPlausibleEcPoint(value)) return value;
  throw new Pkcs11Error("pkcs11: CKA_EC_POINT is neither a wrapped nor a bare point");
}

/**
 * Reports whether `value` looks like an uncompressed SEC1 point (`0x04`
 * followed by two equal-length coordinates) or an Edwards point.
 */
function isPlausibleEcPoint(value: Uint8Array): boolean {
  if (value.length === ED25519_PUBLIC_KEY_BYTES) return true;
  return value.length > 1 && value[0] === 0x04 && (value.length - 1) % 2 === 0;
}

/** Maps a DER-encoded named curve OID to its Web Crypto curve name. */
export function curveFromEcParams(params: Uint8Array): string {
  for (const name of ["P-256", "P-384", "P-521"]) {
    if (equalBytes(params, EC_PARAMS[name])) return name;
  }
  throw new Pkcs11Error("pkcs11: unsupported curve in CKA_EC_PARAMS");
}

// --- Minimal DER ------------------------------------------------------------

const OID_RSA_ENCRYPTION = Uint8Array.from([
  0x06,
  0x09,
  0x2a,
  0x86,
  0x48,
  0x86,
  0xf7,
  0x0d,
  0x01,
  0x01,
  0x01,
]);
const OID_EC_PUBLIC_KEY = Uint8Array.from([0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
const DER_NULL = Uint8Array.from([0x05, 0x00]);

/** Concatenates byte arrays. */
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Encodes a DER definite length. */
function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.from([length]);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

/** Wraps `content` in a DER tag/length header. */
function tagged(tag: number, content: Uint8Array): Uint8Array {
  return concat(Uint8Array.from([tag]), derLength(content.length), content);
}

/** DER `SEQUENCE`. */
function sequence(content: Uint8Array): Uint8Array {
  return tagged(0x30, content);
}

/** DER `BIT STRING` with no unused bits. */
function bitString(content: Uint8Array): Uint8Array {
  return tagged(0x03, concat(Uint8Array.from([0x00]), content));
}

/**
 * DER `INTEGER` from a big-endian magnitude: leading zero bytes are dropped
 * and one is re-added when the high bit would otherwise make the value
 * negative.
 */
function integer(magnitude: Uint8Array): Uint8Array {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0x00) start++;
  const trimmed = magnitude.subarray(start);
  const content = (trimmed[0] & 0x80) !== 0
    ? concat(Uint8Array.from([0x00]), trimmed)
    : Uint8Array.from(trimmed);
  return tagged(0x02, content);
}

/** Reads a complete DER OCTET STRING, or undefined when `value` is not one. */
function readOctetString(value: Uint8Array): Uint8Array | undefined {
  const element = readElement(value, 0);
  if (!element || element.tag !== 0x04 || element.end !== value.length) return undefined;
  return value.subarray(element.start, element.end);
}

interface DerElement {
  tag: number;
  start: number;
  end: number;
}

/** Reads one DER tag/length/value header starting at `offset`. */
function readElement(bytes: Uint8Array, offset: number): DerElement | undefined {
  if (offset + 2 > bytes.length) return undefined;
  const tag = bytes[offset];
  let cursor = offset + 1;
  let length = bytes[cursor++];
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || cursor + count > bytes.length) return undefined;
    length = 0;
    for (let index = 0; index < count; index++) length = (length << 8) | bytes[cursor++];
  }
  if (cursor + length > bytes.length) return undefined;
  return { tag, start: cursor, end: cursor + length };
}

/**
 * Returns the `subjectPublicKeyInfo` of a DER X.509 certificate.
 *
 * `SubjectPublicKeyInfo` is the seventh element of `TBSCertificate` once the
 * optional `[0] version` is accounted for, so walking the structure is enough
 * — no certificate parser and no dependency is needed to re-emit a key this
 * module already reports in exactly that encoding.
 */
function subjectPublicKeyInfo(certificate: Uint8Array): Uint8Array {
  const outer = readElement(certificate, 0);
  if (!outer || outer.tag !== 0x30) {
    throw new Pkcs11Error("pkcs11: parse certificate: not a DER SEQUENCE");
  }
  const tbs = readElement(certificate, outer.start);
  if (!tbs || tbs.tag !== 0x30) {
    throw new Pkcs11Error("pkcs11: parse certificate: no tbsCertificate");
  }

  let cursor = tbs.start;
  const first = readElement(certificate, cursor);
  if (!first) throw new Pkcs11Error("pkcs11: parse certificate: truncated tbsCertificate");
  // [0] EXPLICIT version is optional; skip it when present.
  let remaining = first.tag === 0xa0 ? 6 : 5;
  if (first.tag === 0xa0) cursor = first.end;

  // serialNumber, signature, issuer, validity, subject.
  while (remaining > 1) {
    const element = readElement(certificate, cursor);
    if (!element) throw new Pkcs11Error("pkcs11: parse certificate: truncated tbsCertificate");
    cursor = element.end;
    remaining--;
  }

  const spki = readElement(certificate, cursor);
  if (!spki || spki.tag !== 0x30) {
    throw new Pkcs11Error("pkcs11: parse certificate: no subjectPublicKeyInfo");
  }
  return certificate.slice(cursor, spki.end);
}

/** True when every byte is zero. */
function isZero(value: Uint8Array): boolean {
  return value.every((byte) => byte === 0);
}

/** Constant-length byte comparison. */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** UTF-8 encodes a label. */
function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
