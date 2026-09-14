// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenTelemetry integration for forge-deno.
 *
 * Deno owns the SDK, exporters, batching, sampling and resource detection
 * when the process is started with `OTEL_DENO=true`. When it is disabled,
 * these functions remain safe no-ops through the API's proxy providers.
 *
 * @module
 */

import type {
  Span as OTelSpan,
  SpanContext as OTelSpanContext,
  SpanOptions as OTelSpanOptions,
} from "@opentelemetry/api";
import {
  context as otelContext,
  getActiveOtelSpan,
  getOtelMeter,
  getOtelTracer,
  isValidOtelSpanContext,
  recordOtelError,
  recordOtelSuccess,
  setOtelHttpRoute,
  withOtelSpan,
} from "./internal.ts";

/** Primitive attribute values accepted by Forge telemetry helpers. */
export type TelemetryAttribute = string | number | boolean | readonly (string | number | boolean)[];

/** Minimal metric options shared by Forge's meter facade. */
export interface TelemetryMetricOptions {
  /** Human-readable metric description. */
  description?: string;
  /** Metric unit, such as `ms` or `bytes`. */
  unit?: string;
}

/** Public span context without exposing private declaration types from npm. */
export interface ForgeSpanContext {
  /** W3C trace identifier. */
  traceId: string;
  /** W3C span identifier. */
  spanId: string;
  /** W3C trace flags. */
  traceFlags: number;
  /** Whether the context came from a remote carrier. */
  isRemote: boolean;
}

/** Public span surface needed to create and annotate Forge operations. */
export interface ForgeSpan {
  /** Returns the immutable context identifying this span. */
  spanContext(): ForgeSpanContext;
  /** Adds one attribute. */
  setAttribute(key: string, value: TelemetryAttribute): ForgeSpan;
  /** Adds multiple attributes. */
  setAttributes(attributes: Record<string, TelemetryAttribute>): ForgeSpan;
  /** Adds an event to the span. */
  addEvent(name: string, attributes?: Record<string, TelemetryAttribute>): ForgeSpan;
  /** Sets the span status code. */
  setStatus(status: { code: number; message?: string }): ForgeSpan;
  /** Changes the display name of the span. */
  updateName(name: string): ForgeSpan;
  /** Ends the span. */
  end(): void;
  /** Reports whether this span is recording. */
  isRecording(): boolean;
  /** Records an exception event. */
  recordException(exception: Error | string): void;
}

/** Public tracer surface for manual Forge spans. */
export interface ForgeTracer {
  /** Starts a span without changing the active context. */
  startSpan(name: string, options?: Record<string, unknown>): ForgeSpan;
}

/** Public counter surface for application metrics. */
export interface ForgeCounter {
  /** Adds a value to the counter. */
  add(value: number, attributes?: Record<string, TelemetryAttribute>): void;
}

/** Public histogram surface for application metrics. */
export interface ForgeHistogram {
  /** Records one measurement. */
  record(value: number, attributes?: Record<string, TelemetryAttribute>): void;
}

/** Public meter surface for application metrics. */
export interface ForgeMeter {
  /** Creates a monotonically increasing counter. */
  createCounter(name: string, options?: TelemetryMetricOptions): ForgeCounter;
  /** Creates a duration or size histogram. */
  createHistogram(name: string, options?: TelemetryMetricOptions): ForgeHistogram;
}

/** Instrumentation scope used by forge-deno-created spans and instruments. */
export const FORGE_TELEMETRY_SCOPE = "@pointerbyte/forge-deno";
/** Version of the instrumentation scope. */
export const FORGE_TELEMETRY_VERSION = "1.0.0";

/** Returns a tracer in the forge-deno instrumentation scope by default. */
export function getTracer(
  name = FORGE_TELEMETRY_SCOPE,
  version = FORGE_TELEMETRY_VERSION,
): ForgeTracer {
  return getOtelTracer(name, version) as unknown as ForgeTracer;
}

/** Returns a meter in the forge-deno instrumentation scope by default. */
export function getMeter(
  name = FORGE_TELEMETRY_SCOPE,
  version = FORGE_TELEMETRY_VERSION,
): ForgeMeter {
  return getOtelMeter(name, version) as unknown as ForgeMeter;
}

/** Returns the active span, if any. */
export function activeSpan(): ForgeSpan | undefined {
  return getActiveOtelSpan() as unknown as ForgeSpan | undefined;
}

/** Returns the valid context of the active span, if one is active. */
export function activeSpanContext(): ForgeSpanContext | undefined {
  const span = getActiveOtelSpan();
  if (!span) return undefined;
  const spanContext = span.spanContext();
  return isValidOtelSpanContext(spanContext) ? toForgeSpanContext(spanContext) : undefined;
}

/** Returns whether a span context contains usable W3C identifiers. */
export function isValidSpanContext(
  spanContext: ForgeSpanContext | undefined,
): spanContext is ForgeSpanContext {
  return Boolean(
    spanContext &&
      /^[0-9a-f]{32}$/.test(spanContext.traceId) &&
      !/^0+$/.test(spanContext.traceId) &&
      /^[0-9a-f]{16}$/.test(spanContext.spanId) &&
      !/^0+$/.test(spanContext.spanId),
  );
}

/** Serializes a span context as a W3C `traceparent` value. */
export function traceparent(spanContext: ForgeSpanContext | undefined): string | undefined {
  if (!spanContext || !isValidSpanContext(spanContext)) return undefined;
  const flags = (spanContext.traceFlags ?? 0).toString(16).padStart(2, "0");
  return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
}

/** Runs `fn` with `span` installed as the active span. */
export function withSpan<T>(span: ForgeSpan, fn: () => T): T {
  return withOtelSpan(span as unknown as OTelSpan, fn);
}

/** Runs `fn` with a new span and closes the span on success or failure. */
export async function runInSpan<T>(
  name: string,
  fn: (span: ForgeSpan) => T | Promise<T>,
  options?: Record<string, unknown>,
): Promise<T> {
  const span = getOtelTracer().startSpan(name, options as OTelSpanOptions | undefined);
  try {
    return await withOtelSpan(span, () => fn(span as unknown as ForgeSpan), otelContext.active());
  } catch (error) {
    recordOtelError(span, error);
    throw error;
  } finally {
    span.end();
  }
}

/** Marks an operation as failed and records its exception. */
export function recordSpanError(span: ForgeSpan | undefined, error: unknown): void {
  recordOtelError(span as unknown as OTelSpan | undefined, error);
}

/** Marks an operation as successful. */
export function recordSpanSuccess(span: ForgeSpan | undefined): void {
  recordOtelSuccess(span as unknown as OTelSpan | undefined);
}

/** Adds the route and conventional name to Deno's ambient HTTP server span. */
export function setHttpRoute(span: ForgeSpan | undefined, method: string, route: string): void {
  setOtelHttpRoute(span as unknown as OTelSpan | undefined, method, route);
}

function toForgeSpanContext(spanContext: OTelSpanContext): ForgeSpanContext {
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags,
    isRemote: Boolean(spanContext.isRemote),
  };
}
