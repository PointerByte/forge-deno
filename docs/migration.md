# Migration

Moving from GoForge (Go) to DenoForge (Deno), and choosing how much of GoForge to keep.

## Decide first: which path do you actually need?

Most teams do not need the WebAssembly component at all.

| If you need…                                      | Use                                                                                                               | Why                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Ordinary Deno services with the same capabilities | **Native domains** (`encrypt`, `logger`, `security`, `config/http`, `config/grpc`, `tools/jobs`, `tools/workers`) | Idiomatic, fast, no bundle to distribute               |
| The Go core's _exact_ behaviour as an oracle      | **Component**                                                                                                     | Same bytes, same rules; contract fidelity              |
| Portable operations on a hot path                 | **Native adapter**                                                                                                | Vector-qualified, ~25–1000× cheaper than the component |

Only the eight portable operations exist in all three. Everything else — HTTP, gRPC, jobs, workers,
CLIs, cloud KMS — is native Deno only, because those are host adapters that never enter a portable
core.

## Step 1: map your Go API surface

The
[functional coverage matrix](../openspec/changes/tinygo-wasip2-goforge-integration/research/evidence/functional-coverage-matrix.md)
catalogues all 891 Go public APIs with a Deno status, a representative symbol, and a migration path.
Look yours up there first.

Each entry is one of:

- **exact** — a name-level Deno equivalent exists (298 APIs, 33.4%)
- **documented-exception** — no direct equivalent; the entry names the replacement approach (588)
- **deprecated contract** — a legacy Go name preserved for compatibility

Note the honest framing: the matrix proves _representation_, not semantic equivalence. Semantic
parity is proven only where shared vectors exist.

## Step 2: keep the naming conventions in mind

Go's package-qualified names collapse when flattened into JavaScript, so DenoForge namespaces by
module (`encrypt`, `logger`, `security`, `wasm`) — names that repeat across modules, like `Service`,
`Middleware` and `Handler`, never collide. Import from the specific entry point rather than the root
when you want that clarity:

```ts
import { … } from "@pointerbyte/denoforge/encrypt";
import { … } from "@pointerbyte/denoforge/wasm";
```

Legacy misspelled Go names are preserved on the Go side and **corrected** in the generated ABI
contracts. If you are migrating against the ABI rather than against Go source, expect the corrected
spelling.

## Step 3: if you use the component, wire the bundle

The bundle is not in the JSR package. Build it and point the runtime at it:

```bash
cd forge-go-private/component && ./scripts/build.sh
```

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
  poolSize: 4,
});
```

`trustedDigest` must come from somewhere you trust — a signed release note, your deployment config —
not from the bundle you are about to verify.

**Before you put this on a production route:** read the sustained-load limitation in
[troubleshooting](./troubleshooting.md). The shipped component traps intermittently under sustained
dispatch.

## Step 4: translate the call shape

Go:

```go
dispatcher := portable.DefaultDispatcher()
response := dispatcher.DispatchJSON(requestJSON, portable.ExecutionState{})
```

Deno:

```ts
const result = await runtime.invoke<{ digest: string }>(
  "crypto.sha256",
  { data: encodeAbiBase64(new TextEncoder().encode("abc")) },
  { timeoutMs: 500, requiredCapabilities: ["crypto.sha256"] },
);
const digest = decodeAbiBase64(result.digest);
```

Three things commonly trip people up:

1. **Binary fields are padded, standard-alphabet Base64 strings** named by the operation. Use
   `encodeAbiBase64` / `decodeAbiBase64`, not `btoa`.
2. **Deadlines and cancellation are options, not payload fields.** They travel outside the business
   payload and fail closed.
3. **Domain failures are responses, not exceptions, inside the guest** — but the runtime converts a
   failed response into a typed `WasmGuestError` for you, with `code`, `retryable` and `field`.

## Step 5: opt into the native adapter for hot paths

```ts
const vectors = JSON.parse(await Deno.readTextFile("wasm/testdata/vectors/v1.json")).vectors;
const adapters = new NativeAdapterRegistry();
adapters.register(await qualifyNativeAdapter(createNativeGoforgeAdapter(), vectors));

const runtime = new GoforgeWasmRuntime({ /* … */, adapters });

await runtime.invoke("crypto.sha256", payload, {
  target: { kind: "native", adapter: GOFORGE_NATIVE_ADAPTER_NAME },
});
```

Routing is per invocation and always explicit. The release manifest must also list the adapter under
`nativeAdapters` for that operation — a qualified adapter alone is not enough.

## Step 6: run the gates

```bash
deno task fmt:check && deno task lint && deno task check
deno task test && deno task cov:check
deno task contract:check && deno task inventory:check && deno task matrix:check
```

If `contract:check` fails, a GoForge contract change has landed — regenerate with
`deno task contract` and let `generated_contract_test.ts` name any surface that also needs updating.

## Related

- [Architecture](./architecture.md) · [Compatibility](./compatibility.md) ·
  [Security](./security.md) · [Troubleshooting](./troubleshooting.md)

See [migration.es.md](./migration.es.md) for the Spanish version.
