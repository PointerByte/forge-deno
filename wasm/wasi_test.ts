// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import { WasmCapabilityDeniedError } from "./errors.ts";
import { createDeniedWasiImports, GOFORGE_WASI_INTERFACES } from "./wasi.ts";

/**
 * Every stub in `wasi.ts` is a security decision, not a placeholder. These tests pin the denials so
 * that granting the guest new authority can never happen silently.
 */

type Imports = Record<string, Record<string, unknown>>;

function call(imports: Imports, wasiInterface: string, name: string, ...args: unknown[]): unknown {
  const target = imports[wasiInterface];
  assert(target, `${wasiInterface} must be supplied`);
  const fn = target[name];
  assert(typeof fn === "function", `${wasiInterface}#${name} must be a function`);
  return (fn as (...values: unknown[]) => unknown)(...args);
}

function construct(imports: Imports, wasiInterface: string, name: string): Record<string, unknown> {
  const target = imports[wasiInterface];
  assert(target, `${wasiInterface} must be supplied`);
  const Class = target[name] as new () => Record<string, unknown>;
  assert(typeof Class === "function", `${wasiInterface}#${name} must be a class`);
  return new Class();
}

/** Asserts a WIT-shaped throw, which is a plain tagged value rather than an Error. */
function assertWitThrows(fn: () => unknown, expected: unknown): void {
  let thrown: unknown;
  let threw = false;
  try {
    fn();
  } catch (cause) {
    threw = true;
    thrown = cause;
  }
  assert(threw, "the denied capability must throw");
  assertEquals(thrown, expected);
}

Deno.test("the host supplies exactly the interfaces the production component imports", () => {
  const imports = createDeniedWasiImports();
  assertEquals(Object.keys(imports).sort(), [...GOFORGE_WASI_INTERFACES].sort());
});

Deno.test("process identity is empty: no arguments, environment, or working directory", () => {
  const imports = createDeniedWasiImports();
  assertEquals(call(imports, "wasi:cli/environment", "getArguments"), []);
  assertEquals(call(imports, "wasi:cli/environment", "getEnvironment"), []);
  assertEquals(call(imports, "wasi:cli/environment", "initialCwd"), undefined);
});

Deno.test("wasi:cli/exit is denied by default and routed to an explicit handler when provided", () => {
  const denied = createDeniedWasiImports();
  const error = assertThrows(() => call(denied, "wasi:cli/exit", "exit", { tag: "ok" }));
  assertInstanceOf(error, WasmCapabilityDeniedError);
  assertEquals(error.code, "WASM_CAPABILITY_DENIED");
  assertEquals(error.capability, "wasi:cli/exit");
  assertEquals(error.stage, "capability");

  const observed: unknown[] = [];
  const routed = createDeniedWasiImports((status) => observed.push(status));
  assertEquals(call(routed, "wasi:cli/exit", "exit", { tag: "err" }), undefined);
  assertEquals(observed, [{ tag: "err" }]);
});

Deno.test("standard streams are closed in both directions", () => {
  const imports = createDeniedWasiImports();
  const stdin = call(imports, "wasi:cli/stdin", "getStdin") as {
    read(length: bigint): Uint8Array;
    blockingRead(length: bigint): never;
    skip(length: bigint): bigint;
    blockingSkip(length: bigint): never;
    subscribe(): { ready(): boolean };
  };
  assertEquals(stdin.read(16n), new Uint8Array(0));
  assertEquals(stdin.skip(16n), 0n);
  assertWitThrows(() => stdin.blockingRead(16n), { tag: "closed" });
  assertWitThrows(() => stdin.blockingSkip(16n), { tag: "closed" });
  assertEquals(stdin.subscribe().ready(), true);

  for (const name of ["getStdout", "getStderr"] as const) {
    const stream = call(
      imports,
      name === "getStdout" ? "wasi:cli/stdout" : "wasi:cli/stderr",
      name,
    ) as {
      checkWrite(): bigint;
      write(contents: Uint8Array): never;
      blockingWriteAndFlush(contents: Uint8Array): never;
      flush(): never;
      blockingFlush(): never;
      writeZeroes(length: bigint): never;
      blockingWriteZeroesAndFlush(length: bigint): never;
      splice(source: unknown, length: bigint): never;
      blockingSplice(source: unknown, length: bigint): never;
      subscribe(): { ready(): boolean; block(): void };
    };
    const payload = new Uint8Array([1, 2, 3]);
    assertEquals(stream.checkWrite(), 0n);
    assertWitThrows(() => stream.write(payload), { tag: "closed" });
    assertWitThrows(() => stream.blockingWriteAndFlush(payload), { tag: "closed" });
    assertWitThrows(() => stream.flush(), { tag: "closed" });
    assertWitThrows(() => stream.blockingFlush(), { tag: "closed" });
    assertWitThrows(() => stream.writeZeroes(4n), { tag: "closed" });
    assertWitThrows(() => stream.blockingWriteZeroesAndFlush(4n), { tag: "closed" });
    assertWitThrows(() => stream.splice(null, 4n), { tag: "closed" });
    assertWitThrows(() => stream.blockingSplice(null, 4n), { tag: "closed" });
    const pollable = stream.subscribe();
    assertEquals(pollable.ready(), true);
    assertEquals(pollable.block(), undefined);
  }
});

Deno.test("no terminal is attached to any standard stream", () => {
  const imports = createDeniedWasiImports();
  assertEquals(call(imports, "wasi:cli/terminal-stdin", "getTerminalStdin"), undefined);
  assertEquals(call(imports, "wasi:cli/terminal-stdout", "getTerminalStdout"), undefined);
  assertEquals(call(imports, "wasi:cli/terminal-stderr", "getTerminalStderr"), undefined);
  assert(construct(imports, "wasi:cli/terminal-input", "TerminalInput") instanceof Object);
  assert(construct(imports, "wasi:cli/terminal-output", "TerminalOutput") instanceof Object);
});

Deno.test("every filesystem entry point refuses and no directory is preopened", () => {
  const imports = createDeniedWasiImports();
  assertEquals(call(imports, "wasi:filesystem/preopens", "getDirectories"), []);
  assertEquals(call(imports, "wasi:filesystem/types", "filesystemErrorCode", {}), undefined);

  const descriptor = construct(imports, "wasi:filesystem/types", "Descriptor");
  const other = construct(imports, "wasi:filesystem/types", "Descriptor");
  const invocations: Array<[string, unknown[]]> = [
    ["readViaStream", [0n]],
    ["writeViaStream", [0n]],
    ["appendViaStream", []],
    ["advise", [0n, 0n, 0]],
    ["syncData", []],
    ["getFlags", []],
    ["getType", []],
    ["setSize", [0n]],
    ["setTimes", [null, null]],
    ["read", [1n, 0n]],
    ["write", [new Uint8Array(1), 0n]],
    ["readDirectory", []],
    ["sync", []],
    ["createDirectoryAt", ["dir"]],
    ["stat", []],
    ["statAt", [0, "path"]],
    ["setTimesAt", [0, "path", null, null]],
    ["linkAt", [0, "old", other, "new"]],
    ["openAt", [0, "/etc/passwd", 0, 0]],
    ["readlinkAt", ["link"]],
    ["removeDirectoryAt", ["dir"]],
    ["renameAt", ["old", other, "new"]],
    ["symlinkAt", ["old", "new"]],
    ["unlinkFileAt", ["file"]],
    ["metadataHash", []],
    ["metadataHashAt", [0, "path"]],
  ];
  for (const [name, args] of invocations) {
    const method = descriptor[name] as (...values: unknown[]) => unknown;
    assert(typeof method === "function", `Descriptor#${name} must exist`);
    assertWitThrows(() => method.apply(descriptor, args), "not-permitted");
  }
  // Identity comparison is safe to answer and must never claim two handles are the same object.
  assertEquals((descriptor.isSameObject as (o: unknown) => boolean).call(descriptor, other), false);

  const stream = construct(imports, "wasi:filesystem/types", "DirectoryEntryStream");
  assertEquals((stream.readDirectoryEntry as () => unknown)(), undefined);
});

Deno.test("io error and poll resources exist without granting blocking authority", () => {
  const imports = createDeniedWasiImports();
  const ioError = construct(imports, "wasi:io/error", "Error");
  assertEquals((ioError.toDebugString as () => string)(), "denied");

  const pollable = construct(imports, "wasi:io/poll", "Pollable");
  assertEquals((pollable.ready as () => boolean)(), true);
  assertEquals((pollable.block as () => void)(), undefined);
  assertEquals(
    call(imports, "wasi:io/poll", "poll", [pollable, pollable]),
    Uint32Array.from([0, 1]),
  );
});

Deno.test("clocks advance and randomness comes from the host CSPRNG", () => {
  const imports = createDeniedWasiImports();
  const monotonic = imports["wasi:clocks/monotonic-clock"];
  const first = (monotonic.now as () => bigint)();
  const second = (monotonic.now as () => bigint)();
  assert(second >= first, "the monotonic clock must not move backwards");
  assert((monotonic.resolution as () => bigint)() > 0n);
  assert((monotonic.subscribeDuration as (n: bigint) => { ready(): boolean })(1n).ready());
  assert((monotonic.subscribeInstant as (n: bigint) => { ready(): boolean })(1n).ready());

  const wall = (imports["wasi:clocks/wall-clock"].now as () => {
    seconds: bigint;
    nanoseconds: number;
  })();
  assert(wall.seconds > 0n);
  assert(wall.nanoseconds >= 0 && wall.nanoseconds < 1_000_000_000);
  assertEquals(
    (imports["wasi:clocks/wall-clock"].resolution as () => unknown)(),
    { seconds: 0n, nanoseconds: 1_000_000 },
  );

  const random = imports["wasi:random/random"];
  const bytes = (random.getRandomBytes as (n: bigint) => Uint8Array)(64n);
  assertEquals(bytes.byteLength, 64);
  // A CSPRNG must not return an all-zero block; a stubbed generator would.
  assert(bytes.some((value) => value !== 0));
  const repeat = (random.getRandomBytes as (n: bigint) => Uint8Array)(64n);
  assert(!bytes.every((value, index) => value === repeat[index]), "randomness must vary");

  // Chunked generation must cover buffers larger than one 65 536-byte crypto.getRandomValues call.
  const large = (random.getRandomBytes as (n: bigint) => Uint8Array)(70_000n);
  assertEquals(large.byteLength, 70_000);
  assert(large.subarray(65_536).some((value) => value !== 0), "the tail chunk must be filled");

  const first64 = (random.getRandomU64 as () => bigint)();
  const second64 = (random.getRandomU64 as () => bigint)();
  assert(first64 >= 0n && second64 >= 0n);
  assertEquals(bytes.byteLength, 64);
});

Deno.test("random byte lengths are validated before allocation", () => {
  const random = createDeniedWasiImports()["wasi:random/random"];
  for (const invalid of [-1n, 2n ** 60n]) {
    assertThrows(
      () => (random.getRandomBytes as (n: bigint) => Uint8Array)(invalid),
      RangeError,
    );
  }
  assertEquals((random.getRandomBytes as (n: bigint) => Uint8Array)(0n).byteLength, 0);
});
