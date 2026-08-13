// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Key/certificate generation and PEM handling.
 *
 * The CLI counterpart of the OpenSSL-style key tooling: generate key pairs with
 * Web Crypto, convert DER <-> PEM, and (optionally) produce a self-signed X.509
 * certificate. Certificate generation lazily loads `@peculiar/x509`, which has
 * no native Deno equivalent; everything else is zero-dependency.
 *
 * @module
 */

import { decodeBase64, encodeBase64 } from "@std/encoding/base64";

/** Supported key algorithms for {@link generateKeyPair}. */
export type KeyAlgorithm = "rsa" | "ec" | "ed25519";

/** A PEM-encoded key pair. */
export interface KeyPairPem {
  algorithm: KeyAlgorithm;
  publicKey: string;
  privateKey: string;
}

/** Options for {@link generateKeyPair}. */
export interface GenerateKeyOptions {
  algorithm: KeyAlgorithm;
  /** RSA modulus length (default 2048). */
  modulusLength?: number;
  /** EC named curve (default P-256). */
  namedCurve?: string;
}

/** Wraps Base64 at 64 columns inside a PEM block with the given label. */
export function toPem(label: string, der: Uint8Array): string {
  const body = encodeBase64(der).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** Extracts the DER bytes from a PEM block (label-agnostic). */
export function fromPem(pem: string): Uint8Array {
  if (!/-----BEGIN [A-Z0-9 ]+-----/.test(pem)) {
    throw new Error("deno-openssl: input is not a PEM block");
  }
  const body = pem.replace(/-----[A-Z0-9 ]+-----/g, "").replace(/\s+/g, "");
  if (!body) throw new Error("deno-openssl: empty PEM body");
  return decodeBase64(body);
}

function importParams(options: GenerateKeyOptions): {
  algorithm: RsaHashedKeyGenParams | EcKeyGenParams | { name: string };
  usages: KeyUsage[];
} {
  switch (options.algorithm) {
    case "rsa":
      return {
        algorithm: {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: options.modulusLength ?? 2048,
          publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
          hash: "SHA-256",
        },
        usages: ["sign", "verify"],
      };
    case "ec":
      return {
        algorithm: { name: "ECDSA", namedCurve: options.namedCurve ?? "P-256" },
        usages: ["sign", "verify"],
      };
    case "ed25519":
      return { algorithm: { name: "Ed25519" }, usages: ["sign", "verify"] };
    default:
      throw new Error(`deno-openssl: unsupported algorithm "${options.algorithm}"`);
  }
}

/** Generates a key pair and returns SPKI/PKCS#8 material as PEM. */
export async function generateKeyPair(options: GenerateKeyOptions): Promise<KeyPairPem> {
  const { algorithm, usages } = importParams(options);
  const pair = await crypto.subtle.generateKey(
    algorithm as AlgorithmIdentifier,
    true,
    usages,
  ) as CryptoKeyPair;
  const [spki, pkcs8] = await Promise.all([
    crypto.subtle.exportKey("spki", pair.publicKey),
    crypto.subtle.exportKey("pkcs8", pair.privateKey),
  ]);
  return {
    algorithm: options.algorithm,
    publicKey: toPem("PUBLIC KEY", new Uint8Array(spki)),
    privateKey: toPem("PRIVATE KEY", new Uint8Array(pkcs8)),
  };
}

/** Options for {@link generateSelfSignedCertificate}. */
export interface SelfSignedOptions {
  /** Subject/issuer common name, e.g. `CN=localhost`. */
  name: string;
  /** Validity in days (default 365). */
  days?: number;
  /** Key algorithm (default ec/P-256). */
  algorithm?: KeyAlgorithm;
}

/** A self-signed certificate plus its key pair, all PEM-encoded. */
export interface CertificatePem {
  certificate: string;
  publicKey: string;
  privateKey: string;
}

/**
 * Generates a self-signed X.509 certificate. Lazily loads `@peculiar/x509`,
 * the standard Web Crypto-based X.509 library, since Deno has no built-in
 * certificate generator.
 */
export async function generateSelfSignedCertificate(
  options: SelfSignedOptions,
): Promise<CertificatePem> {
  // Lazily loaded only when certificate generation is requested.
  // deno-lint-ignore no-explicit-any
  const x509 = await import("@peculiar/x509") as any;
  x509.cryptoProvider.set(crypto);

  const algorithm = options.algorithm ?? "ec";
  const { algorithm: alg, usages } = importParams({ algorithm });
  const keys = await crypto.subtle.generateKey(
    alg as AlgorithmIdentifier,
    true,
    usages,
  ) as CryptoKeyPair;
  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + (options.days ?? 365) * 86_400_000);

  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: crypto.getRandomValues(new Uint8Array(8)).reduce(
      (s, b) => s + b.toString(16),
      "",
    ),
    name: options.name,
    notBefore,
    notAfter,
    keys,
    signingAlgorithm: alg,
  });

  const [spki, pkcs8] = await Promise.all([
    crypto.subtle.exportKey("spki", keys.publicKey),
    crypto.subtle.exportKey("pkcs8", keys.privateKey),
  ]);
  return {
    certificate: cert.toString("pem"),
    publicKey: toPem("PUBLIC KEY", new Uint8Array(spki)),
    privateKey: toPem("PRIVATE KEY", new Uint8Array(pkcs8)),
  };
}
