import assert from "node:assert/strict";

import * as cli from "@preview2/cli";
import * as clocks from "@preview2/clocks";
import * as filesystem from "@preview2/filesystem";
import * as io from "@preview2/io";
import * as random from "@preview2/random";

interface StandardOperations {
  add(left: number, right: number): number;
  greet(name: string): string;
  reverseBytes(value: Uint8Array): Uint8Array;
  summarize(
    value: { left: number; right: number },
  ): { total: number; label: string };
  annotate(value: string): string;
}

interface StandardRoot {
  operations: StandardOperations;
}

interface GeneratedStandardModule {
  instantiate(
    getCoreModule: (
      name: string,
    ) => WebAssembly.Module | Promise<WebAssembly.Module>,
    imports: Record<string, unknown>,
  ): StandardRoot | Promise<StandardRoot>;
}

const modules = new Map<string, WebAssembly.Module>();
const getCoreModule = async (name: string): Promise<WebAssembly.Module> => {
  let module = modules.get(name);
  if (!module) {
    const bytes = await Deno.readFile(
      new URL(`./standard-generated/${name}`, import.meta.url),
    );
    module = await WebAssembly.compile(Uint8Array.from(bytes).buffer);
    modules.set(name, module);
  }
  return module;
};

let annotationCalls = 0;
const imports = {
  "pointerbyte:goforge-poc/host": {
    annotate(value: string): string {
      annotationCalls++;
      return `[standard-host:${value}]`;
    },
  },
  "wasi:cli/environment": cli.environment,
  "wasi:cli/exit": cli.exit,
  "wasi:cli/stderr": cli.stderr,
  "wasi:cli/stdin": cli.stdin,
  "wasi:cli/stdout": cli.stdout,
  "wasi:cli/terminal-input": cli.terminalInput,
  "wasi:cli/terminal-output": cli.terminalOutput,
  "wasi:cli/terminal-stderr": cli.terminalStderr,
  "wasi:cli/terminal-stdin": cli.terminalStdin,
  "wasi:cli/terminal-stdout": cli.terminalStdout,
  "wasi:clocks/monotonic-clock": clocks.monotonicClock,
  "wasi:clocks/wall-clock": clocks.wallClock,
  "wasi:filesystem/preopens": filesystem.preopens,
  "wasi:filesystem/types": filesystem.types,
  "wasi:io/error": io.error,
  "wasi:io/poll": io.poll,
  "wasi:io/streams": io.streams,
  "wasi:random/random": random.random,
};

// The generated module is intentionally ignored by Git and only exists after
// scripts/transpile.sh. Keep its unchecked boundary explicit and type every
// operation consumed by this smoke test.
const generatedUrl = new URL(
  "./standard-generated/goforge-standard.js",
  import.meta.url,
);
const generated = await import(generatedUrl.href) as GeneratedStandardModule;
const root = await generated.instantiate(getCoreModule, imports);

assert.equal(root.operations.add(20, 22), 42);
assert.equal(root.operations.greet("Deno"), "hello, Deno");
assert.deepEqual(
  root.operations.reverseBytes(new Uint8Array([1, 2, 3])),
  new Uint8Array([3, 2, 1]),
);
assert.deepEqual(root.operations.summarize({ left: 20, right: 22 }), {
  total: 42,
  label: "sum:42",
});
assert.equal(
  root.operations.annotate("capability"),
  "[standard-host:capability]",
);
assert.equal(annotationCalls, 1);

assert.throws(
  () => root.operations.summarize({ left: 0, right: 0 }),
  (error: unknown) => {
    assert.deepEqual((error as { payload?: unknown }).payload, {
      tag: "invalid-input",
      val: "both values must not be zero",
    });
    return true;
  },
);

console.log("standard Go 1.25.12 component round trip: ok");
