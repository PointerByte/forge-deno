// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Direct HTTP logging from handlers, with request context.
 * Run with: `deno run --allow-net examples/direct_http_logging.ts`
 */

import { httpContext, type HttpRequestContext, newHttpServer } from "../config/mod.ts";
import { buildHttpLogEntry, initLogger } from "../logger/mod.ts";
import { getRequestContext } from "../security/mod.ts";

const logger = initLogger({
  formatter: "json",
  service: { name: "example-api" },
});
const logOptions = {
  requestIdHeader: "x-request-id",
  includeHeaders: false,
  skipPaths: [
    "/health",
    "/api/status/v1",
    /(?:^|\/)api\/cmk\/status\/?$/,
  ],
} as const;

const server = newHttpServer({ port: 8080 })
  .use(httpContext({ requestIdHeader: "x-request-id" }));

server.get("/api/dashboard", (request) => {
  const context = getRequestContext<HttpRequestContext>(request)!;
  context.attributes.microfrontend = "dashboard";
  context.attributes.targetKind = "backend";

  const response = Response.json({ ok: true });
  const entry = buildHttpLogEntry(request, { response }, logOptions);
  if (entry?.level === "error") logger.error(entry.message, entry.details);
  else if (entry) logger.info(entry.message, entry.details);
  return response;
});

console.log("listening on http://localhost:8080");
server.listen();
