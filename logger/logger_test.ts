// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@std/assert";
import { levelName, LogLevel, parseLevel } from "./common/enums.ts";
import { formatTimestamp, newFormatter } from "./formatter/format.ts";
import type { LogFormat } from "./formatter/models.ts";
import { newSanitizer, Sanitizer, sensibleKeysFromEnv } from "./sanitizer/sanitizer.ts";
import { disableModeTest, enableModeTest, initLogger, type Logger } from "./builder/builder.ts";
import { httpLogger } from "./middlewares/http.ts";
import { grpcLogger } from "./middlewares/grpc.ts";
import { writeWrappedLog } from "./testdata/logging.ts";

// --- enums ------------------------------------------------------------------

Deno.test("level names and parsing", () => {
  assertEquals(levelName(LogLevel.Debug), "DEBUG");
  assertEquals(levelName(LogLevel.Error), "ERROR");
  assertEquals(levelName(LogLevel.Info), "INFO");
  assertEquals(parseLevel("WARN"), LogLevel.Warn);
  assertEquals(parseLevel("warning"), LogLevel.Warn);
  assertEquals(parseLevel("nonsense"), LogLevel.Info);
});

// --- formatters (goldens ported from GoForge formatter/format_test.go) -------

const baseLog: LogFormat = {
  level: "",
  timestamp: "2026-03-13T01:10:23.123",
  traceID: "8f3a5d9c-9f2a-4e1d-b3a7-7f23d9a1e4aa",
  message: "Request processed successfully",
  details: { system: "" },
  process: [],
  method: "ProcessPayment",
  line: 142,
  latency: 155,
};

const goJSONGolden = '{"timestamp":"2026-03-13T01:10:23.123",' +
  '"traceID":"8f3a5d9c-9f2a-4e1d-b3a7-7f23d9a1e4aa","level":"",' +
  '"message":"Request processed successfully","details":{"system":""},' +
  '"method":"ProcessPayment","line":142,"latency":155}';

Deno.test("json format matches the GoForge golden entry", () => {
  const out = newFormatter("json").format(baseLog);
  assertEquals(JSON.parse(out), JSON.parse(goJSONGolden));
  // Byte-level canonical key order (Go marshals LogFormat in struct order).
  assertEquals(Object.keys(JSON.parse(out)), [
    "level",
    "timestamp",
    "traceID",
    "message",
    "details",
    "method",
    "line",
    "latency",
  ]);
  // Trimming and casing behave like Go's dispatch.
  assertEquals(newFormatter("  json  ").format(baseLog), out);
});

Deno.test("json format emits spanID and process only when present, in GoForge order", () => {
  const withSpan: LogFormat = {
    ...baseLog,
    spanID: "00f067aa0ba902b7",
    process: [{ system: "auth", process: "validate", status: "SUCCESS", latency: 3 }],
  };
  assertEquals(Object.keys(JSON.parse(newFormatter("json").format(withSpan))), [
    "level",
    "timestamp",
    "traceID",
    "spanID",
    "message",
    "details",
    "process",
    "method",
    "line",
    "latency",
  ]);
  // An empty spanID is omitted like Go's `omitempty`.
  const noSpan = JSON.parse(newFormatter("json").format({ ...baseLog, spanID: "" }));
  assert(!("spanID" in noSpan));
  // A JSON-shaped custom template is re-normalized and keeps spanID.
  const tpl = newFormatter('{"traceID":{{json .TraceID}},"spanID":{{json .SpanID}}}');
  assertEquals(JSON.parse(tpl.format(withSpan)).spanID, "00f067aa0ba902b7");
  assert(!("spanID" in JSON.parse(tpl.format(baseLog))));
});

Deno.test("text format matches the GoForge golden line", () => {
  const want = "[2026-03-13T01:10:23.123] [] [8f3a5d9c-9f2a-4e1d-b3a7-7f23d9a1e4aa] " +
    "ProcessPayment:142 - Request processed successfully latency=155ms";
  assertEquals(newFormatter("text").format(baseLog), want);
  assertEquals(newFormatter("txt").format(baseLog), want);

  const noLatency = { ...baseLog, latency: 0 };
  const wantNoLatency = "[2026-03-13T01:10:23.123] [] " +
    "[8f3a5d9c-9f2a-4e1d-b3a7-7f23d9a1e4aa] ProcessPayment:142 - " +
    "Request processed successfully";
  // The empty template defaults to the text layout, like GoForge.
  assertEquals(newFormatter("").format(noLatency), wantNoLatency);
});

Deno.test("formatters render latency as integer milliseconds", () => {
  const log: LogFormat = {
    ...baseLog,
    latency: 12.6,
    process: [{ system: "auth", process: "validate", latency: 3.4 }],
  };

  const rec = JSON.parse(newFormatter("json").format(log));
  assertEquals(rec.latency, 13);
  assertEquals(rec.process[0].latency, 3);

  const text = newFormatter("text").format(log);
  assert(text.includes("latency=13ms"));
  assert(text.includes("latency=3ms"));

  assertEquals(
    newFormatter("{{.Latency}}|{{json (buildServices .Process)}}").format(log),
    '13|[{"latency":3,"process":"validate","system":"auth"}]',
  );

  const invalid = JSON.parse(newFormatter("json").format({ ...baseLog, latency: Number.NaN }));
  assertEquals(invalid.latency, 0);
});

Deno.test("text format renders details and services like GoForge", () => {
  const log: LogFormat = {
    level: "DEBUG",
    timestamp: "2026-03-13T01:10:23.123",
    traceID: "trace-text",
    message: "detailed log",
    method: "DetailedMethod",
    line: 99,
    latency: 321,
    details: {
      system: "loan-service",
      client: "mobile-app",
      protocol: "HTTP",
      method: "POST",
      path: "/loan/simulate",
      headers: { "Content-Type": ["application/json"] },
      request: { amount: 100 },
      response: { ok: true },
    },
    process: [
      {
        traceID: "sat-001",
        spanID: "span-001",
        system: "auth-service",
        process: "validate-token",
        server: "auth.internal",
        protocol: "HTTP",
        method: "POST",
        path: "/auth/validate",
        code: 200,
        request: { token: "abc" },
        response: { valid: true },
        status: "SUCCESS",
        latency: 12,
      },
      { system: "score-engine", process: "calculate-score", status: "ERROR" },
    ],
  };
  const out = newFormatter("text").format(log);
  const mustContain = [
    "[2026-03-13T01:10:23.123] [DEBUG] [trace-text] DetailedMethod:99 - detailed log latency=321ms",
    "details={",
    "system=loan-service",
    "client=mobile-app",
    "protocol=HTTP",
    "method=POST",
    "path=/loan/simulate",
    'headers={"Content-Type":["application/json"]}',
    'request={"amount":100}',
    'response={"ok":true}',
    "process=[",
    "traceID=sat-001",
    "spanID=span-001",
    "system=auth-service",
    "process=validate-token",
    "server=auth.internal",
    "code=200",
    'request={"token":"abc"}',
    'response={"valid":true}',
    "status=SUCCESS",
    "latency=12ms",
    "system=score-engine",
    "process=calculate-score",
    "status=ERROR",
  ];
  for (const part of mustContain) {
    assert(out.includes(part), `missing ${JSON.stringify(part)} in ${out}`);
  }
});

Deno.test("custom template renders fields and helpers", () => {
  const out = newFormatter("{{.Message}}|{{.Method}}|{{.Line}}|{{json .}}").format(baseLog);
  assertEquals(
    out,
    `Request processed successfully|ProcessPayment|142|${newFormatter("json").format(baseLog)}`,
  );

  // The GoForge README example, including alphabetically sorted helper keys.
  const entry: LogFormat = {
    ...baseLog,
    level: "info",
    message: "request completed",
    process: [{ system: "orders-api", process: "GetOrders", status: "OK", latency: 12 }],
  };
  assertEquals(
    newFormatter("{{.Level}} | {{.Message}} | {{json (buildServices .Process)}}").format(entry),
    'info | request completed | [{"latency":12,"process":"GetOrders","status":"OK","system":"orders-api"}]',
  );
  // Wrapped in text so the output is not pure JSON (which Go re-normalizes).
  assertEquals(
    newFormatter("d={{json (buildDetails .Details)}}").format({
      ...baseLog,
      details: { system: "api", path: "/x" },
    }),
    'd={"path":"/x","system":"api"}',
  );
  // Leading/trailing whitespace is trimmed, like Go's executeTemplate.
  assertEquals(newFormatter("  {{.Message}}  ").format(baseLog), baseLog.message);
});

Deno.test("custom template cannot rename JSON keys (GoForge quirk)", () => {
  const out = newFormatter('{"ts":{{json .Timestamp}},"lvl":{{json .Level}}}').format(baseLog);
  assertEquals(JSON.parse(out), {
    level: "",
    timestamp: "",
    traceID: "",
    message: "",
    details: { system: "" },
    method: "",
    line: 0,
    latency: 0,
  });
});

Deno.test("invalid templates throw like Go template errors", () => {
  assertThrows(() => newFormatter("{{if}").format(baseLog));
  assertThrows(() => newFormatter("{{range .Date}}{{.}}{{end}}").format(baseLog));
});

Deno.test("formatTimestamp renders Go layouts in local time", () => {
  const d = new Date(2026, 2, 13, 1, 10, 23, 123);
  assertEquals(formatTimestamp(d), "2026-03-13T01:10:23.123");
  assertEquals(formatTimestamp(d, "02/01/2006 15:04:05"), "13/03/2026 01:10:23");
  assertEquals(formatTimestamp(d, "03:04 PM"), "01:10 AM");
  assertEquals(formatTimestamp(new Date(2026, 2, 13, 13, 10), "03:04 pm"), "01:10 pm");
});

// --- sanitizer --------------------------------------------------------------

Deno.test("sanitizer redacts sensitive keys recursively", () => {
  const s = newSanitizer(["password", "authorization"]);
  const out = s.details({
    user: "x",
    password: "secret",
    nested: { Authorization: "Bearer t" },
    list: [{ password: "p" }],
  }) as Record<string, unknown>;
  assertEquals(out.user, "x");
  assertEquals(out.password, "[REDACTED]");
  assertEquals((out.nested as Record<string, unknown>).Authorization, "[REDACTED]");
  assertEquals((out.list as Record<string, unknown>[])[0].password, "[REDACTED]");
});

Deno.test("sanitizer handles headers, JSON strings and log lines", () => {
  const s = new Sanitizer(["token"]);
  assertEquals(s.headers({ token: "abc", "x-id": "1" }), { token: "[REDACTED]", "x-id": "1" });
  assertEquals(s.headers(new Headers({ token: "abc" })).token, "[REDACTED]");
  const json = s.value('{"token":"abc","ok":1}') as string;
  assert(json.includes("[REDACTED]"));
  assert(!s.logFormat("plain line").includes("REDACTED"));
  assert(s.logFormat('{"token":"x"}').includes("REDACTED"));
  assertEquals(s.service("plain"), "plain");
});

Deno.test("sensible keys are read from LOGGER_SENSIBLEKEYS as CSV or JSON", () => {
  withSensibleKeysEnv(" password, authorization, password ", () => {
    assertEquals(sensibleKeysFromEnv(), ["password", "authorization"]);
    assertEquals(newSanitizer().details({ password: "secret", visible: "yes" }), {
      password: "[REDACTED]",
      visible: "yes",
    });
  });

  withSensibleKeysEnv('["token", "api_key"]', () => {
    assertEquals(sensibleKeysFromEnv(), ["token", "api_key"]);
  });
});

Deno.test("absent env means no redaction and explicit keys use exactly their list", () => {
  withSensibleKeysEnv(undefined, () => {
    assertEquals(newSanitizer().details({ password: "secret" }), { password: "secret" });
  });

  const explicit = newSanitizer(["id"]);
  assertEquals(explicit.details({ id: "secret", provider: "visible" }), {
    id: "[REDACTED]",
    provider: "[REDACTED]",
  });
});

Deno.test({
  name: "reading the environment requires Deno env permission",
  permissions: { env: false },
  fn: () => {
    assertThrows(() => sensibleKeysFromEnv(), Deno.errors.NotCapable);
    assertEquals(newSanitizer([]).details({ password: "visible" }), { password: "visible" });
  },
});

Deno.test("environment policy redacts only configured key fragments", () => {
  const input = {
    id_kek: "kek-1",
    version_id: "v1",
    client_id: "client-1",
    provider: "local",
    key_id: "key-1",
    authorization: "Bearer secret",
    password: "secret",
  };
  withSensibleKeysEnv("authorization,password", () => {
    assertEquals(newSanitizer().details(input), {
      ...input,
      authorization: "[REDACTED]",
      password: "[REDACTED]",
    });
  });
});

// --- builder ----------------------------------------------------------------

Deno.test("logger defaults to the GoForge text layout", () => {
  const lines: string[] = [];
  const log = initLogger({ service: { name: "svc" }, sink: (l) => lines.push(l) });
  log.info("hola");
  assertEquals(lines.length, 1);
  assert(/^\[.+\] \[INFO\] \[\] .+:\d+ - hola \| details=\{system=svc\}$/.test(lines[0]), lines[0]);
  assert(lines[0].includes("logger_test.ts:"), `caller missing in ${lines[0]}`);
});

Deno.test("logger reads its sanitization policy from the environment", () => {
  withSensibleKeysEnv("password", () => {
    const lines: string[] = [];
    const log = initLogger({ formatter: "json", sink: (line) => lines.push(line) });
    log.info("login", { password: "secret", client_id: "visible" });

    const record = JSON.parse(lines[0]);
    assertEquals(record.details.password, "[REDACTED]");
    assertEquals(record.details.client_id, "visible");
  });
});

Deno.test("an explicit sanitizer replaces the environment policy", () => {
  withSensibleKeysEnv("password", () => {
    const lines: string[] = [];
    const log = initLogger({
      formatter: "json",
      sanitizer: newSanitizer(["account_pin"]),
      sink: (line) => lines.push(line),
    });
    log.info("login", { password: "visible", account_pin: "1234" });

    const record = JSON.parse(lines[0]);
    assertEquals(record.details.password, "visible");
    assertEquals(record.details.account_pin, "[REDACTED]");
  });
});

Deno.test("logger skips logging.ts wrappers when resolving the caller", () => {
  const lines: string[] = [];
  const log = initLogger({ formatter: "json", sink: (l) => lines.push(l) });

  callWrappedLogger(log);

  const rec = JSON.parse(lines[0]);
  assertEquals(rec.method, "callWrappedLogger");
  assert(rec.line > 0);
});

function callWrappedLogger(log: Logger): void {
  writeWrappedLog(log);
}

Deno.test("logger filters by level and emits to a custom sink", () => {
  const lines: string[] = [];
  const log = initLogger({ level: LogLevel.Warn, sink: (l) => lines.push(l) });
  log.debug("d");
  log.info("i");
  log.warn("w");
  log.error("e");
  assertEquals(lines.length, 2);
  assert(lines[0].includes("[WARN]"));
  assert(lines[0].includes(" - w"));
});

Deno.test("json formatter emits the GoForge entry schema", () => {
  const lines: string[] = [];
  const log = initLogger({
    formatter: "json",
    service: { name: "svc", version: "1.0" },
    sink: (l) => lines.push(l),
  });
  log.info("evt", {
    method: "GET",
    path: "/api/users",
    traceID: "trace-1",
    latency: 12,
    userId: 42,
  });
  const rec = JSON.parse(lines[0]);
  assertEquals(Object.keys(rec), [
    "level",
    "timestamp",
    "traceID",
    "message",
    "details",
    "method",
    "line",
    "latency",
  ]);
  assertEquals(rec.level, "INFO");
  assertEquals(rec.message, "evt");
  assertEquals(rec.traceID, "trace-1");
  assertEquals(rec.latency, 12);
  assertEquals(rec.details.system, "svc");
  assertEquals(rec.details.method, "GET");
  assertEquals(rec.details.path, "/api/users");
  assertEquals(rec.details.userId, 42); // unrecognized attrs merge into details
  assert(!("process" in rec)); // an empty process is omitted, like Go's `omitempty`
  assert(rec.method.length > 0);
  assert(rec.line > 0);
  assert(!("version" in rec.details)); // app version is not part of log lines
});

Deno.test("logger normalizes latency attrs to integer milliseconds", () => {
  const lines: string[] = [];
  const log = initLogger({ formatter: "json", sink: (l) => lines.push(l) });
  log.info("done", {
    latency: 12.6,
    services: [{ system: "auth", process: "validate", status: "SUCCESS", latency: 3.4 }],
  });
  const rec = JSON.parse(lines[0]);
  assertEquals(rec.latency, 13);
  assertEquals(rec.process[0].latency, 3);
  assert(Number.isInteger(rec.latency));
  assert(Number.isInteger(rec.process[0].latency));
});

Deno.test("services attr populates the process array", () => {
  const lines: string[] = [];
  const log = initLogger({ formatter: "json", sink: (l) => lines.push(l) });
  log.info("done", {
    services: [{ system: "auth", process: "validate", status: "SUCCESS", latency: 3 }],
  });
  const rec = JSON.parse(lines[0]);
  assertEquals(rec.process, [
    { system: "auth", process: "validate", status: "SUCCESS", latency: 3 },
  ]);
});

Deno.test("logger.with adds permanent attributes and preserves its sanitizer", () => {
  const lines: string[] = [];
  const log = initLogger({
    formatter: "json",
    sink: (l) => lines.push(l),
    sanitizer: newSanitizer(["password"]),
    service: { name: "svc" },
  }).with({ requestId: "r1" });
  log.info("evt", { password: "p", ok: true });
  const rec = JSON.parse(lines[0]);
  assertEquals(rec.details.system, "svc");
  assertEquals(rec.details.requestId, "r1");
  assertEquals(rec.details.password, "[REDACTED]");
  assertEquals(rec.details.ok, true);
});

Deno.test("logger ignoredHeaders filters header names case-insensitively", () => {
  const lines: string[] = [];
  const log = initLogger({
    formatter: "json",
    ignoredHeaders: ["Authorization", "Cookie"],
    sink: (l) => lines.push(l),
  });

  log.info("http", {
    headers: new Headers({
      Authorization: "Bearer token",
      Cookie: "session",
      "x-request-id": "rid",
    }),
  });

  const rec = JSON.parse(lines[0]);
  assertEquals(rec.details.headers, { "x-request-id": "rid" });
});

Deno.test("test mode suppresses all output", () => {
  const lines: string[] = [];
  const log = initLogger({ sink: (l) => lines.push(l) });
  enableModeTest();
  log.error("hidden");
  assert(!log.enabled(LogLevel.Error));
  disableModeTest();
  log.error("shown");
  assertEquals(lines.length, 1);
});

// --- middlewares ------------------------------------------------------------

Deno.test("httpLogger logs success and rethrows on error", async () => {
  const lines: string[] = [];
  const log = initLogger({ formatter: "json", sink: (l) => lines.push(l) });
  const ok = httpLogger(log)(() => new Response("ok", { status: 201 }));
  const res = await ok(new Request("http://x/api", { headers: { "x-trace-id": "rid" } }));
  assertEquals(res.status, 201);
  const rec = JSON.parse(lines[0]);
  assertEquals(rec.message, "http.request");
  assertEquals(rec.traceID, "rid");
  assertEquals(rec.details.method, "GET");
  assertEquals(rec.details.path, "/api");
  assertEquals(rec.details.status, 201);
  assertEquals(rec.details.headers["x-trace-id"], "rid");
  assertEquals(typeof rec.latency, "number");

  const boom = httpLogger(log)(() => {
    throw new Error("fail");
  });
  let threw = false;
  try {
    await boom(new Request("http://x/api"));
  } catch {
    threw = true;
  }
  assert(threw);
  const err = JSON.parse(lines[1]);
  assertEquals(err.message, "http.request.error");
  assertEquals(err.level, "ERROR");
  assertEquals(err.details.error, "fail");
});

Deno.test("grpcLogger logs unary success and error", async () => {
  const lines: string[] = [];
  const log = initLogger({ formatter: "json", sink: (l) => lines.push(l) });
  // deno-lint-ignore no-explicit-any
  const ctx = { method: "/svc/M", metadata: {}, call: {}, state: {} } as any;

  await grpcLogger(log)(ctx, () => Promise.resolve("r"));
  const rec = JSON.parse(lines[0]);
  assertEquals(rec.message, "grpc.request");
  assertEquals(rec.details.method, "/svc/M");
  assertEquals(rec.details.status, "OK");

  let threw = false;
  try {
    await grpcLogger(log)(ctx, () => Promise.reject(new Error("x")));
  } catch {
    threw = true;
  }
  assert(threw);
  const err = JSON.parse(lines[1]);
  assertEquals(err.message, "grpc.request.error");
  assertEquals(err.details.error, "x");
});

function withSensibleKeysEnv<T>(value: string | undefined, run: () => T): T {
  const previous = Deno.env.get("LOGGER_SENSIBLEKEYS");
  if (value === undefined) Deno.env.delete("LOGGER_SENSIBLEKEYS");
  else Deno.env.set("LOGGER_SENSIBLEKEYS", value);
  try {
    return run();
  } finally {
    if (previous === undefined) Deno.env.delete("LOGGER_SENSIBLEKEYS");
    else Deno.env.set("LOGGER_SENSIBLEKEYS", previous);
  }
}
