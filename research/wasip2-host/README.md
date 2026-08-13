# Deno WASIp2 host proof of concept

Status: passed on 2026-08-01 under exact Deno `2.9.4` and jco `1.26.1`.

This host transpiles the TinyGo component into JavaScript plus core WebAssembly with jco's
asynchronous custom-instantiation mode. Deno does not load Component Model binaries through
`WebAssembly.instantiate` directly; jco supplies the lowering and lifting layer.

The related decisions are in
[component-host-options.md](../../openspec/changes/tinygo-wasip2-goforge-integration/research/component-host-options.md),
[typescript-bindings.md](../../openspec/changes/tinygo-wasip2-goforge-integration/research/typescript-bindings.md),
and
[permission-model.md](../../openspec/changes/tinygo-wasip2-goforge-integration/research/permission-model.md).

## Reproduce

Build the Go artifacts first. From this directory:

```bash
./scripts/transpile.sh
./scripts/test.sh
DENO_DIR=/tmp/goforge-wasip2-deno-cache deno task bench
```

The transpile command is pinned to:

```text
deno run -A npm:@bytecodealliance/jco@1.26.1 transpile ... --instantiation async --no-nodejs-compat --strict
```

`deno.lock` is lockfile version 5 and records npm integrity values for jco `1.26.1` and the preview2
shim `0.19.0` used only by the standard-Go comparison.

Expected primary test result:

```text
running 4 tests from ./host_test.ts
Deno invokes every canonical ABI shape and the host import ... ok
concurrent startup and calls are isolated ... ok
incompatible component version is rejected before instantiation ... ok
component, glue, and core checksum mismatches are rejected ... ok
ok | 4 passed | 0 failed
```

## Security and lifecycle behavior

Before instantiation, `GoforgeComponentHost.load` verifies:

- manifest schema `1`;
- component version `0.1.0`;
- WIT package identity `pointerbyte:goforge-poc@0.1.0`;
- the source component SHA-256;
- the generated jco JavaScript glue SHA-256;
- every generated core-module SHA-256.

The four core modules are compiled only from the already verified bytes. Any unmanifested module
request is rejected. Tests deliberately corrupt the expected component, glue, and core-module hashes
and confirm fail-closed behavior.

The primary host does not use the generic preview2 shim. `wasi.ts` provides a minimal WASI `0.2.0`
capability object:

- empty arguments and environment;
- no filesystem preopens;
- closed stdin/stdout/stderr resources;
- no network interfaces in the component import set;
- clocks and cryptographic randomness;
- one explicit custom `annotate` capability.

The Deno task grants read access only to the manifest, generated bundle, and Go component artifact.
jco-generated glue also probes `JCO_DEBUG`, so that single environment variable is granted. No
network, write, subprocess, FFI, system-information, or general environment permission is granted
during the primary tests.

`close()` is idempotent, drops the exported root, and makes subsequent operations throw
`ComponentClosedError`. The world exports no resources, so there are no WIT resource destructors.
JavaScript garbage collection ultimately reclaims instance memory.

## Runtime evidence

The successful round trip covered:

- `add(20, 22) == 42`;
- `greet("Deno") == "hello, Deno"`;
- byte reversal including `0xff`;
- record input/output;
- `invalid-input(string)` and `overflow` typed errors;
- the host import and its invocation count;
- 128 scheduled calls across four concurrently loaded instances;
- version and checksum rejection;
- clean shutdown.

One non-scientific smoke measurement on the validation host reported:

```json
{
  "runtime": "2.9.4",
  "startupMs": 26.528459,
  "iterations": 10000,
  "invocationTotalMs": 741.3034190000001,
  "averageInvocationUs": 74.1303419,
  "checksum": 50005000
}
```

This is sanity evidence, not a plan-phase benchmark. It includes JavaScript wrapper overhead and
must not be used as a performance claim.

## Standard-Go comparison

`deno task standard:smoke` also passed the componentize-go `0.4.0` artifact built with Go `1.25.12`.
That artifact imports WASI `0.2.12`, so the smoke uses `@bytecodealliance/preview2-shim@0.19.0`. It
currently requires `-A` because the Node-oriented shim snapshots process environment and stdio at
import time. This broad-permission comparison is not the selected primary permission model.

## Known limitations

- jco's Component Model support and custom instantiation path remain experimental.
- jco `1.26.1` generated declarations retain versioned import keys, while the runtime looks up
  versionless keys. `host.ts` contains one documented type seam for this mismatch.
- Calls are synchronous after asynchronous instantiation. Promise scheduling does not make one
  instance reentrant; the concurrency test uses four instances.
- Cancellation, timeout interruption, workers, WIT resources, and async interfaces require separate
  PoCs.
- The source component and transpiled outputs must be signed and distributed as one immutable bundle
  in production. The local verification has a small time-of-check/time-of-use window before dynamic
  import.
- `generated/` and `standard-generated/` are ignored; run the transpile script before checking or
  testing a fresh checkout.

## Cleanup

The disposable outputs are `generated/` and `standard-generated/`. The task-specific Deno cache is
`/tmp/goforge-wasip2-deno-cache`.
