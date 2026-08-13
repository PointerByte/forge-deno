// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP server example wiring together config + logger + security.
 * Run with: `deno run --allow-net examples/server.ts`
 *
 * Then try:
 *   curl localhost:8080/health
 *   TOKEN=$(...)  # see examples/jwt.ts
 *   curl -H "Authorization: Bearer $TOKEN" localhost:8080/api/me
 */

import { newHttpServer } from "../config/mod.ts";
import { httpLogger, initLogger } from "../logger/mod.ts";
import { createService, getClaims, jwtMiddleware, securityHeaders } from "../security/mod.ts";

const log = initLogger({ service: { name: "example-api" } });
const jwt = createService({ algorithm: "HS256", hmacSecret: "super-secret-key" });

const server = newHttpServer({
  port: 8080,
  healthHandler: () =>
    Response.json(
      { status: "ok", service: "example-api" },
      { headers: { "cache-control": "no-store" } },
    ),
})
  .use(httpLogger(log, {
    includeHeaders: false,
    skipPaths: ["/health", "/api/status/v1", /(?:^|\/)api\/cmk\/status\/?$/],
  })) // structured request logging
  .use(securityHeaders()); // security headers on every response

// Public route.
server.get("/api/hello", () => Response.json({ message: "hello world" }));

// Protected group: every route requires a valid bearer JWT.
server.group("/api", jwtMiddleware(jwt))
  .get("/me", (req) => Response.json({ claims: getClaims(req) }));

console.log("listening on http://localhost:8080 (health at /health)");
console.log("sample token:", await jwt.sign({ sub: "user-1", role: "admin" }));
server.listen();
