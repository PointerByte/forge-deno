// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PKCS#11 provider.
 *
 * Implements the same five repositories the local provider implements, so the
 * two are interchangeable at the call site, and routes each call by looking at
 * the key reference: a value starting with `pkcs11:` addresses an object on the
 * token, anything else is Base64 key material and is handled by the local
 * provider. That is the only fallback there is — when the token cannot perform
 * an operation it was asked to perform in hardware, the call fails rather than
 * quietly completing in software.
 *
 * @module
 */

import {
  type Attribute,
  AttributeType,
  boolAttribute,
  bytesAttribute,
  CKD_NULL,
  CKF_HKDF_SALT_NULL,
  CKG_MGF1_SHA256,
  CKZ_DATA_SPECIFIED,
  EC_PARAMS,
  findAttribute,
  GCM_NONCE_BYTES,
  GCM_TAG_BITS,
  hasAttribute,
  KeyType,
  Mechanism,
  mechanismName,
  ReturnValue,
  SHA256_DIGEST_INFO_PREFIX,
  textAttribute,
  ulongAttribute,
  ulongValue,
} from "./cryptoki.ts";
import {
  ECDH_HKDF_INFO_PREFIX,
  KeyLabelPrefix,
  PROVIDER,
  type ResolvedOptions,
  resolveKeyUri,
  resolveOptions,
  validateOptions,
} from "./config.ts";
import {
  Pkcs11Error,
  Pkcs11OaepHashUnsupportedError,
  Pkcs11SecretNotExtractableError,
  Pkcs11UnsupportedMechanismError,
} from "./errors.ts";
import {
  certificatePublicKey,
  ecdhPublicKeyFrom,
  ed25519PublicKeyFrom,
  publicObjectFor,
  resolveObject,
  rsaPublicKeyFrom,
} from "./keys.ts";
import { releaseModule, type SlotState, withSession } from "./session.ts";
import { formatKeyUri, isKeyUri, type KeyUri, keyUriHexId, ObjectClass } from "./uri.ts";
import type {
  MechanismParams,
  ObjectHandle,
  Pkcs11Module,
  Pkcs11Options,
  Pkcs11Repository,
  SessionHandle,
} from "./interface.ts";
import {
  type CurveAsymmetricKey,
  curveName,
  SizeAsymmetricKey,
  SizeSymmetricKey,
} from "../common/enums.ts";
import { LocalProvider } from "../local/repository.ts";
import type {
  DeactivateKeyRequest,
  DecryptAESRequest,
  ECDHDecodeRequest,
  ECDHEncodeRequest,
  EncryptAESRequest,
  GenerateECDHCurveKeyRequest,
  GenerateRSAKeyRequest,
  GenerateSymmetricKeyRequest,
  GetKeyRequest,
  KeyData,
  RotateKeyRequest,
  RSAOAEPDecodeRequest,
  RSAOAEPEncodeRequest,
} from "../models/models.ts";
import {
  bytesOf,
  decodeECCCipherPayload,
  fromBase64,
  runWithSignal,
  textOf,
  toBase64,
} from "../utilities/utilities.ts";

/** `CKA_ID` length for generated keys. */
const OBJECT_ID_BYTES = 16;

/** 65537, big-endian as PKCS#11 expects for `CKA_PUBLIC_EXPONENT`. */
const RSA_PUBLIC_EXPONENT = Uint8Array.from([0x01, 0x00, 0x01]);

/** SHA-256 digest length, the PSS salt length this provider pins. */
const SHA256_BYTES = 32;

/** The usage flags `deactivateKey` clears. */
const DEACTIVATABLE_ATTRIBUTES = [
  AttributeType.Encrypt,
  AttributeType.Decrypt,
  AttributeType.Sign,
  AttributeType.Verify,
  AttributeType.Wrap,
  AttributeType.Unwrap,
  AttributeType.Derive,
];

/** What an ECDH decrypt produced: a plaintext, or a secret to finish with. */
interface EcdhOutcome {
  plaintext?: Uint8Array;
  shared?: Uint8Array;
}

/**
 * How to produce one signature: which mechanism to invoke, which parameters it
 * takes, and what to feed it.
 *
 * A plan exists because tokens differ in whether they implement the combined
 * hash-and-sign mechanisms or only the raw ones. Choosing between them is a
 * choice among PKCS#11 mechanisms that all yield the same signature; it is
 * never a fallback to signing in software, which would silently void the
 * guarantee that the private key stayed in hardware.
 */
interface SignPlan {
  /** The `CKM_` mechanism to invoke. */
  mechanism: number;
  /** The parameter block the mechanism takes, if any. */
  params?: MechanismParams;
  /**
   * Tried once when the first attempt fails with `CKR_MECHANISM_PARAM_INVALID`.
   * Vendors disagree on whether some mechanisms accept a NULL parameter block,
   * and the disagreement is only visible at call time, not in
   * `C_GetMechanismList`.
   */
  retryParams?: MechanismParams;
  /** Turns the caller's message into the bytes the mechanism consumes. */
  prepare(message: string): Promise<Uint8Array>;
}

/** Feeds the message through unchanged, for mechanisms that hash internally. */
function identityMessage(message: string): Promise<Uint8Array> {
  return Promise.resolve(bytesOf(message));
}

/** Hashes the message, for raw mechanisms that expect a digest. */
async function sha256Digest(message: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytesOf(message)));
}

/** Hashes and prepends the `DigestInfo` header, for `CKM_RSA_PKCS`. */
async function sha256DigestInfo(message: string): Promise<Uint8Array> {
  const digest = await sha256Digest(message);
  const out = new Uint8Array(SHA256_DIGEST_INFO_PREFIX.length + digest.length);
  out.set(SHA256_DIGEST_INFO_PREFIX, 0);
  out.set(digest, SHA256_DIGEST_INFO_PREFIX.length);
  return out;
}

/** Picks the mechanism for RSASSA-PKCS1-v1_5 with SHA-256. */
function planRsaPkcs1v15(slot: SlotState): SignPlan {
  if (slot.supports(Mechanism.Sha256RsaPkcs)) {
    return { mechanism: Mechanism.Sha256RsaPkcs, prepare: identityMessage };
  }
  if (slot.supports(Mechanism.RsaPkcs)) {
    return { mechanism: Mechanism.RsaPkcs, prepare: sha256DigestInfo };
  }
  throw new Pkcs11UnsupportedMechanismError(mechanismName(Mechanism.Sha256RsaPkcs));
}

/**
 * Picks the mechanism for RSASSA-PSS with SHA-256.
 *
 * The salt length is pinned to the digest size, which is what the local
 * provider uses too, so a signature made on either side verifies on both.
 */
function planRsaPss(slot: SlotState): SignPlan {
  const params: MechanismParams = {
    kind: "pss",
    hashAlg: Mechanism.Sha256,
    mgf: CKG_MGF1_SHA256,
    saltLen: SHA256_BYTES,
  };
  if (slot.supports(Mechanism.Sha256RsaPkcsPss)) {
    return { mechanism: Mechanism.Sha256RsaPkcsPss, params, prepare: identityMessage };
  }
  if (slot.supports(Mechanism.RsaPkcsPss)) {
    return { mechanism: Mechanism.RsaPkcsPss, params, prepare: sha256Digest };
  }
  throw new Pkcs11UnsupportedMechanismError(mechanismName(Mechanism.Sha256RsaPkcsPss));
}

/**
 * Picks the mechanism for Ed25519. EdDSA is a pure signature scheme, so the
 * message is passed whole and never pre-hashed.
 */
function planEd25519(slot: SlotState): SignPlan {
  slot.requireMechanism(Mechanism.EdDsa);
  // CKM_EDDSA takes no parameters in the specification, but several tokens
  // reject a NULL block and require CK_EDDSA_PARAMS instead.
  return {
    mechanism: Mechanism.EdDsa,
    prepare: identityMessage,
    retryParams: { kind: "eddsa", phFlag: false },
  };
}

/**
 * Reports whether the token can run the whole ECDH decrypt path without the
 * derived secret ever leaving it.
 */
function supportsInHardwareEcdh(slot: SlotState): boolean {
  return slot.supports(Mechanism.Ecdh1Derive) && slot.supports(Mechanism.HkdfDerive) &&
    slot.supports(Mechanism.AesGcm);
}

/**
 * Reports whether the token rejected the parameter block rather than the
 * operation, which is the signal to retry with the alternative form.
 */
function isMechanismParamError(failure: unknown): boolean {
  const code = (failure as { code?: number } | undefined)?.code;
  return code === ReturnValue.MechanismParamInvalid || code === ReturnValue.ArgumentsBad;
}

/** Returns a random `CKA_ID` for a freshly generated key. */
function newObjectId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(OBJECT_ID_BYTES));
}

/**
 * Builds a `CKA_LABEL` following the `GoForge-*` convention the other backends
 * apply to generated keys.
 */
function newObjectLabel(prefix: string, uid?: string): string {
  return uid ? `${prefix}-${uid}` : `${prefix}-${Date.now()}`;
}

/**
 * The attribute set every generated private or secret key carries: it lives on
 * the token, it is sensitive, and it can never be read out. That
 * non-extractability is the whole point of using an HSM.
 */
function tokenKeyTemplate(label: string, id: Uint8Array): Attribute[] {
  return [
    boolAttribute(AttributeType.Token, true),
    boolAttribute(AttributeType.Private, true),
    boolAttribute(AttributeType.Sensitive, true),
    boolAttribute(AttributeType.Extractable, false),
    textAttribute(AttributeType.Label, label),
    bytesAttribute(AttributeType.Id, id),
  ];
}

/** The attribute set every generated public key carries. */
function publicKeyTemplate(label: string, id: Uint8Array): Attribute[] {
  return [
    boolAttribute(AttributeType.Token, true),
    boolAttribute(AttributeType.Private, false),
    textAttribute(AttributeType.Label, label),
    bytesAttribute(AttributeType.Id, id),
  ];
}

/** Validates the requested AES size, which `common` expresses in bytes. */
function aesValueLen(size: SizeSymmetricKey): number {
  if (size === SizeSymmetricKey.Key128Bits || size === SizeSymmetricKey.Key256Bits) return size;
  throw new Pkcs11Error(`pkcs11: unsupported symmetric key size: ${size}`);
}

/** Validates the requested RSA size against the sizes the module supports. */
function rsaModulusBits(size: SizeAsymmetricKey): number {
  if (
    size === SizeAsymmetricKey.Key2048Bits || size === SizeAsymmetricKey.Key3072Bits ||
    size === SizeAsymmetricKey.Key4096Bits
  ) {
    return size;
  }
  throw new Pkcs11Error(`pkcs11: unsupported rsa key size: ${size}`);
}

/** Encodes `CKA_EC_PARAMS` for a NIST curve. */
function ecParamsForCurve(curve: CurveAsymmetricKey): Uint8Array {
  const params = EC_PARAMS[curveName(curve)];
  if (!params) throw new Pkcs11Error(`pkcs11: unsupported ecc curve: ${curve}`);
  return params;
}

/** Builds the {@link KeyData} a token-backed key is described by. */
function keyDataFor(uri: KeyUri, publicKey: string): KeyData {
  return {
    publicKey,
    keyId: keyUriHexId(uri),
    keyRef: formatKeyUri(uri),
    provider: PROVIDER,
  };
}

/** Materialises whichever key type the object holds. */
function publicKeyFromAttributes(attributes: Attribute[]): string {
  const rawType = findAttribute(attributes, AttributeType.KeyType);
  if (!rawType) throw new Pkcs11Error("pkcs11: object has no CKA_KEY_TYPE");
  const decoded = ulongValue(rawType);
  if (decoded === undefined) throw new Pkcs11Error("pkcs11: CKA_KEY_TYPE is not a CK_ULONG");

  switch (decoded) {
    case KeyType.Rsa:
      return rsaPublicKeyFrom(attributes);
    case KeyType.Ec:
      return ecdhPublicKeyFrom(attributes);
    case KeyType.EcEdwards:
      return ed25519PublicKeyFrom(attributes);
    default:
      throw new Pkcs11Error(`pkcs11: unsupported key type ${decoded}`);
  }
}

/**
 * Strips a previously appended rotation suffix so repeated rotations do not
 * accumulate timestamps.
 */
function rotationLabelBase(attributes: Attribute[], uri: KeyUri): string {
  const raw = findAttribute(attributes, AttributeType.Label);
  const label = raw && raw.length > 0 ? textOf(raw) : (uri.object ?? "");
  for (const prefix of Object.values(KeyLabelPrefix)) {
    if (label.startsWith(prefix)) return prefix;
  }
  return label;
}

/**
 * PKCS#11-backed implementation of every encrypt repository. Construct it
 * directly or via {@link newPkcs11Provider}.
 */
export class Pkcs11Provider implements Pkcs11Repository {
  #options: ResolvedOptions;
  #local = new LocalProvider();

  /** Creates a provider; nothing is loaded until the first operation. */
  constructor(options: Pkcs11Options = {}) {
    this.#options = resolveOptions(options);
  }

  /**
   * Releases this process's sessions on the configured library.
   *
   * It is deliberately not part of any repository interface: adding it there
   * would force a no-op `close` on the local and cloud providers. It does not
   * finalize the library by default, which would tear down state shared by
   * every consumer in the process.
   */
  close(finalize = false): Promise<void> {
    if (this.#options.module || this.#options.modulePath === "") return Promise.resolve();
    return releaseModule(this.#options.modulePath, finalize);
  }

  /**
   * Validates the configuration, then runs `operation` on a logged-in session.
   *
   * Validation and every precondition a caller can get wrong run inside the
   * promise chain, so a repository method always rejects and never throws
   * synchronously — the contract the local provider keeps through
   * `runWithSignal`.
   */
  #onToken<T>(
    signal: AbortSignal | undefined,
    operation: (module: Pkcs11Module, slot: SlotState, session: SessionHandle) => Promise<T>,
  ): Promise<T> {
    return runWithSignal(signal, () => {
      validateOptions(this.#options);
      return withSession(this.#options, signal, operation);
    });
  }

  /**
   * Reports whether `reference` addresses the token.
   *
   * The decision is exact rather than heuristic: only the `pkcs11:` scheme
   * routes to hardware, and an empty reference falls back to the configured
   * default URI when there is one.
   */
  #routesToToken(reference: string): boolean {
    return isKeyUri(reference) || (reference.trim() === "" && this.#options.keyUri !== "");
  }

  /** Reads the Base64 SPKI public key behind a token key URI. */
  #fetchPublicKey(uri: KeyUri, signal?: AbortSignal): Promise<string> {
    return this.#onToken(signal, async (module, _slot, session) => {
      const { handle, objectClass } = await publicObjectFor(module, session, uri);
      if (objectClass === ObjectClass.Certificate) {
        return certificatePublicKey(
          await module.getAttributes(session, handle, [AttributeType.Value]),
        );
      }
      return publicKeyFromAttributes(
        await module.getAttributes(session, handle, [
          AttributeType.KeyType,
          AttributeType.Modulus,
          AttributeType.PublicExponent,
          AttributeType.EcPoint,
          AttributeType.EcParams,
        ]),
      );
    });
  }

  /** Resolves a token reference to a Base64 public key. */
  #fetchVerificationKey(reference: string, signal?: AbortSignal): Promise<string> {
    return this.#fetchPublicKey(resolveKeyUri(this.#options, reference), signal);
  }

  // --- Symmetric ----------------------------------------------------------

  /** Creates a non-extractable AES key on the token and returns its URI. */
  generateSymmetricKeys(input: GenerateSymmetricKeyRequest): Promise<KeyData> {
    const id = newObjectId();
    const label = newObjectLabel(KeyLabelPrefix.Symmetric, input.uid);

    return this.#onToken(input.signal, async (module, slot, session) => {
      const valueLen = aesValueLen(input.size);
      slot.requireMechanism(Mechanism.AesKeyGen);
      await module.generateKey(session, Mechanism.AesKeyGen, [
        ...tokenKeyTemplate(label, id),
        ulongAttribute(AttributeType.KeyType, KeyType.Aes),
        ulongAttribute(AttributeType.Class, ObjectClass.SecretKey),
        ulongAttribute(AttributeType.ValueLen, valueLen),
        boolAttribute(AttributeType.Encrypt, true),
        boolAttribute(AttributeType.Decrypt, true),
      ]);
      return keyDataFor({ object: label, id, class: ObjectClass.SecretKey }, "");
    });
  }

  /**
   * Encrypts with a token AES key referenced by a `pkcs11:` URI, or with a
   * Base64 AES key locally. Both paths produce the same wire format.
   */
  encryptAES(input: EncryptAESRequest): Promise<string> {
    if (!this.#routesToToken(input.secretKey)) return this.#local.encryptAES(input);
    const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));

    return this.#onToken(input.signal, async (module, slot, session) => {
      const uri = resolveKeyUri(this.#options, input.secretKey);
      slot.requireMechanism(Mechanism.AesGcm);
      const handle = await resolveObject(module, session, uri, ObjectClass.SecretKey);
      const ciphertext = await module.encrypt(
        session,
        Mechanism.AesGcm,
        gcm(nonce, input.additional),
        handle,
        bytesOf(input.value),
      );
      // nonce || ciphertext || tag, which is byte-for-byte what the local
      // provider produces, so either side can decrypt the other's output.
      const out = new Uint8Array(nonce.length + ciphertext.length);
      out.set(nonce, 0);
      out.set(ciphertext, nonce.length);
      return toBase64(out);
    });
  }

  /** Decrypts ciphertext produced by {@link Pkcs11Provider.encryptAES}. */
  decryptAES(input: DecryptAESRequest): Promise<string> {
    if (!this.#routesToToken(input.secretKey)) return this.#local.decryptAES(input);

    return this.#onToken(input.signal, async (module, slot, session) => {
      const uri = resolveKeyUri(this.#options, input.secretKey);
      slot.requireMechanism(Mechanism.AesGcm);
      const raw = fromBase64(input.cipherValue);
      if (raw.length <= GCM_NONCE_BYTES) {
        throw new Pkcs11Error("pkcs11: ciphertext is shorter than the nonce");
      }
      const handle = await resolveObject(module, session, uri, ObjectClass.SecretKey);
      const plaintext = await module.decrypt(
        session,
        Mechanism.AesGcm,
        gcm(raw.subarray(0, GCM_NONCE_BYTES), input.additional),
        handle,
        raw.subarray(GCM_NONCE_BYTES),
      );
      return textOf(plaintext);
    });
  }

  // --- Asymmetric ---------------------------------------------------------

  /** Creates an RSA key pair on the token with a non-extractable private half. */
  generateRSAKeys(input: GenerateRSAKeyRequest): Promise<KeyData> {
    const id = newObjectId();
    const label = newObjectLabel(KeyLabelPrefix.Rsa, input.uid);

    return this.#onToken(input.signal, async (module, slot, session) => {
      const modulusBits = rsaModulusBits(input.size);
      slot.requireMechanism(Mechanism.RsaPkcsKeyPairGen);
      const [publicHandle] = await module.generateKeyPair(
        session,
        Mechanism.RsaPkcsKeyPairGen,
        [
          ...publicKeyTemplate(label, id),
          ulongAttribute(AttributeType.ModulusBits, modulusBits),
          bytesAttribute(AttributeType.PublicExponent, RSA_PUBLIC_EXPONENT),
          boolAttribute(AttributeType.Encrypt, true),
          boolAttribute(AttributeType.Verify, true),
          boolAttribute(AttributeType.Wrap, true),
        ],
        [
          ...tokenKeyTemplate(label, id),
          boolAttribute(AttributeType.Decrypt, true),
          boolAttribute(AttributeType.Sign, true),
          boolAttribute(AttributeType.Unwrap, true),
        ],
      );
      const attributes = await module.getAttributes(session, publicHandle, [
        AttributeType.Modulus,
        AttributeType.PublicExponent,
      ]);
      return keyDataFor(
        { object: label, id, class: ObjectClass.PrivateKey },
        rsaPublicKeyFrom(attributes),
      );
    });
  }

  /** Creates an ECC key pair on the token for the requested curve. */
  generateECDHCurveKeys(input: GenerateECDHCurveKeyRequest): Promise<KeyData> {
    const id = newObjectId();
    const label = newObjectLabel(KeyLabelPrefix.Ecdh, input.uid);

    return this.#onToken(input.signal, async (module, slot, session) => {
      const ecParams = ecParamsForCurve(input.curve);
      slot.requireMechanism(Mechanism.EcKeyPairGen);
      const [publicHandle] = await module.generateKeyPair(
        session,
        Mechanism.EcKeyPairGen,
        [...publicKeyTemplate(label, id), bytesAttribute(AttributeType.EcParams, ecParams)],
        [...tokenKeyTemplate(label, id), boolAttribute(AttributeType.Derive, true)],
      );
      const attributes = await module.getAttributes(session, publicHandle, [
        AttributeType.EcPoint,
        AttributeType.EcParams,
      ]);
      return keyDataFor(
        { object: label, id, class: ObjectClass.PrivateKey },
        ecdhPublicKeyFrom(attributes),
      );
    });
  }

  /**
   * Encrypts with a token key reference or a Base64 RSA public key.
   *
   * Encryption needs no secret, so the token is only asked for the public half
   * and the operation finishes locally. That keeps the output format identical
   * to the other backends and avoids `CK_RSA_PKCS_OAEP_PARAMS`, which several
   * tokens reject.
   */
  async rsaOaepEncode(input: RSAOAEPEncodeRequest): Promise<string> {
    if (!this.#routesToToken(input.publicKey)) return this.#local.rsaOaepEncode(input);
    const publicKey = await this.#fetchVerificationKey(input.publicKey, input.signal);
    return this.#local.rsaOaepEncode({ ...input, publicKey });
  }

  /** Decrypts with a token key reference or a Base64 RSA private key. */
  rsaOaepDecode(input: RSAOAEPDecodeRequest): Promise<string> {
    if (!this.#routesToToken(input.privateKey)) return this.#local.rsaOaepDecode(input);

    return this.#onToken(input.signal, async (module, slot, session) => {
      const uri = resolveKeyUri(this.#options, input.privateKey);
      slot.requireMechanism(Mechanism.RsaPkcsOaep);
      const handle = await resolveObject(module, session, uri, ObjectClass.PrivateKey);
      // Source is CKZ_DATA_SPECIFIED even though the label is empty: a zero
      // source makes strict tokens reject C_DecryptInit outright.
      const params: MechanismParams = {
        kind: "oaep",
        hashAlg: Mechanism.Sha256,
        mgf: CKG_MGF1_SHA256,
        source: CKZ_DATA_SPECIFIED,
      };
      try {
        return textOf(
          await module.decrypt(
            session,
            Mechanism.RsaPkcsOaep,
            params,
            handle,
            fromBase64(input.cipherText),
          ),
        );
      } catch (cause) {
        // The token advertises CKM_RSA_PKCS_OAEP but refuses the digest, which
        // C_GetMechanismList cannot express. Say so plainly instead of
        // surfacing a bare CKR_ARGUMENTS_BAD.
        if (isMechanismParamError(cause)) throw new Pkcs11OaepHashUnsupportedError({ cause });
        throw cause;
      }
    });
  }

  /** Encrypts with a token key reference or a Base64 ECC public key. */
  async ecdhEncode(input: ECDHEncodeRequest): Promise<string> {
    if (!this.#routesToToken(input.publicKey)) return this.#local.ecdhEncode(input);
    const publicKey = await this.#fetchVerificationKey(input.publicKey, input.signal);
    return this.#local.ecdhEncode({ ...input, publicKey });
  }

  /**
   * Decrypts a payload produced by {@link Pkcs11Provider.ecdhEncode}.
   *
   * The payload format is shared with the local provider: the AES key is
   * HKDF-SHA256 over the raw shared secret with an empty salt and a
   * curve-specific info string. Reproducing it on a token takes one of two
   * paths.
   *
   * When the token implements `CKM_HKDF_DERIVE` (PKCS#11 v3.0), both the shared
   * secret and the AES key stay inside the hardware. Otherwise the shared
   * secret is read out and the derivation finishes locally, which is what the
   * `aws-kms` and `azure-key-vault` backends already do: what leaves the token
   * there is an ephemeral per-message secret, never long-term key material. A
   * token whose policy forbids it fails instead — the payload format is never
   * silently changed.
   */
  ecdhDecode(input: ECDHDecodeRequest): Promise<string> {
    if (!this.#routesToToken(input.privateKey)) return this.#local.ecdhDecode(input);

    return runWithSignal(input.signal, async () => {
      const uri = resolveKeyUri(this.#options, input.privateKey);
      const payload = decodeECCCipherPayload(input.cipherText);
      const peerPoint = await ecdhPeerPoint(payload.ephemeralPublicKey, payload.curve);
      const nonce = fromBase64(payload.nonce);
      const ciphertext = fromBase64(payload.cipherText);
      const info = bytesOf(ECDH_HKDF_INFO_PREFIX + payload.curve);

      const outcome = await this.#onToken<EcdhOutcome>(
        input.signal,
        async (module, slot, session) => {
          slot.requireMechanism(Mechanism.Ecdh1Derive);
          const privateKey = await resolveObject(module, session, uri, ObjectClass.PrivateKey);

          if (supportsInHardwareEcdh(slot)) {
            try {
              return {
                plaintext: await decryptEcdhInHardware(
                  module,
                  session,
                  privateKey,
                  peerPoint,
                  info,
                  nonce,
                  ciphertext,
                ),
              };
            } catch (failure) {
              // The mechanism list is optimistic on some tokens; fall through
              // to extraction only when extraction is permitted.
              if (!this.#options.allowSecretExtraction) throw failure;
            }
          }
          if (!this.#options.allowSecretExtraction) throw new Pkcs11SecretNotExtractableError();
          return {
            shared: await deriveExtractableSecret(module, session, privateKey, peerPoint),
          };
        },
      );

      if (outcome.plaintext) return textOf(outcome.plaintext);
      return textOf(
        await decryptWithSharedSecret(outcome.shared!, payload.curve, info, nonce, ciphertext),
      );
    });
  }

  // --- Key management -----------------------------------------------------

  /**
   * Generates a replacement key and returns its reference.
   *
   * PKCS#11 has no native rotation, so this synthesises it: the descriptor of
   * the existing object is read, an equivalent key is generated with a fresh
   * `CKA_ID`, and the new reference is returned. The `keyRef` therefore
   * changes, and the previous key is left usable so existing ciphertext stays
   * decryptable, unless `rotateDisablesPrevious` was set.
   */
  rotateKey(input: RotateKeyRequest): Promise<KeyData> {
    const id = newObjectId();

    return this.#onToken(input.signal, async (module, slot, session) => {
      const uri = resolveKeyUri(this.#options, input.keyId);
      const handle = await resolveObject(module, session, uri, ObjectClass.PrivateKey);
      const attributes = await module.getAttributes(session, handle, [
        AttributeType.Class,
        AttributeType.KeyType,
        AttributeType.Label,
        AttributeType.ValueLen,
        AttributeType.ModulusBits,
        AttributeType.EcParams,
      ]);

      const label = newObjectLabel(rotationLabelBase(attributes, uri), input.uid);
      const rotated = await generateReplacement(module, slot, session, attributes, label, id);
      if (this.#options.rotateDisablesPrevious) await disableObject(module, session, handle);
      return rotated;
    });
  }

  /** Returns provider metadata and public material for a key reference. */
  async getKey(input: GetKeyRequest): Promise<KeyData> {
    const resolved = await this.#onToken<KeyUri>(input.signal, async (module, _slot, session) => {
      const uri = resolveKeyUri(this.#options, input.keyId);
      const handle = await resolveObject(module, session, uri, ObjectClass.PrivateKey);
      const attributes = await module.getAttributes(session, handle, [
        AttributeType.Label,
        AttributeType.Id,
        AttributeType.Class,
      ]);
      const label = findAttribute(attributes, AttributeType.Label);
      const id = findAttribute(attributes, AttributeType.Id);
      return {
        ...uri,
        object: label && label.length > 0 ? textOf(label) : uri.object,
        id: id && id.length > 0 ? id : uri.id,
      };
    });

    // A key with no exportable public half (a bare AES key) is not an error;
    // the reference alone is what the caller needs.
    let publicKey = "";
    try {
      publicKey = await this.#fetchPublicKey(resolved, input.signal);
    } catch {
      publicKey = "";
    }
    return keyDataFor(resolved, publicKey);
  }

  /**
   * Clears the usage attributes of a token key.
   *
   * Unlike the cloud backends, this is effectively irreversible: PKCS#11 usage
   * attributes are one-way on the great majority of tokens, so a key disabled
   * here generally cannot be re-enabled. Tokens that refuse the write raise
   * rather than losing the key, unless `deactivateDestroys` was set.
   */
  deactivateKey(input: DeactivateKeyRequest): Promise<void> {
    return this.#onToken(input.signal, async (module, _slot, session) => {
      const uri = resolveKeyUri(this.#options, input.keyId);
      const handle = await resolveObject(module, session, uri, ObjectClass.PrivateKey);
      try {
        await disableObject(module, session, handle);
      } catch (failure) {
        if (!this.#options.deactivateDestroys) throw failure;
        await module.destroyObject(session, handle);
      }
    });
  }

  // --- Hashing ------------------------------------------------------------

  /**
   * Generates an HMAC-SHA256 on the token when `secretKey` is a `pkcs11:` URI,
   * or locally otherwise.
   *
   * The token key must be a `CKK_GENERIC_SECRET` carrying `CKA_SIGN`.
   * {@link Pkcs11Provider.generateSymmetricKeys} makes a `CKK_AES` key for
   * `encryptAES`, and most tokens refuse to MAC with it, so HMAC keys are
   * provisioned separately — the same way the AWS backend needs a KMS HMAC key
   * rather than an encryption key.
   */
  hmac(secretKey: string, message: string, signal?: AbortSignal): Promise<string> {
    if (!this.#routesToToken(secretKey)) return this.#local.hmac(secretKey, message, signal);

    return this.#onToken(signal, async (module, slot, session) => {
      const uri = resolveKeyUri(this.#options, secretKey);
      slot.requireMechanism(Mechanism.Sha256Hmac);
      const handle = await resolveObject(module, session, uri, ObjectClass.SecretKey);
      return toBase64(
        await module.sign(session, Mechanism.Sha256Hmac, undefined, handle, bytesOf(message)),
      );
    });
  }

  /** Returns the SHA-256 digest as hexadecimal. */
  sha256Hex(message: string, signal?: AbortSignal): Promise<string> {
    // Digesting public data on the token buys nothing and costs a round trip.
    return this.#local.sha256Hex(message, signal);
  }

  /** Returns the BLAKE3 digest encoded as Base64. */
  blake3(message: string, signal?: AbortSignal): Promise<string> {
    // PKCS#11 has no BLAKE3 mechanism.
    return this.#local.blake3(message, signal);
  }

  // --- Signatures ---------------------------------------------------------

  /** Creates an Ed25519 signing key on the token. */
  generateEd25519Keys(signal?: AbortSignal): Promise<KeyData> {
    const id = newObjectId();
    const label = newObjectLabel(KeyLabelPrefix.Ed25519);

    return this.#onToken(signal, async (module, slot, session) => {
      slot.requireMechanism(Mechanism.EcEdwardsKeyPairGen);
      const [publicHandle] = await module.generateKeyPair(
        session,
        Mechanism.EcEdwardsKeyPairGen,
        [
          ...publicKeyTemplate(label, id),
          bytesAttribute(AttributeType.EcParams, EC_PARAMS["Ed25519"]),
          boolAttribute(AttributeType.Verify, true),
        ],
        [...tokenKeyTemplate(label, id), boolAttribute(AttributeType.Sign, true)],
      );
      const attributes = await module.getAttributes(session, publicHandle, [AttributeType.EcPoint]);
      return keyDataFor(
        { object: label, id, class: ObjectClass.PrivateKey },
        ed25519PublicKeyFrom(attributes),
      );
    });
  }

  /** Resolves a private key on the token and signs with the plan the slot allows. */
  #signWithToken(
    reference: string,
    message: string,
    plan: (slot: SlotState) => SignPlan,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.#onToken(signal, async (module, slot, session) => {
      const uri = resolveKeyUri(this.#options, reference);
      const chosen = plan(slot);
      const handle = await resolveObject(module, session, uri, ObjectClass.PrivateKey);
      const payload = await chosen.prepare(message);
      try {
        return toBase64(
          await module.sign(session, chosen.mechanism, chosen.params, handle, payload),
        );
      } catch (failure) {
        if (!chosen.retryParams || !isMechanismParamError(failure)) throw failure;
        return toBase64(
          await module.sign(session, chosen.mechanism, chosen.retryParams, handle, payload),
        );
      }
    });
  }

  /** Signs with a token key reference or a Base64 Ed25519 private key. */
  signEd25519(privateKey: string, text: string, signal?: AbortSignal): Promise<string> {
    if (!this.#routesToToken(privateKey)) return this.#local.signEd25519(privateKey, text, signal);
    return this.#signWithToken(privateKey, text, planEd25519, signal);
  }

  /**
   * Verifies locally after fetching the token public key.
   *
   * Verification needs no secret, so completing it in software saves a round
   * trip and removes `CKM_EDDSA` verification from the set of mechanisms a
   * token must support.
   */
  async verifyEd25519(
    publicKey: string,
    text: string,
    signature: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.#routesToToken(publicKey)) {
      return this.#local.verifyEd25519(publicKey, text, signature, signal);
    }
    const fetched = await this.#fetchVerificationKey(publicKey, signal);
    return this.#local.verifyEd25519(fetched, text, signature, signal);
  }

  /** Signs with a token RSA key reference or a Base64 RSA private key. */
  signRSAPSS(privateKey: string, text: string, signal?: AbortSignal): Promise<string> {
    if (!this.#routesToToken(privateKey)) return this.#local.signRSAPSS(privateKey, text, signal);
    return this.#signWithToken(privateKey, text, planRsaPss, signal);
  }

  /** Verifies locally after fetching the token public key. */
  async verifyRSAPSS(
    publicKey: string,
    text: string,
    signature: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.#routesToToken(publicKey)) {
      return this.#local.verifyRSAPSS(publicKey, text, signature, signal);
    }
    const fetched = await this.#fetchVerificationKey(publicKey, signal);
    return this.#local.verifyRSAPSS(fetched, text, signature, signal);
  }

  /** Signs data with RSA PKCS#1 v1.5 on the token, or locally. */
  signRSAPKCS1v15SHA256(privateKey: string, data: string, signal?: AbortSignal): Promise<string> {
    if (!this.#routesToToken(privateKey)) {
      return this.#local.signRSAPKCS1v15SHA256(privateKey, data, signal);
    }
    return this.#signWithToken(privateKey, data, planRsaPkcs1v15, signal);
  }

  /** Verifies an RSA PKCS#1 v1.5 SHA-256 signature. */
  async verifyRSAPKCS1v15SHA256(
    data: string,
    publicKey: string,
    signature: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.#routesToToken(publicKey)) {
      return this.#local.verifyRSAPKCS1v15SHA256(data, publicKey, signature, signal);
    }
    const fetched = await this.#fetchVerificationKey(publicKey, signal);
    return this.#local.verifyRSAPKCS1v15SHA256(data, fetched, signature, signal);
  }
}

/** Factory constructor. */
export function newPkcs11Provider(options: Pkcs11Options = {}): Pkcs11Provider {
  return new Pkcs11Provider(options);
}

/** Builds the AES-GCM parameter block shared by encrypt and decrypt. */
function gcm(iv: Uint8Array, additional?: string): MechanismParams {
  return {
    kind: "gcm",
    iv: Uint8Array.from(iv),
    aad: additional ? bytesOf(additional) : new Uint8Array(0),
    tagBits: GCM_TAG_BITS,
  };
}

/**
 * Extracts the bare SEC1 point from the Base64 SPKI ephemeral public key in an
 * ECDH payload. `C_DeriveKey` wants the bare point, which is the opposite
 * convention to `CKA_EC_POINT`.
 */
async function ecdhPeerPoint(encoded: string, curve: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "spki",
    fromBase64(encoded),
    { name: "ECDH", namedCurve: curve },
    true,
    [],
  );
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

/**
 * Runs the whole ECDH decrypt inside the token, so no derived material ever
 * crosses the boundary.
 */
async function decryptEcdhInHardware(
  module: Pkcs11Module,
  session: SessionHandle,
  privateKey: ObjectHandle,
  peerPoint: Uint8Array,
  info: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const secretHandle = await module.deriveKey(
    session,
    Mechanism.Ecdh1Derive,
    { kind: "ecdh1", kdf: CKD_NULL, sharedData: new Uint8Array(0), publicData: peerPoint },
    privateKey,
    [
      ulongAttribute(AttributeType.Class, ObjectClass.SecretKey),
      ulongAttribute(AttributeType.KeyType, KeyType.GenericSecret),
      boolAttribute(AttributeType.Token, false),
      boolAttribute(AttributeType.Sensitive, true),
      boolAttribute(AttributeType.Extractable, false),
      boolAttribute(AttributeType.Derive, true),
    ],
  );

  try {
    const aesHandle = await module.deriveKey(
      session,
      Mechanism.HkdfDerive,
      {
        kind: "hkdf",
        extract: true,
        expand: true,
        prf: Mechanism.Sha256,
        saltType: CKF_HKDF_SALT_NULL,
        info,
      },
      secretHandle,
      [
        ulongAttribute(AttributeType.Class, ObjectClass.SecretKey),
        ulongAttribute(AttributeType.KeyType, KeyType.Aes),
        ulongAttribute(AttributeType.ValueLen, SizeSymmetricKey.Key256Bits),
        boolAttribute(AttributeType.Token, false),
        boolAttribute(AttributeType.Sensitive, true),
        boolAttribute(AttributeType.Extractable, false),
        boolAttribute(AttributeType.Decrypt, true),
      ],
    );
    try {
      return await module.decrypt(session, Mechanism.AesGcm, gcm(nonce), aesHandle, ciphertext);
    } finally {
      await module.destroyObject(session, aesHandle).catch(() => {});
    }
  } finally {
    await module.destroyObject(session, secretHandle).catch(() => {});
  }
}

/** Derives the raw ECDH shared secret and reads it out. */
async function deriveExtractableSecret(
  module: Pkcs11Module,
  session: SessionHandle,
  privateKey: ObjectHandle,
  peerPoint: Uint8Array,
): Promise<Uint8Array> {
  const handle = await module.deriveKey(
    session,
    Mechanism.Ecdh1Derive,
    { kind: "ecdh1", kdf: CKD_NULL, sharedData: new Uint8Array(0), publicData: peerPoint },
    privateKey,
    [
      ulongAttribute(AttributeType.Class, ObjectClass.SecretKey),
      ulongAttribute(AttributeType.KeyType, KeyType.GenericSecret),
      boolAttribute(AttributeType.Token, false),
      boolAttribute(AttributeType.Sensitive, false),
      boolAttribute(AttributeType.Extractable, true),
    ],
  );

  try {
    const attributes = await module.getAttributes(session, handle, [AttributeType.Value]);
    const secret = findAttribute(attributes, AttributeType.Value);
    if (!secret || secret.length === 0) throw new Pkcs11SecretNotExtractableError();
    return secret;
  } finally {
    await module.destroyObject(session, handle).catch(() => {});
  }
}

/**
 * Finishes an extracted-secret ECDH decrypt in software, deriving the same
 * AES-GCM key the local provider derives.
 */
async function decryptWithSharedSecret(
  shared: Uint8Array,
  curve: string,
  info: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Promise<ArrayBuffer> {
  if (!EC_PARAMS[curve]) throw new Pkcs11Error(`pkcs11: unsupported ECDH curve: ${curve}`);
  // Web Crypto only accepts ArrayBuffer-backed views; the token buffers reach
  // here as plain byte arrays, so they are copied once on the way in.
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(shared),
    "HKDF",
    false,
    ["deriveKey"],
  );
  const aesKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: Uint8Array.from(info) },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Uint8Array.from(nonce) },
    aesKey,
    Uint8Array.from(ciphertext),
  );
}

/** Creates a key equivalent to the described object. */
async function generateReplacement(
  module: Pkcs11Module,
  slot: SlotState,
  session: SessionHandle,
  attributes: Attribute[],
  label: string,
  id: Uint8Array,
): Promise<KeyData> {
  const rawType = findAttribute(attributes, AttributeType.KeyType);
  if (!rawType) throw new Pkcs11Error("pkcs11: cannot rotate an object without CKA_KEY_TYPE");
  const decoded = ulongValue(rawType);
  if (decoded === undefined) throw new Pkcs11Error("pkcs11: CKA_KEY_TYPE is not a CK_ULONG");

  if (decoded === KeyType.Aes) {
    const raw = findAttribute(attributes, AttributeType.ValueLen);
    const parsed = raw ? ulongValue(raw) : undefined;
    const valueLen = parsed && parsed > 0 ? parsed : SizeSymmetricKey.Key256Bits;

    slot.requireMechanism(Mechanism.AesKeyGen);
    await module.generateKey(session, Mechanism.AesKeyGen, [
      ...tokenKeyTemplate(label, id),
      ulongAttribute(AttributeType.KeyType, KeyType.Aes),
      ulongAttribute(AttributeType.Class, ObjectClass.SecretKey),
      ulongAttribute(AttributeType.ValueLen, valueLen),
      boolAttribute(AttributeType.Encrypt, true),
      boolAttribute(AttributeType.Decrypt, true),
    ]);
    return keyDataFor({ object: label, id, class: ObjectClass.SecretKey }, "");
  }

  if (decoded === KeyType.Rsa) {
    const raw = findAttribute(attributes, AttributeType.ModulusBits);
    const parsed = raw ? ulongValue(raw) : undefined;
    const modulusBits = parsed && parsed > 0 ? parsed : SizeAsymmetricKey.Key2048Bits;

    slot.requireMechanism(Mechanism.RsaPkcsKeyPairGen);
    const [publicHandle] = await module.generateKeyPair(
      session,
      Mechanism.RsaPkcsKeyPairGen,
      [
        ...publicKeyTemplate(label, id),
        ulongAttribute(AttributeType.ModulusBits, modulusBits),
        bytesAttribute(AttributeType.PublicExponent, RSA_PUBLIC_EXPONENT),
        boolAttribute(AttributeType.Encrypt, true),
        boolAttribute(AttributeType.Verify, true),
      ],
      [
        ...tokenKeyTemplate(label, id),
        boolAttribute(AttributeType.Decrypt, true),
        boolAttribute(AttributeType.Sign, true),
      ],
    );
    const fresh = await module.getAttributes(session, publicHandle, [
      AttributeType.Modulus,
      AttributeType.PublicExponent,
    ]);
    return keyDataFor(
      { object: label, id, class: ObjectClass.PrivateKey },
      rsaPublicKeyFrom(fresh),
    );
  }

  if (decoded === KeyType.Ec || decoded === KeyType.EcEdwards) {
    const ecParams = findAttribute(attributes, AttributeType.EcParams);
    if (!ecParams) throw new Pkcs11Error("pkcs11: cannot rotate an ec key without CKA_EC_PARAMS");
    const edwards = decoded === KeyType.EcEdwards;
    const mechanism = edwards ? Mechanism.EcEdwardsKeyPairGen : Mechanism.EcKeyPairGen;

    slot.requireMechanism(mechanism);
    const [publicHandle] = await module.generateKeyPair(
      session,
      mechanism,
      [...publicKeyTemplate(label, id), bytesAttribute(AttributeType.EcParams, ecParams)],
      [
        ...tokenKeyTemplate(label, id),
        boolAttribute(AttributeType.Derive, !edwards),
        boolAttribute(AttributeType.Sign, edwards),
      ],
    );
    const fresh = await module.getAttributes(session, publicHandle, [
      AttributeType.EcPoint,
      AttributeType.EcParams,
    ]);
    return keyDataFor(
      { object: label, id, class: ObjectClass.PrivateKey },
      edwards ? ed25519PublicKeyFrom(fresh) : ecdhPublicKeyFrom(fresh),
    );
  }

  throw new Pkcs11Error(`pkcs11: cannot rotate key type ${decoded}`);
}

/**
 * Clears every usage attribute the object actually carries.
 *
 * The probe is not optional: `C_SetAttributeValue` rejects the whole template
 * with `CKR_ATTRIBUTE_TYPE_INVALID` if it names one attribute the object does
 * not have, so sending the full set blindly fails on almost every real key.
 */
async function disableObject(
  module: Pkcs11Module,
  session: SessionHandle,
  handle: ObjectHandle,
): Promise<void> {
  const present = await module.getAttributes(session, handle, DEACTIVATABLE_ATTRIBUTES);
  const template = DEACTIVATABLE_ATTRIBUTES
    .filter((type) => hasAttribute(present, type))
    .map((type) => boolAttribute(type, false));

  if (template.length === 0) {
    throw new Pkcs11Error("pkcs11: object carries no usage attribute to clear");
  }
  await module.setAttributes(session, handle, template);
}
