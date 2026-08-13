// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertRejects } from "@std/assert";
import { type Filesystem, scaffold } from "./scaffold.ts";
import { templateFiles } from "./templates.ts";
import { parseArgs, run } from "./app.ts";
import type { CliIO } from "./app.ts";

function fakeFs(existing: string[] = []): { fs: Filesystem; files: Record<string, string> } {
  const files: Record<string, string> = {};
  const dirs = new Set<string>();
  return {
    files,
    fs: {
      mkdir: (p) => {
        dirs.add(p);
        return Promise.resolve();
      },
      writeFile: (p, c) => {
        files[p] = c;
        return Promise.resolve();
      },
      exists: (p) => Promise.resolve(existing.includes(p)),
    },
  };
}

Deno.test("templateFiles produces the right files per kind", () => {
  const http = templateFiles("http", "demo");
  assert("main.ts" in http && "deno.json" in http);
  assert(!("service.proto" in http));

  const grpc = templateFiles("grpc", "demo");
  assert("service.proto" in grpc);
  assert(grpc["main.ts"].includes("GrpcServer"));
});

Deno.test("scaffold writes a project to the filesystem seam", async () => {
  const { fs, files } = fakeFs();
  const result = await scaffold({ kind: "http", name: "my-api" }, fs);
  assertEquals(result.dir, "./my-api");
  assert(files["./my-api/main.ts"].includes("newHttpServer"));
  assert(files["./my-api/deno.json"].includes("@pointerbyte/denoforge"));
});

Deno.test("scaffold validates name and existing directory", async () => {
  const { fs } = fakeFs(["./taken"]);
  await assertRejects(() => scaffold({ kind: "http", name: "1bad" }, fs));
  await assertRejects(() => scaffold({ kind: "http", name: "taken", dir: "./taken" }, fs));
  // --force overwrites an existing directory.
  const forced = await scaffold({ kind: "http", name: "taken", dir: "./taken", force: true }, fs);
  assertEquals(forced.dir, "./taken");
});

Deno.test("qdeno parseArgs and help/usage paths", async () => {
  assertEquals(parseArgs(["new", "http", "api"]).positionals, ["http", "api"]);

  const lines: string[] = [];
  const io: CliIO = { out: (l) => lines.push(l), err: (l) => lines.push(l) };
  assertEquals(await run(["help"], io), 0);
  assert(lines.join("\n").includes("scaffolder"));

  lines.length = 0;
  assertEquals(await run(["bogus"], io), 1);
  lines.length = 0;
  assertEquals(await run(["new", "ftp", "x"], io), 1); // invalid kind
});

Deno.test("qdeno run scaffolds into a temp dir", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const lines: string[] = [];
    const io: CliIO = { out: (l) => lines.push(l), err: (l) => lines.push(l) };
    const code = await run(["new", "grpc", "svc", "--dir", `${tmp}/svc`], io);
    assertEquals(code, 0);
    const main = await Deno.readTextFile(`${tmp}/svc/main.ts`);
    assert(main.includes("GrpcServer"));
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
