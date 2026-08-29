// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PKCS#11 provider contract: construction options, the repository interfaces
 * the provider implements, and {@link Pkcs11Module} — the single seam between
 * the provider's policy logic and the vendor library.
 *
 * Everything above the seam is ordinary TypeScript and is unit-testable with
 * an in-memory fake; everything below it is FFI. That is the same split
 * forge-go draws between its pure-Go repository and its cgo binding, and the
 * same shape the cloud backends use with `KmsApi`.
 *
 * @module
 */

import type { Attribute } from "./cryptoki.ts";
import type {
  AsymmetricRepository,
  HashRepository,
  KeyRepository,
  SignatureRepository,
  SymmetricRepository,
} from "../local/interface.ts";

export type {
  AsymmetricRepository,
  HashRepository,
  KeyRepository,
  SignatureRepository,
  SymmetricRepository,
};

/**
 * Returns the token PIN.
 *
 * It is called at most once per token, when the first session logs in.
 * Supplying it as a function rather than a configuration value lets the PIN
 * come from wherever the deployment keeps it — a file with restricted
 * permissions, a secrets manager, Dragon CMK — without this module taking a
 * dependency on any of them.
 *
 * This is why there is no `pin` string option and no configuration key for it:
 * a PIN in configuration ends up in `application.yml`, in process environment
 * dumps, and in logs.
 */
export type PinProvider = (signal?: AbortSignal) => string | Promise<string>;

/**
 * Construction options for the PKCS#11 provider.
 *
 * forge-go reads the same settings from viper under
 * `encrypt.vault.pkcs11.*` and lets functional options override them. The Deno
 * backends take options only — matching `aws-kms`, `azure-key-vault` and
 * `gcp-kms`, none of which read configuration — so the mapping is:
 *
 * | forge-go viper key | option |
 * | --- | --- |
 * | `encrypt.vault.pkcs11.module-path` | {@link Pkcs11Options.modulePath} |
 * | `encrypt.vault.pkcs11.token-label` | {@link Pkcs11Options.tokenLabel} |
 * | `encrypt.vault.pkcs11.slot-id` | {@link Pkcs11Options.slotId} |
 * | `encrypt.vault.pkcs11.key-uri` | {@link Pkcs11Options.keyUri} |
 * | `encrypt.vault.pkcs11.max-sessions` | {@link Pkcs11Options.maxSessions} |
 * | *(deliberately none)* | {@link Pkcs11Options.pin} |
 */
export interface Pkcs11Options {
  /** Path to the vendor PKCS#11 shared library. */
  modulePath?: string;
  /**
   * Selects the token by its label, which is stable across reboots unlike the
   * slot id. Prefer it over {@link Pkcs11Options.slotId}.
   */
  tokenLabel?: string;
  /**
   * Selects the token by slot id. Slot ids are reassigned when tokens are
   * added or removed.
   */
  slotId?: number;
  /**
   * Default RFC 7512 key URI used when a request does not carry one, mirroring
   * the AWS backend's default ARN.
   */
  keyUri?: string;
  /**
   * Bounds concurrent token sessions. Values below one are ignored; defaults
   * to 8.
   */
  maxSessions?: number;
  /** Supplies the token PIN. Required — see {@link PinProvider}. */
  pin?: PinProvider;
  /**
   * Controls whether ECDH decryption may fall back to reading the derived
   * shared secret out of the token when the token does not implement
   * `CKM_HKDF_DERIVE`.
   *
   * Defaults to true. What leaves the token in that path is an ephemeral
   * per-message secret, never long-term key material, and it is exactly what
   * the `aws-kms` and `azure-key-vault` backends already do. Set it to false
   * on a token whose policy must guarantee that nothing derived ever leaves
   * the hardware, accepting that ECDH decryption then fails on tokens without
   * `CKM_HKDF_DERIVE`.
   */
  allowSecretExtraction?: boolean;
  /**
   * Makes `deactivateKey` destroy the object when the token refuses to clear
   * its usage attributes. Defaults to false: failing is safer than destroying
   * a key the caller only asked to disable.
   */
  deactivateDestroys?: boolean;
  /**
   * Makes `rotateKey` disable the previous key after generating its
   * replacement. Defaults to false so that rotation stays non-destructive and
   * old ciphertext remains decryptable.
   */
  rotateDisablesPrevious?: boolean;
  /**
   * Injects a token implementation, bypassing FFI. Used by tests and by
   * callers fronting a token this module cannot dlopen (a remote HSM proxy,
   * a vendor SDK with its own bindings).
   */
  module?: Pkcs11Module;
}

/** A `CK_SESSION_HANDLE`. */
export type SessionHandle = number;

/** A `CK_OBJECT_HANDLE`. */
export type ObjectHandle = number;

/**
 * The subset of `CK_SLOT_INFO`/`CK_TOKEN_INFO` needed to resolve a token label
 * to a slot id.
 */
export interface SlotInfo {
  /** The `CK_SLOT_ID`. */
  id: number;
  /** `CKA_LABEL` of the token in the slot, space-trimmed. */
  tokenLabel: string;
  /** Whether a token is currently in the slot. */
  tokenPresent: boolean;
  /**
   * `CK_TOKEN_INFO.ulMaxSessionCount`, or 0 when the token reports
   * `CK_EFFECTIVELY_INFINITE`.
   */
  maxSessions: number;
}

/**
 * `CK_GCM_PARAMS`.
 *
 * The provider always supplies the IV itself rather than letting the token
 * generate it, because vendors disagree on who owns IV generation and a
 * caller-supplied IV keeps the wire format identical to the local provider.
 */
export interface GcmParams {
  /** Discriminator for the parameter union. */
  kind: "gcm";
  /** The nonce; always 12 bytes. */
  iv: Uint8Array;
  /** Additional authenticated data, possibly empty. */
  aad: Uint8Array;
  /** Tag length in bits; always 128. */
  tagBits: number;
}

/**
 * `CK_RSA_PKCS_OAEP_PARAMS`, pinned to SHA-256 with MGF1-SHA256 and an empty
 * label to match the local and cloud backends.
 */
export interface OaepParams {
  /** Discriminator for the parameter union. */
  kind: "oaep";
  /** The `CKM_` digest mechanism. */
  hashAlg: number;
  /** The `CKG_` mask generation function. */
  mgf: number;
  /** The `CKZ_` source type; must be `CKZ_DATA_SPECIFIED`. */
  source: number;
}

/** `CK_RSA_PKCS_PSS_PARAMS`. */
export interface PssParams {
  /** Discriminator for the parameter union. */
  kind: "pss";
  /** The `CKM_` digest mechanism. */
  hashAlg: number;
  /** The `CKG_` mask generation function. */
  mgf: number;
  /** Salt length in bytes. */
  saltLen: number;
}

/** `CK_ECDH1_DERIVE_PARAMS`. */
export interface Ecdh1Params {
  /** Discriminator for the parameter union. */
  kind: "ecdh1";
  /** The `CKD_` key derivation function; the provider uses `CKD_NULL`. */
  kdf: number;
  /** Optional shared data; unused. */
  sharedData: Uint8Array;
  /**
   * The peer public key point. PKCS#11 wants the bare SEC1 point here, which
   * is the opposite convention to `CKA_EC_POINT`.
   */
  publicData: Uint8Array;
}

/**
 * `CK_HKDF_PARAMS`.
 *
 * Extract with a null salt is bit-for-bit RFC 5869 with a nil salt, so an
 * HKDF performed inside the token yields the same key the local provider
 * derives in software.
 */
export interface HkdfParams {
  /** Discriminator for the parameter union. */
  kind: "hkdf";
  /** Enables the HKDF-Extract step. */
  extract: boolean;
  /** Enables the HKDF-Expand step. */
  expand: boolean;
  /** The `CKM_` digest mechanism backing HMAC. */
  prf: number;
  /** The `CKF_HKDF_SALT_` constant; the provider uses NULL. */
  saltType: number;
  /** The HKDF info string. */
  info: Uint8Array;
}

/**
 * `CK_EDDSA_PARAMS`. Some tokens reject a NULL parameter for `CKM_EDDSA` and
 * require this block instead.
 */
export interface EddsaParams {
  /** Discriminator for the parameter union. */
  kind: "eddsa";
  /** Selects prehashed Ed25519ph; always false here. */
  phFlag: boolean;
}

/** The parameter block of every mechanism that takes one. */
export type MechanismParams =
  | GcmParams
  | OaepParams
  | PssParams
  | Ecdh1Params
  | HkdfParams
  | EddsaParams;

/**
 * The whole PKCS#11 surface the provider depends on, expressed in TypeScript
 * types.
 *
 * Every struct layout, every pointer, and the two-call size-then-fill
 * convention stay below this seam, which keeps the repository testable with an
 * in-memory fake and lets a caller substitute a token this runtime cannot
 * `dlopen`.
 */
export interface Pkcs11Module {
  /**
   * Calls `C_Initialize` with `CKF_OS_LOCKING_OK`, treating
   * `CKR_CRYPTOKI_ALREADY_INITIALIZED` as success because another consumer in
   * the process may share the same library.
   */
  initialize(): Promise<void>;
  /**
   * Calls `C_Finalize`. It deliberately does not unload the library: several
   * vendor modules leave threads or atexit handlers behind and crash when
   * unloaded.
   */
  finalize(): Promise<void>;
  /** Lists the slots, optionally restricted to those holding a token. */
  slots(tokenPresent: boolean): Promise<SlotInfo[]>;
  /** Lists the `CKM_` values the slot advertises. */
  mechanisms(slot: number): Promise<number[]>;

  /** Opens a read/write user session on `slot`. */
  openSession(slot: number): Promise<SessionHandle>;
  /** Closes a session opened by {@link Pkcs11Module.openSession}. */
  closeSession(session: SessionHandle): Promise<void>;
  /**
   * Authenticates the user on the session's slot. Login state is per-token and
   * shared across the application's sessions, so this runs once;
   * `CKR_USER_ALREADY_LOGGED_IN` counts as success.
   */
  login(session: SessionHandle, pin: string): Promise<void>;
  /** Drops the login state for the session's slot. */
  logout(session: SessionHandle): Promise<void>;

  /** Returns the handles matching `template`. */
  findObjects(session: SessionHandle, template: Attribute[]): Promise<ObjectHandle[]>;
  /**
   * Reads the requested attributes from an object. Attributes the object does
   * not carry are reported through the returned attribute's `present` field
   * rather than failing the whole call.
   */
  getAttributes(
    session: SessionHandle,
    object: ObjectHandle,
    types: number[],
  ): Promise<Attribute[]>;
  /** Writes attributes onto an existing object. */
  setAttributes(
    session: SessionHandle,
    object: ObjectHandle,
    template: Attribute[],
  ): Promise<void>;
  /** Removes an object from the token. */
  destroyObject(session: SessionHandle, object: ObjectHandle): Promise<void>;

  /** Creates a secret key object. */
  generateKey(
    session: SessionHandle,
    mechanism: number,
    template: Attribute[],
  ): Promise<ObjectHandle>;
  /** Creates a key pair, returning the public handle first. */
  generateKeyPair(
    session: SessionHandle,
    mechanism: number,
    publicTemplate: Attribute[],
    privateTemplate: Attribute[],
  ): Promise<[ObjectHandle, ObjectHandle]>;
  /**
   * Runs `C_DeriveKey` and returns the derived handle. It serves both
   * `CKM_ECDH1_DERIVE` and `CKM_HKDF_DERIVE`.
   */
  deriveKey(
    session: SessionHandle,
    mechanism: number,
    params: MechanismParams | undefined,
    base: ObjectHandle,
    template: Attribute[],
  ): Promise<ObjectHandle>;

  /** Runs a single-part encryption. */
  encrypt(
    session: SessionHandle,
    mechanism: number,
    params: MechanismParams | undefined,
    key: ObjectHandle,
    plaintext: Uint8Array,
  ): Promise<Uint8Array>;
  /** Runs a single-part decryption. */
  decrypt(
    session: SessionHandle,
    mechanism: number,
    params: MechanismParams | undefined,
    key: ObjectHandle,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array>;
  /** Runs a single-part signature. */
  sign(
    session: SessionHandle,
    mechanism: number,
    params: MechanismParams | undefined,
    key: ObjectHandle,
    message: Uint8Array,
  ): Promise<Uint8Array>;
  /**
   * Runs a single-part verification. An invalid signature is reported as an
   * error carrying `CKR_SIGNATURE_INVALID`.
   */
  verify(
    session: SessionHandle,
    mechanism: number,
    params: MechanismParams | undefined,
    key: ObjectHandle,
    message: Uint8Array,
    signature: Uint8Array,
  ): Promise<void>;
}

/**
 * The composite contract the PKCS#11 provider implements: the same five
 * repositories the local provider implements, so the two are interchangeable
 * at the call site.
 */
export interface Pkcs11Repository
  extends
    SymmetricRepository,
    AsymmetricRepository,
    KeyRepository,
    HashRepository,
    SignatureRepository {}
