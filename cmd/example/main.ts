// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `cmd/example` — a runnable demonstration that boots an HTTP and a gRPC server
 * wired with DenoForge logging and JWT security, with graceful shutdown.
 *
 * Run with: `deno run -A cmd/example/main.ts`
 *
 * @module
 */

import { GrpcServer, loadProto, newHttpServer } from "../../config/mod.ts";
import { grpcLogger, httpLogger, initLogger } from "../../logger/mod.ts";
import {
  createService,
  getClaims,
  grpcClaims,
  grpcJwtInterceptor,
  jwtMiddleware,
  securityHeaders,
} from "../../security/mod.ts";

const log = initLogger({ service: { name: "denoforge-example" } });
const jwt = createService({ algorithm: "HS256", hmacSecret: "super-secret-key" });

// --- HTTP server ---
const http = newHttpServer({ port: 8080 })
  .use(httpLogger(log))
  .use(securityHeaders());
http.get("/api/hello", () => Response.json({ message: "hello from DenoForge" }));
http.group("/api", jwtMiddleware(jwt)).get(
  "/me",
  (req) => Response.json({ claims: getClaims(req) }),
);

// --- gRPC server ---
const proto = loadProto(new URL("../../config/proto/methods.proto", import.meta.url));
// deno-lint-ignore no-explicit-any
const Methods = (proto.denoforge as any).v1.Methods;
const grpc = new GrpcServer({ interceptors: [grpcLogger(log), grpcJwtInterceptor(jwt)] });
grpc.addService(Methods.service, {
  // deno-lint-ignore no-explicit-any
  Echo: (req: any, ctx) => ({ message: `${(grpcClaims(ctx) as any)?.sub}: ${req.message}` }),
  Health: () => ({ status: "ok" }),
});

const token = await jwt.sign({ sub: "demo-user", role: "admin" });
const grpcPort = await grpc.listen("127.0.0.1:50051");
http.listen();

log.info("example.ready", { http: 8080, grpc: grpcPort });
console.log("\nHTTP  : http://localhost:8080/health");
console.log("gRPC  : 127.0.0.1:" + grpcPort + " (denoforge.v1.Methods)");
console.log("token :", token);
console.log("\nPress Ctrl+C to stop.");

Deno.addSignalListener("SIGINT", async () => {
  log.info("example.shutdown", {});
  await Promise.all([http.shutdown(), grpc.shutdown()]);
  Deno.exit(0);
});
