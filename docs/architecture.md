# Architecture

How forge-go and forge-deno fit together, and which of the three execution paths a call takes.

## Two repositories, one contract

forge-go (Go) is the **single source of truth** for portable business rules. forge-deno (Deno)
implements the same capabilities for the Deno ecosystem. They are separate repositories and neither
imports the other at runtime.

What binds them is a contract, not code sharing:

```
forge-go-private/share/portable/          the dependency-free Go core: 8 operations, error catalog, limits
        │
        ├── testdata/vectors/v1.json ──► vendored into forge-deno as wasm/testdata/vectors/v1.json
        │                                (drift-tested; forge-go stays the owner)
        │
        ├── component/                   WIT world + bridge, compiled to a WebAssembly component
        │     └── artifacts/             release bundle: component, glue, core modules, manifests
        │
        └── goforge.abi.manifest.json ─► generates forge-deno's wasm/generated/goforge-contract.ts
                                         (deno task contract:check fails on drift)
```

The portable core is deliberately dependency-free. Cloud SDKs, Gin, gRPC, Viper, filesystem and
process access, OpenTelemetry and CLI terminals are **host adapters** and never enter it.

## Three execution paths

A forge-deno caller can reach the same eight portable operations three ways. They are not
interchangeable, and the runtime never switches between them on its own.

| Path               | Entry point                                                      | Cost per call | When to use                                               |
| ------------------ | ---------------------------------------------------------------- | ------------- | --------------------------------------------------------- |
| **Component**      | `runtime.invoke(op, payload)`                                    | ~200–600 µs   | Contract fidelity: you want the Go core's exact behaviour |
| **Native adapter** | `runtime.invoke(op, payload, { target: { kind: "native", … } })` | ~0.2–13 µs    | Hot paths, sustained load                                 |
| **Native domains** | `encrypt`, `logger`, `security`, `config/http`, …                | native        | Ordinary application work                                 |

The component is 23–966× slower than native Deno on the same envelope, and the JSON + Base64
envelope — not the cryptography — dominates that cost. **The component's value is contract fidelity,
not speed.**

### Native domains are not all permissionless

Most native domains need no permissions at all — `encrypt`'s local provider is Web Crypto, `logger`
formats strings. Two groups are different, and the difference is what keeps them off the component
path:

- the cloud KMS providers (`encrypt/aws-kms`, `encrypt/azure-key-vault`, `encrypt/gcp-kms`) reach a
  network endpoint;
- `encrypt/pkcs11` loads the vendor's PKCS#11 library through `Deno.dlopen`, so it needs
  `--allow-ffi` and read access to that file.

A WebAssembly component cannot open a shared library or a socket, and the denied WASI imports below
would refuse if it tried. These domains therefore keep a portable half — payload framing, key
derivation, URI and DER handling — beside a half that only runs on the host, which is what the
coverage matrix records as class E ("hybrid component and native adapter"). They are reached through
their own import specifiers, never through `runtime.invoke`.

The gate is checked at first use rather than at construction, so a process that never touches a
token never needs the permission: `newPkcs11Provider()` is inert until an operation runs, and then
raises `Pkcs11UnavailableError` when FFI is unavailable. forge-go draws the same line at compile
time with its `pkcs11` build tag and `ErrUnavailable`.

### Why routing is explicit

A component failure never selects a native adapter automatically. That rule exists because the
operations include cryptography: a silent downgrade from a verified guest to a host implementation,
triggered by a transient failure, is exactly the shape of a security incident. The caller chooses
the target per invocation, and `NativeAdapterRegistry` additionally requires that the release
manifest name the adapter for that operation.

### Why the native adapter is allowed to reimplement portable rules

It is the only place in forge-deno that does, and the equivalence is machine-checked rather than
trusted. `createNativeGoforgeAdapter()` returns `parityQualified: false`, which the registry refuses
to route to. Only `qualifyNativeAdapter()` — which replays every forge-go shared vector byte for
byte and rejects any claimed operation with no covering vector — can produce a qualified adapter. A
differential suite additionally holds it against the real component over Unicode boundaries,
validation ordering and every failure path.

## The canonical ABI

One JSON envelope crosses every boundary:

```jsonc
// request
{ "abi": "goforge.abi.v1", "id": "…", "operation": "crypto.sha256",
  "metadata": { "deadline_unix_ms": 0, "cancellation_token": "" },
  "payload": { "data": "<padded Base64>" } }

// response — exactly one of result or error
{ "abi": "goforge.abi.v1", "id": "…", "ok": true, "result": { "digest": "…" } }
```

Strict by construction: unknown fields, duplicate fields, unpadded or URL-safe Base64, uppercase
error codes, mismatched IDs and off-catalog messages are all rejected. Binary fields are named by
the operation (`data`, `key`, `nonce`, `aad`, `plaintext`, `ciphertext`, `digest`, `mac`) — there is
no generic byte wrapper.

## Execution controls are outside the payload

Deadlines and cancellation travel as an explicit `ExecutionState` record on the WIT boundary, not as
business data:

```
clock-checked · now-unix-milliseconds · cancellation-checked
cancellation-token · cancellation-requested
```

The `*-checked` flags make the controls **fail closed**: a guest that is asked to honour a deadline
but receives `clock-checked: false` refuses rather than proceeding without a clock.
`control.deadline` and `control.cancellation` are declared as _host_ capabilities precisely because
the guest cannot satisfy them alone.

## The capability boundary

The portable core performs no I/O, so the host supplies every WASI interface the component imports
in its **denied** form: arguments and environment empty, standard streams closed, no terminal
attached, and every filesystem entry point refusing. Exactly two capabilities are real — clocks,
which Go's scheduler needs, and `wasi:random/random`, backed by the host CSPRNG. Every denial is
pinned by a test.

Replacing any denied stub grants the guest authority the contract never asks for. Passing your own
`wasiImports` is possible and is a security decision that needs justification.

## Integrity chain

Nothing executes before it is verified, and nothing is re-read from disk afterwards:

1. A trusted SHA-256 of `manifest.json` is supplied by the caller and checked **before** the JSON is
   parsed.
2. The manifest pins digests for the component, the host glue and every core module.
3. The factory imports the glue from an in-memory blob built from the already-verified bytes and
   compiles core modules from verified bytes.

A file swapped between the digest check and instantiation therefore cannot be executed.

## Related

- [Compatibility](./compatibility.md) — version pins and what is guaranteed across them
- [Migration](./migration.md) — moving from forge-go to forge-deno
- [Security](./security.md) — threat model and what is _not_ protected
- [Troubleshooting](./troubleshooting.md) — concrete failures and their causes
- [Component runtime guide](../wasm/README.md) — manifests, factory, retries, pool

See [architecture.es.md](./architecture.es.md) for the Spanish version.
