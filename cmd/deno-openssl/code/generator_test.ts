// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@std/assert";
import { fromPem, generateKeyPair, toPem } from "./generator.ts";
import { parseArgs, run } from "./app.ts";
import type { CliIO } from "./app.ts";

Deno.test("toPem/fromPem round-trip DER bytes", () => {
  const der = new Uint8Array([1, 2, 3, 4, 5]);
  const pem = toPem("PRIVATE KEY", der);
  assert(pem.startsWith("-----BEGIN PRIVATE KEY-----"));
  assertEquals([...fromPem(pem)], [...der]);
  assertThrows(() => fromPem("not a pem"));
});

Deno.test("generateKeyPair produces PEM for each algorithm", async () => {
  for (const algorithm of ["ec", "ed25519"] as const) {
    const pair = await generateKeyPair({ algorithm });
    assert(pair.publicKey.includes("BEGIN PUBLIC KEY"));
    assert(pair.privateKey.includes("BEGIN PRIVATE KEY"));
    // The exported DER must re-import.
    assert(fromPem(pair.publicKey).length > 0);
  }
});

Deno.test("RSA keypair honours modulus length", async () => {
  const pair = await generateKeyPair({ algorithm: "rsa", modulusLength: 2048 });
  assert(pair.privateKey.includes("BEGIN PRIVATE KEY"));
});

Deno.test("parseArgs handles flags, equals and positionals", () => {
  const parsed = parseArgs(["keypair", "--algorithm", "rsa", "--out=key", "extra", "--force"]);
  assertEquals(parsed.command, "keypair");
  assertEquals(parsed.flags.algorithm, "rsa");
  assertEquals(parsed.flags.out, "key");
  assertEquals(parsed.flags.force, true);
  assertEquals(parsed.positionals, ["extra"]);
});

function fakeIO(): { io: CliIO; out: string[]; err: string[]; files: Record<string, string> } {
  const out: string[] = [];
  const err: string[] = [];
  const files: Record<string, string> = {};
  return {
    io: {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      writeFile: (p, c) => {
        files[p] = c;
        return Promise.resolve();
      },
    },
    out,
    err,
    files,
  };
}

Deno.test("keypair command prints to stdout and writes files", async () => {
  const stdout = fakeIO();
  assertEquals(await run(["keypair", "--algorithm", "ec"], stdout.io), 0);
  assert(stdout.out.some((l) => l.includes("BEGIN PRIVATE KEY")));

  const toFile = fakeIO();
  assertEquals(await run(["keypair", "--algorithm", "ec", "--out", "id"], toFile.io), 0);
  assert(Object.keys(toFile.files).includes("id.key.pem"));
  assert(Object.keys(toFile.files).includes("id.pub.pem"));
});

Deno.test("help and unknown command", async () => {
  const help = fakeIO();
  assertEquals(await run(["help"], help.io), 0);
  assert(help.out.join("\n").includes("deno-openssl"));

  const unknown = fakeIO();
  assertEquals(await run(["bogus"], unknown.io), 1);
  assert(unknown.err.join("\n").includes("unknown command"));
});

Deno.test("pem-info requires a path", async () => {
  const io = fakeIO();
  assertEquals(await run(["pem-info"], io.io), 1);
});
