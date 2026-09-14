# OpenTelemetry

`forge-deno` integrates with the OpenTelemetry API and Deno's native runtime telemetry. The
application does not bundle a second SDK or exporter.

## Enable OTLP

Start the process with the runtime enabled and configure the standard OTEL environment variables:

```sh
OTEL_DENO=true \
OTEL_SERVICE_NAME=orders-api \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
deno run --allow-net main.ts
```

Deno exports HTTP server spans and metrics for `Deno.serve`, HTTP client spans for `fetch`, runtime
metrics, and `console.log`/`console.error` as OTLP logs. The Collector must expose its OTLP/HTTP
receiver on port `4318`; Deno's native exporter does not use OTLP/gRPC.

## Forge API

```ts
import { getMeter, getTracer, runInSpan } from "@pointerbyte/denoforge/telemetry";

const tracer = getTracer("orders");
const meter = getMeter("orders");
const orders = meter.createCounter("orders.created");

await runInSpan("orders.persist", async (span) => {
  orders.add(1, { operation: "create" });
  span.setAttribute("order.kind", "standard");
  // persistence work
});
```

`httpContext()` uses the ambient Deno server span when one exists, propagates W3C Trace Context and
Baggage, and no longer replaces a real span with a synthetic trace. `HttpServer` adds `http.route`
and a route-aware span name after its router resolves a path.

`GrpcServer` and `GrpcClient` instrument unary calls by default, inject and extract W3C metadata,
and record `rpc.server.duration` / `rpc.client.duration`. Set `telemetry: false` on either wrapper,
or on an individual client call, to disable the built-in gRPC instrumentation.

The structured logger automatically copies the active W3C `traceID` and `spanID` into its JSON/text
record. Its default console sink therefore remains correlated with the OTLP log record emitted by
Deno.

## Runtime constraints

Exporter endpoint, headers, TLS, sampling, batching, resource detection and export intervals remain
controlled by standard `OTEL_*` variables. Deno does not expose a force-flush or shutdown API for
its native provider, so graceful server shutdown ends Forge-owned spans and drains requests, while
final OTLP delivery is handled by the runtime's periodic exporter and process-exit flush.
