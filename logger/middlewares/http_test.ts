// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { initLogger, type Logger } from "../builder/builder.ts";
import { buildHttpLogEntry, type HttpLogEntryOptions, httpLogger } from "./http.ts";

function jsonLogger(lines: string[]): Logger {
  return initLogger({ formatter: "json", sink: (line) => lines.push(line) });
}

Deno.test("httpLogger preserves default output, response identity, and one handler call", async () => {
  const lines: string[] = [];
  const response = new Response("unchanged", { status: 201 });
  let calls = 0;
  const handler = httpLogger(jsonLogger(lines))(() => {
    calls++;
    return response;
  });
  const request = new Request("http://example.test/api?ignored=true", {
    headers: { "x-trace-id": "trace-1", "x-extra": "present" },
  });

  const actual = await handler(request);

  assertStrictEquals(actual, response);
  assertEquals(await actual.text(), "unchanged");
  assertEquals(calls, 1);
  assertEquals(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assertEquals(record.message, "http.request");
  assertEquals(record.level, "INFO");
  assertEquals(record.traceID, "trace-1");
  assertEquals(record.details.method, "GET");
  assertEquals(record.details.path, "/api");
  assertEquals(record.details.status, 201);
  assertEquals(record.details.headers["x-extra"], "present");
});

Deno.test("httpLogger preserves the original thrown value and calls the handler once", async () => {
  const lines: string[] = [];
  const original = { reason: "boom" };
  let calls = 0;
  const handler = httpLogger(jsonLogger(lines))(() => {
    calls++;
    throw original;
  });

  let caught: unknown;
  try {
    await handler(new Request("http://example.test/api"));
  } catch (error) {
    caught = error;
  }

  assertStrictEquals(caught, original);
  assertEquals(calls, 1);
  assertEquals(lines.length, 1);
  assertEquals(JSON.parse(lines[0]).details.error, "[object Object]");
});

Deno.test("skipPaths uses exact pathname strings and stable regular expressions", async () => {
  const lines: string[] = [];
  let calls = 0;
  const options: HttpLogEntryOptions = {
    skipPaths: [
      "/health",
      "/api/status/v1",
      /(?:^|\/)api\/cmk\/status\/?$/gy,
    ],
  };
  const handler = httpLogger(jsonLogger(lines), options)((request) => {
    calls++;
    if (new URL(request.url).pathname === "/health-error") throw new Error("health failed");
    return new Response("ok");
  });

  await handler(new Request("http://example.test/health?ready=1"));
  await handler(new Request("http://example.test/api/status/v1"));
  await handler(new Request("http://example.test/dashboard/api/cmk/status"));
  await handler(new Request("http://example.test/dashboard/api/cmk/status"));
  await handler(new Request("http://example.test/keys/status"));

  assertEquals(calls, 5);
  assertEquals(lines.length, 1);
  assertEquals(JSON.parse(lines[0]).details.path, "/keys/status");
});

Deno.test("an excluded path emits no log when its handler throws", async () => {
  const lines: string[] = [];
  const original = new Error("not ready");
  const handler = httpLogger(jsonLogger(lines), { skipPaths: ["/health"] })(() => {
    throw original;
  });

  let caught: unknown;
  try {
    await handler(new Request("http://example.test/health"));
  } catch (error) {
    caught = error;
  }

  assertStrictEquals(caught, original);
  assertEquals(lines, []);
});

Deno.test("shouldLog can inspect status and a predicate error safely suppresses logging", async () => {
  const lines: string[] = [];
  const logger = jsonLogger(lines);
  const onlyFailures = httpLogger(logger, {
    shouldLog: (_request, outcome) => "response" in outcome && outcome.response.status >= 400,
  });

  await onlyFailures(() => new Response("ok"))(new Request("http://example.test/ok"));
  await onlyFailures(() => new Response("missing", { status: 404 }))(
    new Request("http://example.test/missing"),
  );
  assertEquals(lines.length, 1);
  assertEquals(JSON.parse(lines[0]).details.status, 404);

  const response = new Response("still ok");
  const unsafeFilter = httpLogger(logger, {
    shouldLog: () => {
      throw new Error("filter failed");
    },
  })(() => response);
  assertStrictEquals(await unsafeFilter(new Request("http://example.test/")), response);
  assertEquals(lines.length, 1);
});

Deno.test("includeHeaders false omits the property while the default includes it", async () => {
  const defaultLines: string[] = [];
  const privateLines: string[] = [];
  const request = () =>
    new Request("http://example.test/", {
      headers: { authorization: "Bearer secret", cookie: "session=secret" },
    });

  await httpLogger(jsonLogger(defaultLines))(() => new Response())(request());
  await httpLogger(jsonLogger(privateLines), { includeHeaders: false })(() => new Response())(
    request(),
  );

  assert("headers" in JSON.parse(defaultLines[0]).details);
  assert(!("headers" in JSON.parse(privateLines[0]).details));
});

Deno.test("buildHttpLogEntry is side-effect free, preserves bodies, and supports exclusions", () => {
  const request = new Request("http://example.test/items", {
    method: "POST",
    body: "request body",
  });
  const response = new Response("response body", { status: 202 });

  const entry = buildHttpLogEntry(request, { response }, {
    includeHeaders: false,
    startedAt: performance.now(),
  });

  assertEquals(entry?.level, "info");
  assertEquals(entry?.message, "http.request");
  assertEquals(entry?.details.method, "POST");
  assertEquals(entry?.details.path, "/items");
  assertEquals(entry?.details.status, 202);
  assert(!("headers" in (entry?.details ?? {})));
  assertEquals(request.bodyUsed, false);
  assertEquals(response.bodyUsed, false);
  assertEquals(
    buildHttpLogEntry(request, { response }, { skipPaths: ["/items"] }),
    undefined,
  );
});

Deno.test("builder and middleware produce the same canonical HTTP attributes", async () => {
  const lines: string[] = [];
  const request = new Request("http://example.test/same", {
    headers: { "x-trace-id": "trace-same" },
  });
  const response = new Response(null, { status: 204 });
  const built = buildHttpLogEntry(request, { response }, { startedAt: performance.now() });

  await httpLogger(jsonLogger(lines))(() => response)(request);
  const record = JSON.parse(lines[0]);

  assertEquals(record.message, built?.message);
  assertEquals(record.details.method, built?.details.method);
  assertEquals(record.details.path, built?.details.path);
  assertEquals(record.details.status, built?.details.status);
  assertEquals(record.traceID, built?.details.traceID);
  assertEquals(record.details.headers, Object.fromEntries(request.headers));
});

Deno.test("a direct handler logger call owns the recorded caller", async () => {
  const lines: string[] = [];
  const logger = jsonLogger(lines);

  function directLogHandler(request: Request): Response {
    const response = new Response(JSON.stringify({ ok: true }), { status: 200 });
    const entry = buildHttpLogEntry(request, { response });
    if (entry?.level === "info") {
      logger.info(entry.message, entry.details); // DIRECT_HTTP_LOG_CALL
    }
    return response;
  }

  const response = await directLogHandler(new Request("http://example.test/direct"));
  assertEquals(await response.json(), { ok: true });
  const record = JSON.parse(lines[0]);
  const source = await Deno.readTextFile(new URL(import.meta.url));
  const expectedLine =
    source.split("\n").findIndex((line) => line.includes("DIRECT_HTTP_LOG_CALL")) + 1;

  assertEquals(record.method, "directLogHandler");
  assertEquals(record.line, expectedLine);
  assert(!String(record.method).includes("httpLogger"));
  assert(!String(record.method).includes("buildHttpLogEntry"));
  assert(!String(record.method).includes("Logger"));
});
