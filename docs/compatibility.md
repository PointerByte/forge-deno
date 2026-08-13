# Compatibility

Which versions are pinned, what is guaranteed across them, and how drift is detected.

## Contract versions

| Thing                    | Version                      | Changing it means                                                  |
| ------------------------ | ---------------------------- | ------------------------------------------------------------------ |
| JSON bridge ABI          | `goforge.abi.v1`             | A new ABI identifier; the runtime rejects mismatches               |
| WIT package              | `pointerbyte:goforge@0.1.0`  | A new component version and a compatibility failure on old bundles |
| Portable manifest schema | `goforge.manifest.v1`        | Regenerating the TypeScript contract                               |
| Release bundle schema    | `goforge.bundle-manifest.v1` | Independent of the portable contract; release metadata only        |

The two manifests are deliberately different documents. `goforge.manifest.v1` is GoForge's contract
— ABI, limits, capabilities, operations, errors. `goforge.bundle-manifest.v1` is release metadata
for verifying digests. The runtime validates both and rejects any disagreement.

## Toolchain pins

| Tool               | Version | Notes                                                                                     |
| ------------------ | ------- | ----------------------------------------------------------------------------------------- |
| Go language floor  | 1.25.0  | The public compatibility contract; every module's `go` directive                          |
| Go build toolchain | 1.25.12 | Security-patched. Exact 1.25.0 reports 26 reachable stdlib findings; 1.25.12 reports zero |
| componentize-go    | 0.4.0   | Current production compiler — **affected by the GC defect**                               |
| TinyGo             | 0.41.1  | Comparison build; proposed replacement, not yet approved                                  |
| wit-bindgen        | 0.58.0  | Guest bindings                                                                            |
| wasm-tools         | 1.255.0 | Validation and WIT extraction; checksum-verified in CI                                    |
| jco                | 1.26.1  | `--instantiation async --no-nodejs-compat --strict`                                       |
| WASI               | 0.2.12  | TinyGo builds link 0.2.0 instead                                                          |
| Deno               | 2.9.4   | Exact runtime for all published evidence                                                  |

The language floor and the build compiler solve different problems: consumers get the Go 1.25.0
compatibility contract, releases get the fixes in the supported patch line. A patch bump does not
move the floor; moving the floor needs an ADR.

## Runtime requirements

- **Deno 2.x.** No Node compatibility layer is used; `--no-nodejs-compat` keeps npm
  `@bytecodealliance/preview2-shim` out of the dependency graph entirely.
- **No permissions for the runtime itself.** Importing or constructing `GoforgeWasmRuntime` performs
  no I/O. Reading the bundle needs whatever your injected `WasmArtifactReader` needs —
  `--allow-read` for the file reader.
- **The release bundle is not in the JSR package.** It is distributed separately and located through
  the injected reader, with `GOFORGE_COMPONENT_BUNDLE` overriding the default sibling-repository
  path.

## API representation

All **891** cataloged Go public APIs are represented: **298 (33.4%)** by a name-level native match,
the remaining **588** by a documented exception with a migration path.

This is **representation coverage, not a semantic-parity claim**. Semantic parity is proven only
where shared vectors exist — currently the eight portable operations, which are byte-for-byte
verified across Go native, Go in WebAssembly, and the native Deno adapter.

WASM portability classes: A=140, B=171, C=75, D=331, E=174.

## Backward compatibility rules

- Public APIs, **including legacy misspelled Go names**, are not removed or renamed without consumer
  evidence and a migration path. Corrected naming goes into the generated and versioned ABI
  contracts rather than breaking Go source.
- Deprecations ship with the replacement available in the same release.
- The error catalog's **order is contractual**, not just its contents: the guest manifest is
  compared position by position.

## Drift detection

Four gates fail loudly instead of letting the two repositories diverge silently:

| Gate                                         | Detects                                                          |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `deno task contract:check`                   | The generated TypeScript contract is stale vs the GoForge bundle |
| `generated_contract_test.ts`                 | The hand-written public surface disagrees with the generated one |
| `vectors_test.ts`                            | The vendored shared vectors differ from GoForge's copy           |
| `deno task inventory:check` / `matrix:check` | The public API inventory or coverage matrix is stale             |

All four run in CI. The generated contract is regenerated, never hand-edited.

## Coverage floors

- **GoForge:** no per-module regression from the Phase 0 baseline — root 91.0%, logger 94.8%,
  encrypt 89.7%, security 91.8%, qgo 87.6%, go-openssl 83.9%, portable 92.2%. Enforced by
  `scripts/check-coverage.sh`.
- **DenoForge:** ≥80% overall, enforced by `deno task cov:check` against a fresh profile.

## Related

- [Architecture](./architecture.md) · [Migration](./migration.md) · [Security](./security.md)

See [compatibility.es.md](./compatibility.es.md) for the Spanish version.
