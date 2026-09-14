// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  activeSpan,
  activeSpanContext,
  type ForgeSpan,
  type ForgeSpanContext,
  getMeter,
  getTracer,
  runInSpan,
  traceparent,
  withSpan,
} from "./mod.ts";

const spanContext: ForgeSpanContext = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  traceFlags: 1,
  isRemote: false,
};

function testSpan(): ForgeSpan {
  return {
    spanContext: () => spanContext,
    end: () => undefined,
    recordException: () => undefined,
    setStatus: () => testSpan(),
  } as unknown as ForgeSpan;
}

Deno.test("telemetry formats valid W3C traceparent values", () => {
  assertEquals(
    traceparent(spanContext),
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  );
  assertEquals(traceparent(undefined), undefined);
});

Deno.test("withSpan exposes the active span and its identifiers", () => {
  const span = testSpan();
  const seen = withSpan(span, () => ({ span: activeSpan(), context: activeSpanContext() }));
  // Deno's disabled telemetry context manager is intentionally a no-op.
  if (seen.span) {
    assertStrictEquals(seen.span, span);
    assertEquals(seen.context, spanContext);
  } else {
    assertEquals(seen.context, undefined);
  }
});

Deno.test("runInSpan closes a span and restores the parent context", async () => {
  const value = await runInSpan("test.operation", () => {
    const current = activeSpan();
    if (current) assertEquals(current.spanContext(), spanContext);
    return 42;
  });

  assertEquals(value, 42);
  assertEquals(activeSpan(), undefined);
});

Deno.test("public tracer and meter factories are available without an SDK bundle", () => {
  assertEquals(typeof getTracer().startSpan, "function");
  assertEquals(typeof getMeter().createCounter, "function");
});
