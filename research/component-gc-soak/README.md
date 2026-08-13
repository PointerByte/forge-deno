# Component endurance harnesses

The Deno half of the GoForge component garbage-collection investigation. Nothing here is part of the
published package — `deno.json` excludes `research/` from JSR and from the coverage floor.

| Harness                                          | Question it answers                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| [`soak.ts`](./soak.ts)                           | Does the shipped componentize-go component survive sustained dispatch? |
| [`tinygo_soak.ts`](./tinygo_soak.ts)             | Does the TinyGo build of the same world survive it?                    |
| [`tinygo_parity.ts`](./tinygo_parity.ts)         | Does the TinyGo build return byte-identical results?                   |
| [`tinygo_throughput.ts`](./tinygo_throughput.ts) | What does the TinyGo build cost per dispatch?                          |
| [`tinygo_component.ts`](./tinygo_component.ts)   | Shared loader for the TinyGo comparison artifact.                      |

## Why these are harnesses and not tests

The componentize-go trap is intermittent and its threshold varies widely between otherwise identical
cold processes. An assertion that expects it would fail perhaps 30–90% of the time depending on the
session, which trains people to ignore failures. The suite stays deterministic; the flaky phenomenon
is measured here, across many cold processes, as a rate.

## Results

Same workload, same host, same guest source — only the compiler differs:

| Host                    | componentize-go 0.4.0 | TinyGo 0.41.1  |
| ----------------------- | --------------------- | -------------- |
| Deno 2.9.4 + jco 1.26.1 | 9 / 10 trapped        | 0 / 10 trapped |
| wasmtime 47.0.3         | 2 / 10 trapped        | 0 / 10 trapped |

All 8 shared vectors and the canonical ABI manifest are identical between the two builds. TinyGo
costs roughly 2.3–3.5× more per dispatch.

Full analysis, including why the trade is still worth taking, is in
[ADR 0012](../../../forge-go-private/openspec/changes/tinygo-wasip2-goforge-integration/adr/0012-tinygo-production-component-compiler.md).

## Run them

The componentize-go harness needs the production release bundle; the TinyGo ones need the comparison
artifact built and transpiled first:

```bash
cd ../../../forge-go-private/component        && ./scripts/build.sh
cd ../research/component-tinygo              && ./scripts/build.sh && ./scripts/transpile.sh
cd ../../../forge-deno-private

deno run -A research/component-gc-soak/soak.ts --runs=10
deno run -A research/component-gc-soak/tinygo_soak.ts --runs=10
deno run -A research/component-gc-soak/tinygo_parity.ts
deno run -A research/component-gc-soak/tinygo_throughput.ts
```

Every harness prints `SKIP` rather than failing when its artifact is absent, so a standalone
checkout without the GoForge sibling repository stays usable.

`--gogc=off` defers guest collection. It removes the trap and is diagnostic only: it trades the
crash for unbounded guest memory growth and must never be a production setting.

See [README.es.md](./README.es.md) for the Spanish version.
