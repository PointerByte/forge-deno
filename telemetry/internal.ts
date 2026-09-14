// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/** Internal bridge to the OpenTelemetry API; not part of the package exports. */

import {
  type Context,
  context,
  type Meter,
  metrics,
  propagation,
  type Span,
  type SpanContext,
  type SpanOptions,
  SpanStatusCode,
  type TextMapGetter,
  type TextMapSetter,
  trace,
  type Tracer,
} from "@opentelemetry/api";

export { context, metrics, propagation, SpanStatusCode, trace };
export type {
  Context,
  Meter,
  Span,
  SpanContext,
  SpanOptions,
  TextMapGetter,
  TextMapSetter,
  Tracer,
};

export const FORGE_TELEMETRY_SCOPE = "@pointerbyte/forge-deno";
export const FORGE_TELEMETRY_VERSION = "1.0.0";

export function getOtelTracer(
  name = FORGE_TELEMETRY_SCOPE,
  version = FORGE_TELEMETRY_VERSION,
): Tracer {
  return trace.getTracer(name, version);
}

export function getOtelMeter(
  name = FORGE_TELEMETRY_SCOPE,
  version = FORGE_TELEMETRY_VERSION,
): Meter {
  return metrics.getMeter(name, version);
}

export function getActiveOtelSpan(): Span | undefined {
  return trace.getSpan(context.active());
}

export function isValidOtelSpanContext(spanContext: SpanContext | undefined): boolean {
  return Boolean(
    spanContext &&
      /^[0-9a-f]{32}$/.test(spanContext.traceId) &&
      !/^0+$/.test(spanContext.traceId) &&
      /^[0-9a-f]{16}$/.test(spanContext.spanId) &&
      !/^0+$/.test(spanContext.spanId),
  );
}

export function withOtelSpan<T>(
  span: Span,
  fn: () => T,
  parentContext: Context = context.active(),
): T {
  return context.with(trace.setSpan(parentContext, span), fn);
}

export function recordOtelError(span: Span | undefined, error: unknown): void {
  if (!span) return;
  const message = error instanceof Error ? error.message : String(error);
  span.recordException(error instanceof Error ? error : message);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

export function recordOtelSuccess(span: Span | undefined): void {
  span?.setStatus({ code: SpanStatusCode.OK });
}

export function setOtelHttpRoute(span: Span | undefined, method: string, route: string): void {
  if (!span) return;
  span.setAttribute("http.route", route);
  span.updateName(`${method} ${route}`);
}

export function extractContext<Carrier>(
  carrier: Carrier,
  getter?: TextMapGetter<Carrier>,
  parentContext: Context = context.active(),
): Context {
  return propagation.extract(parentContext, carrier, getter);
}

export function injectContext<Carrier>(
  carrier: Carrier,
  setter?: TextMapSetter<Carrier>,
  activeContext: Context = context.active(),
): void {
  propagation.inject(activeContext, carrier, setter);
}
