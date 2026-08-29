// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * In-memory {@link Pkcs11Module} used by the PKCS#11 tests.
 *
 * It is the counterpart of forge-go's `fake_module_test.go`: a token that
 * really performs the cryptography, so a round trip through the provider is a
 * genuine round trip, while the mechanism list, the login and the attribute
 * policy stay under the test's control. Cryptography is delegated to Web
 * Crypto, and key material is held as exported bytes and re-imported per
 * operation, because a token's keys are not bound to a single algorithm the
 * way a `CryptoKey` is.
 *
 * @module
 */

import {
  type Attribute,
  AttributeType,
  boolAttribute,
  bytesAttribute,
  EC_PARAMS,
  findAttribute,
  KeyType,
  Mechanism,
  ReturnValue,
  returnValueName,
  ulongAttribute,
  ulongValue,
} from "./cryptoki.ts";
import { Pkcs11TokenError } from "./errors.ts";
import type {
  MechanismParams,
  ObjectHandle,
  Pkcs11Module,
  SessionHandle,
  SlotInfo,
} from "./interface.ts";
import { ObjectClass } from "./uri.ts";

/** The mechanisms a PKCS#11 v3.0 token with HKDF advertises. */
export const FULL_MECHANISMS: number[] = [
  Mechanism.AesKeyGen,
  Mechanism.AesGcm,
  Mechanism.RsaPkcsKeyPairGen,
  Mechanism.RsaPkcsOaep,
  Mechanism.Sha256RsaPkcs,
  Mechanism.Sha256RsaPkcsPss,
  Mechanism.Sha256Hmac,
  Mechanism.Sha256,
  Mechanism.EcKeyPairGen,
  Mechanism.Ecdh1Derive,
  Mechanism.EcEdwardsKeyPairGen,
  Mechanism.EdDsa,
  Mechanism.GenericSecretKeyGen,
  Mechanism.HkdfDerive,
];

/** One object on the fake token. */
interface FakeObject {
  attributes: Map<number, Uint8Array>;
  /** Raw secret bytes for symmetric and derived keys. */
  secret?: Uint8Array;
  /** Exported PKCS#8 private key for asymmetric keys. */
  pkcs8?: Uint8Array;
  /** Named curve of an EC key, when it is one. */
  curve?: string;
}

/** Construction options for {@link FakeToken}. */
export interface FakeTokenOptions {
  /** The mechanisms `C_GetMechanismList` reports. Defaults to all of them. */
  mechanisms?: number[];
  /** The token label. */
  tokenLabel?: string;
  /** The slot id. */
  slotId?: number;
  /** Refuses to read `CKA_VALUE` off derived secrets, as a strict token does. */
  refuseSecretExtraction?: boolean;
}

/** A token that performs real cryptography entirely in memory. */
export class FakeToken implements Pkcs11Module {
  /** Number of `C_Login` calls, so tests can assert login happens once. */
  logins = 0;
  /** Number of sessions currently open. */
  openSessions = 0;
  /** Highest number of sessions open at the same time. */
  peakSessions = 0;

  #mechanisms: number[];
  #label: string;
  #slot: number;
  #refuseExtraction: boolean;
  #objects = new Map<ObjectHandle, FakeObject>();
  #nextObject = 1;
  #nextSession = 1;

  /** Creates a token, optionally restricting what it advertises. */
  constructor(options: FakeTokenOptions = {}) {
    this.#mechanisms = options.mechanisms ?? FULL_MECHANISMS;
    this.#label = options.tokenLabel ?? "forge-test";
    this.#slot = options.slotId ?? 0;
    this.#refuseExtraction = options.refuseSecretExtraction ?? false;
  }

  /** Reads one object, for assertions about what the provider wrote. */
  object(handle: ObjectHandle): FakeObject | undefined {
    return this.#objects.get(handle);
  }

  /** Lists every live object handle. */
  handles(): ObjectHandle[] {
    return [...this.#objects.keys()];
  }

  /** No-op: an in-memory token needs no initialization. */
  initialize(): Promise<void> {
    return Promise.resolve();
  }

  /** No-op. */
  finalize(): Promise<void> {
    return Promise.resolve();
  }

  /** Reports the single slot this token occupies. */
  slots(_tokenPresent: boolean): Promise<SlotInfo[]> {
    return Promise.resolve([{
      id: this.#slot,
      tokenLabel: this.#label,
      tokenPresent: true,
      maxSessions: 0,
    }]);
  }

  /** Reports the configured mechanism list. */
  mechanisms(_slot: number): Promise<number[]> {
    return Promise.resolve([...this.#mechanisms]);
  }

  /** Opens a session. */
  openSession(_slot: number): Promise<SessionHandle> {
    this.openSessions++;
    this.peakSessions = Math.max(this.peakSessions, this.openSessions);
    return Promise.resolve(this.#nextSession++);
  }

  /** Closes a session. */
  closeSession(_session: SessionHandle): Promise<void> {
    this.openSessions--;
    return Promise.resolve();
  }

  /** Counts a login. */
  login(_session: SessionHandle, _pin: string): Promise<void> {
    this.logins++;
    return Promise.resolve();
  }

  /** No-op. */
  logout(_session: SessionHandle): Promise<void> {
    return Promise.resolve();
  }

  /** Returns every object matching the template. */
  findObjects(_session: SessionHandle, template: Attribute[]): Promise<ObjectHandle[]> {
    const matches: ObjectHandle[] = [];
    for (const [handle, object] of this.#objects) {
      const ok = template.every((wanted) => {
        const held = object.attributes.get(wanted.type);
        return held !== undefined && sameBytes(held, wanted.value);
      });
      if (ok) matches.push(handle);
    }
    return Promise.resolve(matches);
  }

  /** Reads attributes, marking the ones the object does not carry absent. */
  getAttributes(
    _session: SessionHandle,
    object: ObjectHandle,
    types: number[],
  ): Promise<Attribute[]> {
    const held = this.#require(object);
    return Promise.resolve(types.map((type) => {
      if (type === AttributeType.Value && this.#refuseExtraction) {
        return { type, value: new Uint8Array(0), present: false };
      }
      const value = held.attributes.get(type);
      return value === undefined
        ? { type, value: new Uint8Array(0), present: false }
        : { type, value, present: true };
    }));
  }

  /** Writes attributes, rejecting a template naming one the object lacks. */
  setAttributes(
    _session: SessionHandle,
    object: ObjectHandle,
    template: Attribute[],
  ): Promise<void> {
    const held = this.#require(object);
    for (const attribute of template) {
      if (!held.attributes.has(attribute.type)) {
        return Promise.reject(tokenError("C_SetAttributeValue", ReturnValue.AttributeTypeInvalid));
      }
    }
    for (const attribute of template) held.attributes.set(attribute.type, attribute.value);
    return Promise.resolve();
  }

  /** Removes an object. */
  destroyObject(_session: SessionHandle, object: ObjectHandle): Promise<void> {
    this.#objects.delete(object);
    return Promise.resolve();
  }

  /** Creates an AES or generic secret key. */
  generateKey(
    _session: SessionHandle,
    mechanism: number,
    template: Attribute[],
  ): Promise<ObjectHandle> {
    this.#requireMechanism(mechanism);
    const attributes = toMap(template);
    const raw = attributes.get(AttributeType.ValueLen);
    const length = raw ? (ulongValue(raw) ?? 32) : 32;
    const secret = crypto.getRandomValues(new Uint8Array(length));
    withClass(attributes, ObjectClass.SecretKey);
    return Promise.resolve(this.#store({ attributes, secret }));
  }

  /** Creates an RSA, EC or Edwards key pair. */
  async generateKeyPair(
    _session: SessionHandle,
    mechanism: number,
    publicTemplate: Attribute[],
    privateTemplate: Attribute[],
  ): Promise<[ObjectHandle, ObjectHandle]> {
    this.#requireMechanism(mechanism);
    const publicAttributes = withClass(toMap(publicTemplate), ObjectClass.PublicKey);
    const privateAttributes = withClass(toMap(privateTemplate), ObjectClass.PrivateKey);

    if (mechanism === Mechanism.RsaPkcsKeyPairGen) {
      const raw = publicAttributes.get(AttributeType.ModulusBits);
      const bits = raw ? (ulongValue(raw) ?? 2048) : 2048;
      const pair = await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: bits,
          publicExponent: Uint8Array.from([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      ) as CryptoKeyPair;
      const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
      publicAttributes.set(AttributeType.KeyType, ulongAttribute(0, KeyType.Rsa).value);
      publicAttributes.set(AttributeType.Modulus, base64UrlBytes(jwk.n!));
      publicAttributes.set(AttributeType.PublicExponent, base64UrlBytes(jwk.e!));
      privateAttributes.set(AttributeType.KeyType, ulongAttribute(0, KeyType.Rsa).value);

      const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
      return [
        this.#store({ attributes: publicAttributes }),
        this.#store({ attributes: privateAttributes, pkcs8 }),
      ];
    }

    const edwards = mechanism === Mechanism.EcEdwardsKeyPairGen;
    const ecParams = publicAttributes.get(AttributeType.EcParams);
    const curve = edwards ? "Ed25519" : curveOf(ecParams);
    const algorithm = edwards ? { name: "Ed25519" } : { name: "ECDH", namedCurve: curve };
    const usages: KeyUsage[] = edwards ? ["sign", "verify"] : ["deriveBits"];
    const pair = await crypto.subtle.generateKey(algorithm, true, usages) as CryptoKeyPair;

    const point = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const keyType = edwards ? KeyType.EcEdwards : KeyType.Ec;
    publicAttributes.set(AttributeType.KeyType, ulongAttribute(0, keyType).value);
    publicAttributes.set(AttributeType.EcPoint, wrapOctetString(point));
    publicAttributes.set(AttributeType.EcParams, EC_PARAMS[curve]);
    privateAttributes.set(AttributeType.KeyType, ulongAttribute(0, keyType).value);
    privateAttributes.set(AttributeType.EcParams, EC_PARAMS[curve]);

    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    return [
      this.#store({ attributes: publicAttributes, curve }),
      this.#store({ attributes: privateAttributes, pkcs8, curve }),
    ];
  }

  /** Derives an ECDH shared secret or an HKDF key. */
  async deriveKey(
    _session: SessionHandle,
    mechanism: number,
    params: MechanismParams | undefined,
    base: ObjectHandle,
    template: Attribute[],
  ): Promise<ObjectHandle> {
    this.#requireMechanism(mechanism);
    const held = this.#require(base);
    const attributes = toMap(template);

    if (mechanism === Mechanism.Ecdh1Derive) {
      if (params?.kind !== "ecdh1") throw tokenError("C_DeriveKey", ReturnValue.ArgumentsBad);
      const curve = held.curve ?? "P-256";
      const privateKey = await crypto.subtle.importKey(
        "pkcs8",
        Uint8Array.from(held.pkcs8!),
        { name: "ECDH", namedCurve: curve },
        false,
        ["deriveBits"],
      );
      const peer = await crypto.subtle.importKey(
        "raw",
        Uint8Array.from(params.publicData),
        { name: "ECDH", namedCurve: curve },
        false,
        [],
      );
      const bits = { "P-256": 256, "P-384": 384, "P-521": 528 }[curve] ?? 256;
      const shared = new Uint8Array(
        await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, bits),
      );
      return this.#store({
        attributes: withClass(attributes, ObjectClass.SecretKey),
        secret: shared,
        curve,
      });
    }

    if (mechanism === Mechanism.HkdfDerive) {
      if (params?.kind !== "hkdf") throw tokenError("C_DeriveKey", ReturnValue.ArgumentsBad);
      const raw = attributes.get(AttributeType.ValueLen);
      const length = raw ? (ulongValue(raw) ?? 32) : 32;
      const hkdfKey = await crypto.subtle.importKey(
        "raw",
        Uint8Array.from(held.secret!),
        "HKDF",
        false,
        ["deriveBits"],
      );
      const derived = new Uint8Array(
        await crypto.subtle.deriveBits(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: new Uint8Array(0),
            info: Uint8Array.from(params.info),
          },
          hkdfKey,
          length * 8,
        ),
      );
      return this.#store({
        attributes: withClass(attributes, ObjectClass.SecretKey),
        secret: derived,
      });
    }

    throw tokenError("C_DeriveKey", ReturnValue.MechanismInvalid);
  }

  /** AES-GCM encryption. */
  async encrypt(
    _session: SessionHandle,
    mechanism: number,
    params: MechanismParams | undefined,
    key: ObjectHandle,
    plaintext: Uint8Array,
  ): Promise<Uint8Array> {
    this.#requireMechanism(mechanism);
    if (mechanism !== Mechanism.AesGcm || params?.kind !== "gcm") {
      throw tokenError("C_EncryptInit", ReturnValue.MechanismInvalid);
    }
    const aesKey = await this.#aesKey(key, ["encrypt"]);
    return new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: Uint8Array.from(params.iv),
          additionalData: Uint8Array.from(params.aad),
          tagLength: params.tagBits,
        },
        aesKey,
        Uint8Array.from(plaintext),
      ),
    );
  }

  /** AES-GCM or RSA-OAEP decryption. */
  async decrypt(
    _session: SessionHandle,
    mechanism: number,
    params: MechanismParams | undefined,
    key: ObjectHandle,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array> {
    this.#requireMechanism(mechanism);

    if (mechanism === Mechanism.AesGcm && params?.kind === "gcm") {
      const aesKey = await this.#aesKey(key, ["decrypt"]);
      return new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: Uint8Array.from(params.iv),
            additionalData: Uint8Array.from(params.aad),
            tagLength: params.tagBits,
          },
          aesKey,
          Uint8Array.from(ciphertext),
        ),
      );
    }

    if (mechanism === Mechanism.RsaPkcsOaep) {
      if (params?.kind !== "oaep" || params.hashAlg !== Mechanism.Sha256) {
        // A token that only implements OAEP with SHA-1 rejects the parameters.
        throw tokenError("C_DecryptInit", ReturnValue.MechanismParamInvalid);
      }
      const held = this.#require(key);
      const privateKey = await crypto.subtle.importKey(
        "pkcs8",
        Uint8Array.from(held.pkcs8!),
        { name: "RSA-OAEP", hash: "SHA-256" },
        false,
        ["decrypt"],
      );
      return new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "RSA-OAEP" },
          privateKey,
          Uint8Array.from(ciphertext),
        ),
      );
    }

    throw tokenError("C_DecryptInit", ReturnValue.MechanismInvalid);
  }

  /** HMAC, RSA and Ed25519 signing. */
  async sign(
    _session: SessionHandle,
    mechanism: number,
    params: MechanismParams | undefined,
    key: ObjectHandle,
    message: Uint8Array,
  ): Promise<Uint8Array> {
    this.#requireMechanism(mechanism);
    const held = this.#require(key);
    const data = Uint8Array.from(message);

    if (mechanism === Mechanism.Sha256Hmac) {
      const hmacKey = await crypto.subtle.importKey(
        "raw",
        Uint8Array.from(held.secret!),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      return new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, data));
    }

    if (mechanism === Mechanism.Sha256RsaPkcs) {
      const privateKey = await crypto.subtle.importKey(
        "pkcs8",
        Uint8Array.from(held.pkcs8!),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      );
      return new Uint8Array(
        await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, data),
      );
    }

    if (mechanism === Mechanism.Sha256RsaPkcsPss) {
      if (params?.kind !== "pss") throw tokenError("C_SignInit", ReturnValue.MechanismParamInvalid);
      const privateKey = await crypto.subtle.importKey(
        "pkcs8",
        Uint8Array.from(held.pkcs8!),
        { name: "RSA-PSS", hash: "SHA-256" },
        false,
        ["sign"],
      );
      return new Uint8Array(
        await crypto.subtle.sign(
          { name: "RSA-PSS", saltLength: params.saltLen },
          privateKey,
          data,
        ),
      );
    }

    if (mechanism === Mechanism.EdDsa) {
      const privateKey = await crypto.subtle.importKey(
        "pkcs8",
        Uint8Array.from(held.pkcs8!),
        { name: "Ed25519" },
        false,
        ["sign"],
      );
      return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, data));
    }

    throw tokenError("C_SignInit", ReturnValue.MechanismInvalid);
  }

  /** Not used by the provider, which verifies with the public half locally. */
  verify(): Promise<void> {
    return Promise.reject(tokenError("C_VerifyInit", ReturnValue.MechanismInvalid));
  }

  /** Imports the AES key behind an object handle. */
  async #aesKey(handle: ObjectHandle, usages: KeyUsage[]): Promise<CryptoKey> {
    const held = this.#require(handle);
    if (!held.secret) throw tokenError("C_EncryptInit", ReturnValue.KeyHandleInvalid);
    return await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(held.secret),
      { name: "AES-GCM" },
      false,
      usages,
    );
  }

  /** Stores an object and returns its handle. */
  #store(object: FakeObject): ObjectHandle {
    const handle = this.#nextObject++;
    if (object.secret && !isSensitive(object.attributes)) {
      object.attributes.set(AttributeType.Value, object.secret);
    }
    this.#objects.set(handle, object);
    return handle;
  }

  /** Looks up an object, or reports an invalid handle. */
  #require(handle: ObjectHandle): FakeObject {
    const held = this.#objects.get(handle);
    if (!held) throw tokenError("C_GetAttributeValue", ReturnValue.KeyHandleInvalid);
    return held;
  }

  /** Rejects a mechanism this token does not advertise. */
  #requireMechanism(mechanism: number): void {
    if (!this.#mechanisms.includes(mechanism)) {
      throw tokenError("C_GetMechanismInfo", ReturnValue.MechanismInvalid);
    }
  }
}

/** Builds the token error a Cryptoki call would raise. */
export function tokenError(fn: string, code: number): Pkcs11TokenError {
  return new Pkcs11TokenError(fn, code, returnValueName(code));
}

/** True when the template marks the key sensitive or non-extractable. */
function isSensitive(attributes: Map<number, Uint8Array>): boolean {
  const sensitive = attributes.get(AttributeType.Sensitive);
  const extractable = attributes.get(AttributeType.Extractable);
  return (sensitive?.[0] === 1) || (extractable !== undefined && extractable[0] === 0);
}

/**
 * Applies the `CKA_CLASS` a real token derives from the operation, which the
 * caller's template does not have to carry.
 */
function withClass(
  attributes: Map<number, Uint8Array>,
  objectClass: ObjectClass,
): Map<number, Uint8Array> {
  if (!attributes.has(AttributeType.Class)) {
    attributes.set(AttributeType.Class, ulongAttribute(0, objectClass).value);
  }
  return attributes;
}

/** Indexes a template by attribute type. */
function toMap(template: Attribute[]): Map<number, Uint8Array> {
  return new Map(template.map((attribute) => [attribute.type, attribute.value]));
}

/** Byte equality. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Wraps a point the way a specification-conforming token stores it. */
function wrapOctetString(value: Uint8Array): Uint8Array {
  const length = value.length < 0x80
    ? Uint8Array.from([value.length])
    : Uint8Array.from([0x81, value.length]);
  const out = new Uint8Array(1 + length.length + value.length);
  out.set([0x04], 0);
  out.set(length, 1);
  out.set(value, 1 + length.length);
  return out;
}

/** Maps `CKA_EC_PARAMS` back to a curve name. */
function curveOf(params: Uint8Array | undefined): string {
  if (params) {
    for (const [name, encoded] of Object.entries(EC_PARAMS)) {
      if (sameBytes(params, encoded)) return name;
    }
  }
  return "P-256";
}

/** Decodes a base64url JWK component into bytes. */
function base64UrlBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - padded.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Convenience: an attribute list holding one boolean, for tests. */
export function booleanTemplate(type: number, value: boolean): Attribute[] {
  return [boolAttribute(type, value)];
}

/** Convenience: builds a `CKA_CLASS` attribute, for tests. */
export function classAttribute(objectClass: ObjectClass): Attribute {
  return ulongAttribute(AttributeType.Class, objectClass);
}

/** Convenience: builds a `CKA_LABEL` attribute, for tests. */
export function labelAttribute(label: string): Attribute {
  return bytesAttribute(AttributeType.Label, new TextEncoder().encode(label));
}

/** Convenience: reads `CKA_LABEL` off an attribute list, for tests. */
export function labelOf(attributes: Attribute[]): string {
  const raw = findAttribute(attributes, AttributeType.Label);
  return raw ? new TextDecoder().decode(raw) : "";
}
