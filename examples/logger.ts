// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Logger example. Run with:
 * `LOGGER_SENSIBLEKEYS=password,authorization,token deno run
 * --allow-env=LOGGER_SENSIBLEKEYS --allow-write examples/logger.ts`
 */

import { initLogger, LogLevel } from "../logger/mod.ts";

// Default output is the GoForge text layout:
// [timestamp] [LEVEL] [traceID] method:line - message | details={...}
const log = initLogger({
  level: LogLevel.Debug,
  service: { name: "example-api", version: "1.0.0" },
});

log.debug("starting up", { port: 8080 });
log.info("user.login", {
  userId: 42,
  password: "hunter2", // redacted by LOGGER_SENSIBLEKEYS
  headers: { authorization: "Bearer abc.def.ghi" }, // nested redaction
});

const requestLog = log.with({ requestId: "req-123" });
requestLog.warn("slow.query", { latency: 1340 });
requestLog.error("db.error", { code: "ECONN" });

// File output is optional and requires --allow-write. With rotate.enable the
// logger tees each line to stdout and ./logs/example-api.log. Set fileName to
// override the service-based name.
const fileLog = initLogger({
  formatter: "json",
  dir: "./logs",
  rotate: {
    enable: true,
    maxSize: 10,
    maxBackups: 5,
    maxAge: 30,
    compress: true,
  },
  service: { name: "example-api" },
});
fileLog.info("file.logging.enabled");

// `formatter: "json"` emits the GoForge JSON schema.
const jsonLog = initLogger({ formatter: "json", service: { name: "example-api" } });
jsonLog.info("request completed", { method: "GET", path: "/api/v1/orders", latency: 12 });

// Any other string is a custom template over the entry fields.
const tplLog = initLogger({
  formatter: "{{.Level}} | {{.Message}} | {{json (buildServices .Process)}}",
  service: { name: "example-api" },
});
tplLog.info("request completed", {
  services: [{ system: "orders-api", process: "GetOrders", status: "OK", latency: 12 }],
});
