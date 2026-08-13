// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * JWT signing and verification service.
 *
 * Each algorithm is a {@link Strategy} (HS256, RS256, PS256, EdDSA, plus a
 * custom escape hatch), wrapped in a {@link Service} that signs claims and runs
 * post-verification {@link Validator}s, all backed by Web Crypto. Keys use the
 * same Base64 DER convention as the encrypt module (PKCS#8 private / SPKI
 * public); HMAC secrets are raw strings.
 *
 * @module
 */

import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Supported JWT algorithms (the `alg` header value). */
export type Algorithm = "HS256" | "RS256" | "PS256" | "EdDSA";

/** Standard JWT header. */
export interface Header {
  /** Token type marker. */
  typ: "JWT";
  /** Signing algorithm declared by the token. */
  alg: Algorithm | string;
}

/** A parsed token broken into its components. */
export interface Token {
  /** Original compact JWS value. */
  raw: string;
  /** Decoded protected header. */
  header: Header;
  /** Decoded token claims. */
  claims: Record<string, unknown>;
  /** Decoded signature bytes. */
  signature: Uint8Array;
}

/** Post-verification validation callback; throw to reject the token. */
export type Validator = (claims: Record<string, unknown>) => void | Promise<void>;

/** Context-aware signing function for the custom strategy. */
export type SignFunc = (signingInput: Uint8Array<ArrayBuffer>) => Promise<Uint8Array> | Uint8Array;
/** Context-aware verification function for the custom strategy. */
export type VerifyFunc = (
  signingInput: Uint8Array,
  signature: Uint8Array<ArrayBuffer>,
) => Promise<boolean> | boolean;

/** A pluggable signing algorithm. */
export interface Strategy {
  /** Returns the JWT `alg` value implemented by this strategy. */
  algorithm(): Algorithm | string;
  /** Signs the encoded header-and-claims input. */
  sign(signingInput: Uint8Array<ArrayBuffer>): Promise<Uint8Array>;
  /** Verifies a signature over the encoded header-and-claims input. */
  verify(signingInput: Uint8Array, signature: Uint8Array<ArrayBuffer>): Promise<boolean>;
}

/** Raised when verification fails. */
export class JWTError extends Error {
  /** Stable error class name. */
  override name = "JWTError";
}

function bytes(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(encoder.encode(text));
}
function der(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(decodeBase64Url(toUrl(base64)));
}
function toUrl(value: string): string {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- Strategies -------------------------------------------------------------

/** HMAC-SHA256 JWT signing strategy used for HS256 tokens. */
class HMACSHA256Strategy implements Strategy {
  #key?: CryptoKey;
  /** Creates an HMAC-SHA256 strategy from a raw secret string. */
  constructor(private readonly secret: string) {}
  /** Returns the `HS256` JWT algorithm identifier. */
  algorithm(): Algorithm {
    return "HS256";
  }
  async #load(): Promise<CryptoKey> {
    this.#key ??= await crypto.subtle.importKey(
      "raw",
      bytes(this.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    return this.#key;
  }
  /** Produces an HMAC-SHA256 signature. */
  async sign(input: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.sign("HMAC", await this.#load(), input));
  }
  /** Verifies an HMAC-SHA256 signature. */
  async verify(
    input: Uint8Array<ArrayBuffer>,
    signature: Uint8Array<ArrayBuffer>,
  ): Promise<boolean> {
    return crypto.subtle.verify("HMAC", await this.#load(), signature, input);
  }
}

/** RSA JWT signing strategy used for RS256 and PS256 tokens. */
class RSAStrategy implements Strategy {
  #priv?: CryptoKey;
  #pub?: CryptoKey;
  /** Creates an RS256 or PS256 strategy from optional Base64 DER keys. */
  constructor(
    private readonly alg: "RS256" | "PS256",
    private readonly privateKey?: string,
    private readonly publicKey?: string,
  ) {}
  /** Returns the configured RSA JWT algorithm identifier. */
  algorithm(): Algorithm {
    return this.alg;
  }
  #params(): RsaHashedImportParams {
    return this.alg === "RS256"
      ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
      : { name: "RSA-PSS", hash: "SHA-256" };
  }
  #signParams(): AlgorithmIdentifier | RsaPssParams {
    return this.alg === "RS256" ? "RSASSA-PKCS1-v1_5" : { name: "RSA-PSS", saltLength: 32 };
  }
  /** Produces an RSASSA-PKCS1-v1_5 or RSA-PSS signature. */
  async sign(input: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    if (!this.privateKey) throw new JWTError("jwt: missing RSA private key");
    this.#priv ??= await crypto.subtle.importKey(
      "pkcs8",
      der(this.privateKey),
      this.#params(),
      false,
      ["sign"],
    );
    return new Uint8Array(await crypto.subtle.sign(this.#signParams(), this.#priv, input));
  }
  /** Verifies an RSASSA-PKCS1-v1_5 or RSA-PSS signature. */
  async verify(
    input: Uint8Array<ArrayBuffer>,
    signature: Uint8Array<ArrayBuffer>,
  ): Promise<boolean> {
    if (!this.publicKey) throw new JWTError("jwt: missing RSA public key");
    this.#pub ??= await crypto.subtle.importKey(
      "spki",
      der(this.publicKey),
      this.#params(),
      false,
      ["verify"],
    );
    return crypto.subtle.verify(this.#signParams(), this.#pub, signature, input);
  }
}

/** Ed25519 JWT signing strategy used for EdDSA tokens. */
class Ed25519Strategy implements Strategy {
  #priv?: CryptoKey;
  #pub?: CryptoKey;
  /** Creates an EdDSA strategy from optional Base64 DER Ed25519 keys. */
  constructor(private readonly privateKey?: string, private readonly publicKey?: string) {}
  /** Returns the `EdDSA` JWT algorithm identifier. */
  algorithm(): Algorithm {
    return "EdDSA";
  }
  /** Produces an Ed25519 signature. */
  async sign(input: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    if (!this.privateKey) throw new JWTError("jwt: missing Ed25519 private key");
    this.#priv ??= await crypto.subtle.importKey(
      "pkcs8",
      der(this.privateKey),
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, this.#priv, input));
  }
  /** Verifies an Ed25519 signature. */
  async verify(
    input: Uint8Array<ArrayBuffer>,
    signature: Uint8Array<ArrayBuffer>,
  ): Promise<boolean> {
    if (!this.publicKey) throw new JWTError("jwt: missing Ed25519 public key");
    this.#pub ??= await crypto.subtle.importKey(
      "spki",
      der(this.publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify({ name: "Ed25519" }, this.#pub, signature, input);
  }
}

/** Delegates JWT signing and verification to caller-provided functions. */
class CustomStrategy implements Strategy {
  /** Creates a strategy backed by caller-provided signing and verification functions. */
  constructor(
    private readonly alg: string,
    private readonly signFn: SignFunc,
    private readonly verifyFn: VerifyFunc,
  ) {}
  /** Returns the caller-provided JWT algorithm identifier. */
  algorithm(): string {
    return this.alg;
  }
  /** Delegates signing to the caller-provided function. */
  async sign(input: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    return await this.signFn(input);
  }
  /** Delegates verification to the caller-provided function. */
  async verify(
    input: Uint8Array<ArrayBuffer>,
    signature: Uint8Array<ArrayBuffer>,
  ): Promise<boolean> {
    return await this.verifyFn(input, signature);
  }
}

// --- Service ----------------------------------------------------------------

/** Configuration accepted by {@link createService}. */
export interface ServiceConfig {
  /** Built-in or custom JWT algorithm identifier. */
  algorithm: Algorithm | string;
  /** Raw HMAC secret required by HS256. */
  hmacSecret?: string;
  /** Base64 PKCS#8 RSA private key used for signing. */
  rsaPrivateKey?: string;
  /** Base64 SPKI RSA public key used for verification. */
  rsaPublicKey?: string;
  /** Base64 PKCS#8 Ed25519 private key used for signing. */
  eddsaPrivateKey?: string;
  /** Base64 SPKI Ed25519 public key used for verification. */
  eddsaPublicKey?: string;
  /** Custom strategy hooks; used when `algorithm` is none of the built-ins. */
  sign?: SignFunc;
  /** Custom verification hook paired with `sign`. */
  verify?: VerifyFunc;
  /** Validators run after signature verification. */
  validators?: Validator[];
}

/** Signs claims and verifies tokens with a configured {@link Strategy}. */
export class Service {
  readonly #strategy: Strategy;
  readonly #validators: Validator[];

  /** Creates a JWT service from a strategy and post-verification validators. */
  constructor(strategy: Strategy, validators: Validator[] = []) {
    this.#strategy = strategy;
    this.#validators = validators;
  }

  /** Algorithm of the underlying strategy. */
  algorithm(): Algorithm | string {
    return this.#strategy.algorithm();
  }

  /** Signs `claims` and returns a compact JWS string. */
  async sign(claims: Record<string, unknown>): Promise<string> {
    const header: Header = { typ: "JWT", alg: this.#strategy.algorithm() };
    const signingInput = `${b64(header)}.${b64(claims)}`;
    const signature = await this.#strategy.sign(bytes(signingInput));
    return `${signingInput}.${encodeBase64Url(signature)}`;
  }

  /**
   * Parses and fully verifies a token: checks the signature, then runs the
   * service validators plus any extra ones. Returns the decoded token.
   */
  async verify(token: string, ...extra: Validator[]): Promise<Token> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new JWTError("jwt: malformed token");
    const [headerPart, claimsPart, signaturePart] = parts;

    const header = decodeJSON<Header>(headerPart);
    if (header.alg !== this.#strategy.algorithm()) {
      throw new JWTError(`jwt: algorithm mismatch: ${header.alg}`);
    }
    const signature = Uint8Array.from(decodeBase64Url(signaturePart));
    const ok = await this.#strategy.verify(bytes(`${headerPart}.${claimsPart}`), signature);
    if (!ok) throw new JWTError("jwt: signature verification failed");

    const claims = decodeJSON<Record<string, unknown>>(claimsPart);
    for (const validate of [...this.#validators, ...extra]) await validate(claims);
    return { raw: token, header, claims, signature };
  }
}

function b64(value: unknown): string {
  return encodeBase64Url(bytes(JSON.stringify(value)));
}
function decodeJSON<T>(part: string): T {
  return JSON.parse(decoder.decode(decodeBase64Url(part))) as T;
}

/** Builds a {@link Service} from declarative config. */
export function createService(config: ServiceConfig): Service {
  let strategy: Strategy;
  switch (config.algorithm) {
    case "HS256":
      if (!config.hmacSecret) throw new JWTError("jwt: HS256 requires an hmacSecret");
      strategy = new HMACSHA256Strategy(config.hmacSecret);
      break;
    case "RS256":
    case "PS256":
      strategy = new RSAStrategy(config.algorithm, config.rsaPrivateKey, config.rsaPublicKey);
      break;
    case "EdDSA":
      strategy = new Ed25519Strategy(config.eddsaPrivateKey, config.eddsaPublicKey);
      break;
    default:
      if (!config.sign || !config.verify) {
        throw new JWTError(`jwt: custom algorithm "${config.algorithm}" requires sign and verify`);
      }
      strategy = new CustomStrategy(config.algorithm, config.sign, config.verify);
  }
  return new Service(strategy, config.validators ?? []);
}

export { CustomStrategy, Ed25519Strategy, HMACSHA256Strategy, RSAStrategy };
