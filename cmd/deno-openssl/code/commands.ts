// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `deno-openssl` command handlers: keypair, cert, pem-info and help.
 *
 * @module
 */

import type { CliIO, ParsedArgs } from "./app.ts";
import {
  fromPem,
  generateKeyPair,
  generateSelfSignedCertificate,
  type KeyAlgorithm,
} from "./generator.ts";

/** A command handler returns a process exit code. */
export type Command = (args: ParsedArgs, io: CliIO) => number | Promise<number>;

function flagString(args: ParsedArgs, name: string, fallback?: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : fallback;
}

/** Writes `<prefix>.<suffix>` when `--out` is set, otherwise prints the PEM. */
async function emit(
  io: CliIO,
  prefix: string | undefined,
  parts: Record<string, string>,
): Promise<void> {
  for (const [suffix, content] of Object.entries(parts)) {
    if (prefix) {
      const path = `${prefix}.${suffix}`;
      await io.writeFile(path, content);
      io.out(`wrote ${path}`);
    } else {
      io.out(content.trimEnd());
    }
  }
}

const keypair: Command = async (args, io) => {
  const algorithm = (flagString(args, "algorithm", "ec") ?? "ec") as KeyAlgorithm;
  const pair = await generateKeyPair({
    algorithm,
    modulusLength: args.flags.bits ? Number(args.flags.bits) : undefined,
    namedCurve: flagString(args, "curve"),
  });
  await emit(io, flagString(args, "out"), {
    "key.pem": pair.privateKey,
    "pub.pem": pair.publicKey,
  });
  return 0;
};

const cert: Command = async (args, io) => {
  const result = await generateSelfSignedCertificate({
    name: flagString(args, "name", "CN=localhost")!,
    days: args.flags.days ? Number(args.flags.days) : undefined,
    algorithm: flagString(args, "algorithm") as KeyAlgorithm | undefined,
  });
  await emit(io, flagString(args, "out"), {
    "crt.pem": result.certificate,
    "key.pem": result.privateKey,
    "pub.pem": result.publicKey,
  });
  return 0;
};

const pemInfo: Command = async (args, io) => {
  const path = args.positionals[0];
  if (!path) {
    io.err("deno-openssl: pem-info requires a file path");
    return 1;
  }
  const der = fromPem(await Deno.readTextFile(path));
  io.out(`DER length: ${der.length} bytes`);
  return 0;
};

const help: Command = (_args, io) => {
  io.out(`deno-openssl — key & certificate tooling

Usage:
  deno-openssl keypair  [--algorithm rsa|ec|ed25519] [--bits 2048] [--curve P-256] [--out <prefix>]
  deno-openssl cert     [--name CN=localhost] [--days 365] [--algorithm ec] [--out <prefix>]
  deno-openssl pem-info <file.pem>
  deno-openssl help

Without --out, PEM material is printed to stdout.`);
  return 0;
};

/** Command registry keyed by name. */
export const commands: Record<string, Command> = { keypair, cert, "pem-info": pemInfo, help };
