// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * gRPC example: a server with logging + JWT interceptors and a client call.
 * Run with: `deno run -A examples/grpc.ts`
 */

import { GrpcClient, GrpcServer, loadProto } from "../config/mod.ts";
import { grpcLogger, initLogger } from "../logger/mod.ts";
import { createService, grpcClaims, grpcJwtInterceptor } from "../security/mod.ts";
// deno-lint-ignore no-explicit-any
type Any = any;

const log = initLogger({ service: { name: "grpc-example" } });
const jwt = createService({ algorithm: "HS256", hmacSecret: "super-secret-key" });

const proto = loadProto(new URL("../config/proto/methods.proto", import.meta.url));
const Methods = (proto.denoforge as Any).v1.Methods;

// Server: logging on every RPC, JWT required on every RPC.
const server = new GrpcServer({ interceptors: [grpcLogger(log), grpcJwtInterceptor(jwt)] });
server.addService(Methods.service, {
  Echo: (req: Any, ctx) => ({ message: `${(grpcClaims(ctx) as Any)?.sub}: ${req.message}` }),
  Health: () => ({ status: "ok" }),
});

const port = await server.listen("127.0.0.1:0");
console.log("gRPC server listening on", port);

// Client.
const client = new GrpcClient(Methods, `127.0.0.1:${port}`);
const token = await jwt.sign({ sub: "user-1" });

const echo = await client.unary<{ message: string }, { message: string }>(
  "Echo",
  { message: "hello grpc" },
  { bearer: token },
);
console.log("Echo response:", echo.message);

// Without a token the call is rejected.
try {
  await client.unary("Health", {}, {});
} catch (err) {
  console.log("unauthenticated rejected:", (err as Error).message);
}

client.close();
await server.shutdown();
