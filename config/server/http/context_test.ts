// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { buildHttpLogEntry } from "../../../logger/middlewares/http.ts";
import { getRequestContext } from "../../../security/middlewares/context.ts";
import {
  httpContext,
  type HttpRequestContext,
  isValidTraceparent,
  isValidTracestate,
} from "./context.ts";

Deno.test("httpContext propagates valid request and W3C trace context", async () => {
  const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const response = new Response("ok");
  let seen: HttpRequestContext | undefined;
  const handler = httpContext({
    requestIdHeader: "x-correlation-id",
    attributes: { serviceArea: "dashboard" },
  })((request) => {
    seen = getRequestContext<HttpRequestContext>(request);
    seen!.attributes.targetKind = "backend";
    seen!.process.push({ system: "auth", process: "validate", latency: 1.6 });
    return response;
  });
  const request = new Request("http://example.test/dashboard?ignored=1", {
    method: "POST",
    headers: {
      "x-correlation-id": "request-123",
      traceparent,
      tracestate: "vendor=value",
    },
  });

  const actual = await handler(request);

  assertStrictEquals(actual, response);
  assertEquals(actual.headers.get("x-correlation-id"), "request-123");
  assertEquals(seen?.requestId, "request-123");
  assertEquals(seen?.traceparent, traceparent);
  assertEquals(seen?.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assertEquals(seen?.spanId, "00f067aa0ba902b7");
  assertEquals(seen?.traceFlags, "01");
  assertEquals(seen?.tracestate, "vendor=value");
  assertEquals(seen?.method, "POST");
  assertEquals(seen?.pathname, "/dashboard");
  assertEquals(seen?.attributes, { serviceArea: "dashboard", targetKind: "backend" });
  assertEquals(seen?.process[0].latency, 1.6);
  assertEquals(typeof seen?.startedAt, "number");
});

Deno.test("httpContext replaces invalid trace data and does not capture sensitive headers", async () => {
  let seen: HttpRequestContext | undefined;
  const handler = httpContext({
    requestIdFactory: () => "generated-request-id",
  })((request) => {
    seen = getRequestContext<HttpRequestContext>(request);
    return new Response();
  });
  const request = new Request("http://example.test/private", {
    headers: {
      authorization: "Bearer highly-secret",
      cookie: "session=highly-secret",
      traceparent: "invalid",
      tracestate: "also invalid",
      "x-extra": "must-not-be-copied",
    },
  });

  const response = await handler(request);

  assertEquals(response.headers.get("x-request-id"), "generated-request-id");
  assert(seen);
  assert(isValidTraceparent(seen.traceparent));
  assertEquals(seen.tracestate, undefined);
  const serialized = JSON.stringify(seen);
  assert(!serialized.includes("highly-secret"));
  assert(!serialized.includes("authorization"));
  assert(!serialized.includes("cookie"));
  assert(!serialized.includes("x-extra"));
});

Deno.test("trace context validators enforce W3C shape and limits", () => {
  assert(
    isValidTraceparent(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
    ),
  );
  assert(
    !isValidTraceparent(
      "00-00000000000000000000000000000000-00f067aa0ba902b7-00",
    ),
  );
  assert(!isValidTraceparent("FF-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01"));
  assert(isValidTracestate("vendor=value,tenant@system=opaque"));
  assert(!isValidTracestate("vendor=value,vendor=duplicate"));
  assert(!isValidTracestate("vendor=trailing "));
});

Deno.test("HTTP context feeds direct log attributes, process, latency, and skipLogging", async () => {
  const request = new Request("http://example.test/dashboard");
  let entry = buildHttpLogEntry(request, { response: new Response() });
  assert(entry);

  await httpContext()((contextRequest) => {
    const context = getRequestContext<HttpRequestContext>(contextRequest)!;
    context.attributes.microfrontend = "dashboard";
    context.attributes.errorCode = "permission_denied";
    context.process.push({ system: "permissions", process: "authorize", latency: 2.7 });
    entry = buildHttpLogEntry(contextRequest, { response: new Response("", { status: 403 }) });
    return new Response();
  })(request);

  assertEquals(entry?.details.microfrontend, "dashboard");
  assertEquals(entry?.details.errorCode, "permission_denied");
  assertEquals(entry?.details.status, 403);
  assertEquals(entry?.details.process, [
    { system: "permissions", process: "authorize", latency: 3 },
  ]);
  assertEquals(typeof entry?.details.latency, "number");

  await httpContext()((contextRequest) => {
    getRequestContext<HttpRequestContext>(contextRequest)!.skipLogging = true;
    entry = buildHttpLogEntry(contextRequest, { error: new Error("hidden") });
    return new Response();
  })(new Request("http://example.test/skip"));
  assertEquals(entry, undefined);
});
