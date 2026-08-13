# Security

The threat model for the GoForge integration: what is defended, how, and — importantly — what is
not.

## What the design assumes

- **The release bundle may be tampered with in transit or at rest.** Defended.
- **The guest may be buggy or hostile.** Defended by capability denial.
- **The host process is trusted.** Not defended — if an attacker runs code in your Deno process, the
  integrity chain and capability boundary are both moot.
- **Callers are trusted to choose their execution target.** Not defended; see "Explicit routing".

## Integrity: nothing unverified executes

The chain is anchored on a digest **you** supply out of band:

1. `manifestSha256` is checked against the raw bytes of `manifest.json` _before_ the JSON is parsed,
   so a malformed or hostile manifest never reaches the parser.
2. The verified manifest pins SHA-256 digests for the component, the host glue, and every core
   module.
3. Each artifact is verified against its pinned digest.
4. The factory then executes **only those verified bytes**: the glue is imported from an in-memory
   blob built from `bundle.glueBytes`, and core modules are compiled from `bundle.coreModuleBytes`.

Step 4 is what closes the time-of-check-to-time-of-use gap. Nothing is re-read from disk after
verification, so swapping a file between the digest check and instantiation does not work.

Manifest paths must be package-relative with no traversal, URLs, query strings, fragments, encoded
segments, or duplicates.

**Operational note:** the component digest is reproducible from an identical tree but is _not_
stable across unrelated edits elsewhere in the `component` module. Editing a package the guest
provably does not link still changes the artifact. Pin digests to an exact commit.

## Least authority: the guest gets almost nothing

The portable core performs no I/O, so `createDeniedWasiImports()` supplies all eighteen imported
WASI interfaces in their denied form:

| Interface group              | Granted                              |
| ---------------------------- | ------------------------------------ |
| `wasi:clocks/*`              | **Yes** — Go's scheduler requires it |
| `wasi:random/random`         | **Yes** — host CSPRNG                |
| `wasi:filesystem/*`          | No — every entry point refuses       |
| `wasi:io/*`, `wasi:cli/std*` | No — streams closed                  |
| `wasi:cli/terminal-*`        | No — no terminal attached            |
| `wasi:cli/environment`       | No — arguments and environment empty |

Every denial is pinned by a test. `WasmCapabilityDeniedError` reports any attempt to exceed the
boundary.

Passing your own `wasiImports` is supported and is a **security decision**. Replacing a denied stub
grants the guest authority the portable contract never asks for; a guest that needs the filesystem
is not a portable core.

## Fail-closed execution controls

Deadlines and cancellation are not advisory. They cross the WIT boundary as an explicit record whose
`clock-checked` and `cancellation-checked` flags say whether the host actually supplied the control.
A guest asked to honour a deadline without a checked clock refuses rather than proceeding blind.

`control.deadline` and `control.cancellation` are declared as _host_ capabilities for the same
reason: the guest cannot satisfy them alone, and the contract says so rather than pretending
otherwise.

## Explicit routing: no silent downgrade

**A component failure never selects a native adapter.** This is the single most important security
property of the runtime, because the operations include cryptography. An automatic fallback would
mean a transient guest failure silently moves key handling to a different implementation — the shape
of a real incident.

Three independent conditions must hold before a native adapter runs:

1. The caller explicitly names it as the target for that invocation.
2. The **release manifest** lists it under `nativeAdapters` for that operation.
3. The adapter carries `parityQualified: true`, obtainable only by replaying every GoForge shared
   vector byte for byte.

Retries are similarly constrained: they require an opt-in, a `retrySafe` declaration in the release,
a retryable catalog error, and a matching allowlist entry. Traps, malformed output, integrity
failures, compatibility failures, deadlines and cancellations are never retried regardless of
configuration.

## Error messages leak nothing

The error catalog is immutable and its messages are stable and generic. Notably,
`authentication_failed` is returned identically for a wrong key, a wrong nonce, altered associated
data, a truncated ciphertext and a forged tag — a forgery attempt learns nothing from the response.

Observer events carry lifecycle metadata only: never payloads, results, guest messages, error
fields, or secrets.

## Supply chain

Verified in the Phase 0 audit and enforced in CI:

- `govulncheck` over every Go module; `gosec` static analysis; `gitleaks` over full history and the
  working tree.
- `deno audit` for the Deno dependency graph.
- Every GitHub Action is SHA-pinned; `wasm-tools` is checksum-verified after extraction.
- Cosign sign/verify/tamper and offline digest-rollback were proven in a PoC.

**Deliberately absent:** release packaging, signing and provenance publication. Attesting the
current bundle would put a signature on an artifact that intermittently traps under sustained load.
Those gates get added when that defect is closed — not before. This is stated in both CI workflows.

## Known weaknesses

- **The shipped component is not fit for sustained production load.** It traps intermittently during
  garbage collection. This is an availability defect, not a confidentiality one, but a cryptographic
  component that crashes is still a problem. See [troubleshooting](./troubleshooting.md).
- **`GOGC=off` must never be used in production.** It removes the trap by disabling collection and
  substitutes unbounded memory growth.
- **The native adapter's guarantees are only as strong as the shared vectors.** Qualification proves
  agreement on the cases GoForge published plus the differential suite's boundary cases. It is
  strong evidence, not a proof of total equivalence.

## Related

- [Architecture](./architecture.md) · [Compatibility](./compatibility.md) ·
  [Troubleshooting](./troubleshooting.md)

See [security.es.md](./security.es.md) for the Spanish version.
