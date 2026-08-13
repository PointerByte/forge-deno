# forge-go component runtime

The public `@pointerbyte/denoforge/wasm` entry is the fail-closed Deno host for forge-go portable
logic. Importing or constructing it performs no I/O. The first call verifies the immutable release
bundle before any bytes reach the injected component factory. Every new instance must then return
forge-go's canonical portable manifest before it may dispatch a request.

This directory is production code and never imports a research implementation.

## Canonical ABI v1

forge-go is the contract source of truth. Requests use `abi`, `id`, `operation`, optional
`metadata`, and an operation-specific raw JSON `payload`:

```json
{
  "abi": "goforge.abi.v1",
  "id": "sha-1",
  "operation": "crypto.sha256",
  "metadata": {
    "deadline_unix_ms": 2000,
    "cancellation_token": "call-1",
    "required_capabilities": ["crypto.sha256"]
  },
  "payload": { "data": "YWJj" }
}
```

Responses use `abi`, `id`, and `ok`, followed by exactly one `result` or `error`:

```json
{
  "abi": "goforge.abi.v1",
  "id": "sha-1",
  "ok": true,
  "result": { "digest": "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=" }
}
```

```json
{
  "abi": "goforge.abi.v1",
  "id": "sha-1",
  "ok": false,
  "error": {
    "code": "invalid_base64",
    "message": "value is not canonical standard padded Base64",
    "retryable": false,
    "field": "payload.data"
  }
}
```

There is no generic `$type` byte wrapper. The operation fields defined by forge-go—`data`, `key`,
`nonce`, `aad`, `plaintext`, `ciphertext`, `digest`, and `mac`—are RFC 4648 standard-alphabet Base64
strings with required padding. Use `encodeAbiBase64` and `decodeAbiBase64` explicitly. Raw
`Uint8Array`, unpadded or URL-safe Base64, uppercase error codes, unknown fields, duplicate response
fields, mismatched IDs, and non-catalog error messages are rejected.

ABI v1 contains exactly these operations:

- `text.normalize` and `text.validate`
- `crypto.sha256` and `crypto.hmac-sha256`
- `crypto.aes-gcm.encrypt` and `crypto.aes-gcm.decrypt`
- `encoding.base64.encode` and `encoding.base64.decode`

The shared test gate reads `forge-go-private/portable/testdata/vectors/v1.json` directly and proves
byte-equivalent request envelopes and response parity for all eight operations.

## Two intentionally different manifests

`goforge.manifest.v1` is exported by forge-go and describes the portable ABI, limits, capabilities,
operations, and error catalog. `goforge.bundle-manifest.v1` is release metadata used only to verify
component, glue, and core-module digests. The runtime checks both and rejects disagreement.

A release bundle has this distinct root shape and must describe all eight canonical operations:

```json
{
  "schema": "goforge.bundle-manifest.v1",
  "abi": "goforge.abi.v1",
  "componentVersion": "0.1.0",
  "witPackage": "pointerbyte:goforge@0.1.0",
  "source": { "path": "goforge.component.wasm", "sha256": "<64 lowercase hex>" },
  "glue": { "path": "host/goforge.js", "sha256": "<64 lowercase hex>" },
  "coreModules": {
    "goforge.core.wasm": {
      "path": "host/goforge.core.wasm",
      "sha256": "<64 lowercase hex>"
    }
  },
  "capabilities": ["crypto.sha256"],
  "operations": {
    "crypto.sha256": {
      "capability": "crypto.sha256",
      "retrySafe": true,
      "securitySensitive": false
    }
  }
}
```

Artifact paths must be package-relative with no traversal, URL, query, fragment, encoded segment, or
duplicate path. The trusted manifest SHA-256 is verified before JSON parsing.

## Hosting reviewed generated glue

The runtime does not invoke jco, npm, a subprocess, or the network. A release-owned factory adapts
the reviewed generated bindings to the exact Go component exports:

```ts
import {
  createFileArtifactReader,
  decodeAbiBase64,
  encodeAbiBase64,
  GoforgeWasmRuntime,
  type WasmComponentFactory,
} from "@pointerbyte/denoforge/wasm";

declare const reviewedFactory: WasmComponentFactory;

const runtime = new GoforgeWasmRuntime({
  bundle: {
    manifestPath: "manifest.json",
    manifestSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  },
  compatibility: {
    componentVersion: "0.1.0",
    witPackage: "pointerbyte:goforge@0.1.0",
  },
  readArtifact: createFileArtifactReader(new URL("./component/", import.meta.url)),
  factory: reviewedFactory,
  poolSize: 4,
});

const result = await runtime.invoke<{ digest: string }>(
  "crypto.sha256",
  { data: encodeAbiBase64(new TextEncoder().encode("abc")) },
  { timeoutMs: 500, requiredCapabilities: ["crypto.sha256"] },
);
const digest = decodeAbiBase64(result.digest);
await runtime.close();
```

Each factory instance provides `manifest()` and `dispatch(requestJson, executionState)`. The state
maps directly to forge-go's `clockChecked`, `nowUnixMilliseconds`, `cancellationChecked`,
`cancellationToken`, and `cancellationRequested` fields. This keeps deadline/cancellation checks
outside the serialized business payload while still making them explicit and fail-closed.

## The production factory and its capability boundary

`createGeneratedComponentFactory()` is the supported factory for bundles built by
`forge-go-private/component/scripts/build.sh`. It executes only bytes the runtime already verified:
the generated glue is imported from an in-memory blob built from `bundle.glueBytes`, and every core
module is compiled from `bundle.coreModuleBytes`. Nothing is re-read from disk after its digest
check, so a file swapped between verification and instantiation cannot run.

```ts
import {
  createFileArtifactReader,
  createGeneratedComponentFactory,
  GoforgeWasmRuntime,
} from "@pointerbyte/denoforge/wasm";

const runtime = new GoforgeWasmRuntime({
  bundle: { manifestPath: "manifest.json", manifestSha256: trustedDigest },
  compatibility: { componentVersion: "0.1.0", witPackage: "pointerbyte:goforge@0.1.0" },
  readArtifact: createFileArtifactReader(new URL("./artifacts/", import.meta.url)),
  factory: createGeneratedComponentFactory(),
});
```

WASI imports come from `createDeniedWasiImports()`. forge-go's portable core performs no I/O, so the
host supplies all eighteen interfaces the component declares in their **denied** form: arguments and
environment are empty, standard streams are closed, no terminal is attached, and every filesystem
entry point returns `not-permitted`. Only two capabilities are real — clocks, which the Go scheduler
needs, and `wasi:random/random`, backed by the host CSPRNG. Each denial is pinned by a test.

Replacing any denied stub grants the guest authority the portable contract never asks for. Passing
your own `wasiImports` is possible and is a security decision that needs justification.

### Known limitation: sustained load

The component intermittently traps during Go garbage collection under sustained dispatch load,
surfacing as `RangeError: Maximum call stack size exceeded`. Correctness is proven — the Go core in
WebAssembly reproduces every native shared vector exactly — but endurance is not. Do not put this
path on a hot production route yet. `research/component-gc-soak/soak.ts` reproduces and measures it.

The defect has since been isolated to the **componentize-go** compiler rather than to WebAssembly or
to this host: it reproduces under wasmtime with no JavaScript involved, and a TinyGo build of the
identical guest source survives the same workload with 0/10 traps and full vector parity. Switching
the production compiler is proposed but not yet approved, so the shipped bundle is still affected.
Until it lands, use {@linkcode createNativeGoforgeAdapter} for sustained or latency-sensitive work.

## Lifecycle, retries, and native adapters

The runtime uses one lazy verification promise and a FIFO bounded instance pool. A timed-out or
cancelled invocation keeps its lease until the generated promise settles, then discards that
instance. Shutdown aborts active callers, drains the pool, closes adapters, and is idempotent.

Retries require `allowRetry: true`, a `retrySafe` release declaration, a retryable Go catalog error,
and a matching lowercase code in the configured allowlist. The same ID is reused. Traps, malformed
output, integrity failures, deadline/cancellation failures, and compatibility failures are never
retried, even if a caller puts a deadline or cancellation code in the allowlist.

Native routing is always explicit. `NativeAdapterRegistry` requires release approval, an exact
operation declaration, and `parityQualified: true`. Component failure never changes the selected
target, so security operations cannot silently downgrade.

## The native portable adapter

`createNativeGoforgeAdapter()` implements all eight portable operations directly on Deno's Web
Crypto and string primitives. It exists because the component costs 23–966× more per call than
native code on the same envelope, so hot paths need somewhere else to go.

It is the one place in forge-deno that reimplements portable rules, and it is allowed to only
because the equivalence is machine-checked rather than asserted:

```ts
const vectors = JSON.parse(await Deno.readTextFile("wasm/testdata/vectors/v1.json")).vectors;
const adapters = new NativeAdapterRegistry();
adapters.register(await qualifyNativeAdapter(createNativeGoforgeAdapter(), vectors));

await runtime.invoke("crypto.sha256", { data }, {
  target: { kind: "native", adapter: GOFORGE_NATIVE_ADAPTER_NAME },
});
```

`createNativeGoforgeAdapter` returns `parityQualified: false`, which the registry refuses to route
to. Only `qualifyNativeAdapter` — which replays every forge-go vector and compares byte for byte,
and throws if any operation has no covering vector — can produce a qualified adapter. A drifting
implementation therefore cannot be registered at all.

Beyond the vectors, `native_test.ts` runs a differential suite that compares the adapter against the
**real component** across empty inputs, Unicode boundaries, validation-rule ordering and every
failure path. Both must agree exactly, including error codes and field attribution.

Two behaviours are deliberately Go's rather than JavaScript's, because the contract is Go's:
`String.prototype.trim` is not used (it strips U+FEFF, which Go does not treat as space, and leaves
U+0085, which Go does), and Base64 is re-encoded and compared so non-canonical trailing bits are
rejected the way `base64.StdEncoding.Strict()` rejects them.

The adapter is not a fallback. Routing to it is a caller decision per invocation, and a component
failure never redirects to it.

Observer events contain lifecycle metadata but never payloads, results, guest messages, fields, or
secrets. `health()` does not trigger loading; `preload()` verifies without creating an instance.

See [README.es.md](./README.es.md) for the Spanish version.
