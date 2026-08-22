# Troubleshooting

Concrete failures from the forge-go integration, what actually causes them, and what to do.

Every runtime failure is a subclass of `WasmRuntimeError`, so the class tells you which layer failed
before you read the message.

## `RangeError: Maximum call stack size exceeded` under sustained load

**Cause:** a known defect in the shipped component, not in your code. The Go runtime inside it
intermittently traps during garbage collection while calling the WASI clock. The guest stack shows
`runtime.morestack → runtime.badmorestackg0 → runtime.switchToCrashStack → runtime.usleep`. Under
wasmtime the same defect surfaces as a trap in `clock_time_get`.

It is **intermittent** — thresholds observed between 1,166 and 17,532 dispatches in otherwise
identical cold processes — so a run that succeeds proves nothing.

**What to do:** route sustained or latency-sensitive work through the native adapter:

```ts
await runtime.invoke(operation, payload, {
  target: { kind: "native", adapter: GOFORGE_NATIVE_ADAPTER_NAME },
});
```

**What not to do:** set `GOGC=off`. It removes the trap by disabling collection entirely and trades
it for unbounded guest memory growth. It is a diagnostic setting only.

**Status:** isolated to the componentize-go compiler. A TinyGo build of identical guest source
survives the same workload with 0/10 traps and full vector parity; switching the production compiler
is proposed but not yet approved. See `forge-go-private/research/component-tinygo/`.

## `WasmIntegrityError`

**Cause:** a digest did not match. Either `manifest.json` does not hash to the `manifestSha256` you
supplied, or an artifact does not match the digest the manifest pins for it.

**Check, in order:**

1. Did you rebuild the component? The digest changes. Note that it is **not** stable across
   unrelated edits elsewhere in the `component` module — editing a package the guest provably does
   not link still changes the artifact. Pin digests to an exact commit, not to "I only touched a
   test".
2. Is `manifestSha256` the digest of the manifest _file_, not of the component?
3. Did the bundle transfer intact? Compare against `artifacts/SHA256SUMS`.

This error is doing its job. Do not work around it by re-reading the digest from the bundle you are
verifying — that verifies nothing.

## `WasmCompatibilityError`

**Cause:** the bundle loaded fine but does not match what you declared. Either `componentVersion` or
`witPackage` disagrees, or you invoked an operation the manifest does not declare.

**Check:** `compatibility` in your runtime options against `manifest.json`. For an unknown
operation, confirm it is one of the eight canonical ones — `text.normalize`, `text.validate`,
`crypto.sha256`, `crypto.hmac-sha256`, `crypto.aes-gcm.encrypt`, `crypto.aes-gcm.decrypt`,
`encoding.base64.encode`, `encoding.base64.decode`.

## `WasmCapabilityDeniedError`

**Cause:** the guest tried to use a WASI capability the host withholds — filesystem, streams,
terminal, environment or arguments.

**This is not a bug to route around.** The portable core performs no I/O; only clocks and the CSPRNG
are granted. A denial means either the component is not the one you think it is, or something was
added to the guest that does not belong in a portable core. Investigate before widening
`wasiImports`; widening it grants authority the contract never asks for.

## `WasmGuestError` with `invalid_base64`

**Cause:** the ABI requires **canonical, padded, standard-alphabet** Base64 (RFC 4648). Rejected:
unpadded values, the URL-safe alphabet (`-` and `_`), and non-canonical trailing bits — `QR==`
decodes to the same byte as `QQ==` but is not canonical, and both the Go core and the native adapter
re-encode and compare to catch exactly that.

**Fix:** use `encodeAbiBase64` / `decodeAbiBase64` rather than `btoa` or a hand-rolled encoder.

## `WasmGuestError` with `unknown_field` or `invalid_request`

**Cause:** payload decoding is strict. `unknown_field` means you sent a key the operation does not
declare; `invalid_request` with a `field` means a required key is missing or `null`.

The `field` on the error names the exact path (`payload.data`, `payload.rules`). Use it — the
message is deliberately generic and stable.

## `WasmGuestError` with `invalid_key` or `invalid_nonce`

**Cause:** key and nonce sizes are enforced, not coerced. HMAC keys must be at least 16 bytes.
AES-GCM keys must be exactly 16, 24 or 32 bytes and nonces exactly 12.

## `WasmGuestError` with `authentication_failed`

**Cause:** AES-GCM decryption failed. Deliberately, the error does not say why — ciphertext, tag,
nonce and associated data all produce the same failure, so a forgery attempt learns nothing.

**Check:** the associated data matches what was used at encryption time. Changed AAD is the most
common cause and looks identical to tampering.

## `WasmDeadlineExceededError` / `WasmCancelledError`

**Cause:** the deadline elapsed or the caller's signal aborted. These are never retried, even if you
put `deadline_exceeded` or `cancellation_requested` in the retry allowlist — retrying something the
caller cancelled is wrong regardless of configuration.

## `WasmPoolError`

**Cause:** every pooled instance is busy and the wait was abandoned.

**Check:** raise `poolSize`, or reconsider whether the component is the right path for this call
volume. A component dispatch costs ~200–600 µs; sustained throughput belongs on the native adapter.

## Bundle not found / harnesses print `SKIP`

**Cause:** the release bundle ships separately from the JSR package and is located through the
injected `WasmArtifactReader`.

**Fix:** build it, or point at it explicitly:

```bash
cd forge-go-private/component && ./scripts/build.sh
export GOFORGE_COMPONENT_BUNDLE=/absolute/path/to/component/artifacts/
```

Tests and harnesses skip rather than fail when it is absent, so a standalone checkout stays usable.

## `deno task contract:check` fails

**Cause:** `wasm/generated/goforge-contract.ts` is stale relative to the forge-go release bundle — a
contract change landed upstream.

**Fix:** `deno task contract`, then run the suite. `generated_contract_test.ts` will name the exact
drift if the hand-written surface in `contracts.ts` / `codec.ts` also needs updating. Do not edit
the generated file; it is regenerated from the manifest.

## The vendored vectors drift test fails

**Cause:** `wasm/testdata/vectors/v1.json` no longer matches forge-go's copy. forge-go owns those
bytes.

**Fix:** re-copy from `forge-go-private/share/portable/testdata/vectors/v1.json`. Note that
`wasm/testdata` is excluded from `deno fmt` on purpose — if formatting changed the file, restore it
rather than accepting the reformat.

See [troubleshooting.es.md](./troubleshooting.es.md) for the Spanish version.
