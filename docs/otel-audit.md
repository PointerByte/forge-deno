# OpenTelemetry Audit — forge-deno

Date: 2026-08-22 Runtime used for the audit: `deno 2.9.5 (stable, x86_64-unknown-linux-gnu)`, V8
15.0.245.2, TypeScript 6.0.3. Baseline commit: `2e6ce72`. Method: read of the actual current source,
plus empirical probes of the Deno runtime against a stock `otel/opentelemetry-collector:0.159.0`.

## 1. Current OpenTelemetry capability: none

There is **no** OpenTelemetry implementation in this repository.

- No `@opentelemetry/*` entry in `deno.json` `imports`, none in `deno.lock`.
- No tracer, meter, logger provider, exporter, resource, or sampler anywhere.
- No `telemetry` export in `deno.json`.
- `tools/wasm/component/compatibility_matrix.ts` labels the `./logger` module "Logger /
  OpenTelemetry", which overstates what exists.
- `docs/architecture.md` mentions OpenTelemetry only to classify it as a _host adapter_ that must
  stay outside the portable core.

The only tracing-adjacent code is `config/server/http/context.ts`, which hand-implements W3C
`traceparent`/`tracestate`:

- `isValidTraceparent` / `isValidTracestate` — format validation;
- `newTraceparent()` — generates a random trace id + span id when the incoming request has none;
- `RequestContext` exposes `traceparent`, `traceId`, `spanId`, `traceFlags`.

This is correlation plumbing, not OpenTelemetry: the ids are never attached to a span, never
sampled, and never exported. Because it _mints_ a `traceparent` when none arrives, a downstream
service receives a trace id that no exporter has ever seen.

Signal-by-signal, before this change: traces **none**, metrics **none**, logs **none** (OTLP; the
structured logger itself works and writes to `console.log`/file), propagation **partial**
(hand-rolled W3C header handling, no baggage), HTTP instrumentation **none**, gRPC instrumentation
**none**, resource attributes **none**, semantic conventions **none**, exporter configuration
**none**, shutdown **n/a**, OTel tests **none**.

## 2. Runtime capability survey (measured, not assumed)

Deno 2.9.5 ships OpenTelemetry support in the runtime. Findings:

- `Deno.telemetry` is available **without any `--unstable-*` flag**; there is no longer an
  `--unstable-otel` flag. It exposes three singletons documented as implementing the OpenTelemetry
  JS API interfaces: `tracerProvider`, `meterProvider`, `contextManager`.
- Enablement gate is `OTEL_DENO=true` (only the literal strings `true`/`false` are accepted;
  `OTEL_DENO=1` prints a warning and is ignored).
- `OTEL_SDK_DISABLED=true` **is honoured** and wins over `OTEL_DENO=true`.
- With `OTEL_DENO=true` the runtime **auto-registers** the global tracer provider, meter provider,
  context manager **and a W3C TraceContext + Baggage composite propagator** into
  `npm:@opentelemetry/api`. Measured `propagation.fields()` →
  `["baggage", "traceparent", "tracestate"]`.
- With OTel disabled, `propagation.fields()` → `[]`, `tracer.startSpan()` returns a non-recording
  span with an all-zero span context, and `propagation.extract` yields no span context.
  Telemetry-disabled mode is therefore a runtime property, not something the library must emulate.
- Auto-instrumentation observed end-to-end against the stock collector:
  - `Deno.serve` → `SpanKind.SERVER` span, attributes `http.request.method`, `url.full`,
    `url.scheme`, `url.path`, `url.query`, `http.response.status_code`. **`http.route` is absent and
    the span name is just the method** (`GET`), because the runtime cannot know the route.
  - `fetch` → `SpanKind.CLIENT` span, same HTTP attributes, with W3C headers injected (verified: the
    server span was a child of the client span in one trace).
  - `console.log`/`console.error` → OTLP log records carrying the **correct `traceId` and `spanId`**
    of the active span.
  - Metrics: `http.server.request.duration`, `http.server.active_requests`,
    `http.server.request.body.size`, `http.server.response.body.size` (standard HTTP semconv), plus
    `v8js.*` runtime metrics, plus any user instrument.
  - Manual spans and instruments created through `npm:@opentelemetry/api` are exported under their
    own instrumentation scope.

## 3. Consequences for the design

1. The correct architecture is **the runtime's native OTel**, surfaced through the official
   `npm:@opentelemetry/api` package. Bundling `@opentelemetry/sdk-*` would create a second,
   competing SDK and duplicate the spans the runtime already emits.
2. Because `Deno.serve` and `fetch` are auto-instrumented, forge-deno must **not** create its own
   HTTP server or client spans (§27 of the task: avoid duplicate spans). The gap worth filling is
   `http.route` and the span name, which must be applied to the _ambient_ span.
3. `console.log` is already the logger's default sink, so the existing structured logger reaches
   OTLP logs with trace correlation without replacing it. What is missing is exposing
   `trace_id`/`span_id` inside the structured payload itself.
4. `@grpc/grpc-js` is **not** auto-instrumented by the runtime, and no official
   `@opentelemetry/instrumentation-grpc` path exists for it under Deno without pulling the Node SDK.
   gRPC therefore needs explicit Forge interceptors doing context extract/inject plus spans using
   current RPC semantic conventions.
5. `config/server/http/context.ts` minting a `traceparent` conflicts with real propagation once OTel
   is on: the ambient span's context must win.
6. Dependency isolation (`deno task check:deps`) forbids `logger`, `security` and `config/http` from
   resolving `@grpc/grpc-js`; a telemetry module shared by all of them must not import gRPC types
   eagerly.

## 4. Limitations to state honestly

- `Deno.telemetry` exposes **no flush/shutdown API**. Exported telemetry is flushed by the runtime
  at process exit and on the periodic export interval (`OTEL_METRIC_EXPORT_INTERVAL`,
  `OTEL_BSP_SCHEDULE_DELAY`). A Forge `shutdown()` can end outstanding Forge-owned spans and wait a
  bounded drain interval, but it cannot force-flush the runtime exporter.
- OTLP transport selection is the runtime's: `OTEL_EXPORTER_OTLP_PROTOCOL` supports `http/protobuf`
  and `http/json`. There is no OTLP/gRPC exporter in the Deno runtime, so a Collector must expose
  its HTTP receiver (4318).
- Sampling, batching, resource detection and endpoint/TLS/header configuration are all owned by the
  runtime's standard `OTEL_*` variables; Forge configures them, it does not reimplement them.
