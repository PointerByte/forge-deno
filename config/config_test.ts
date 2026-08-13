// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertRejects } from "@std/assert";
import { newClientHTTP } from "./client/http/client.ts";
import { HttpServer, newHttpServer } from "./server/http/server.ts";
import { loadProto } from "./proto/loader.ts";
import { GrpcError, status, unary } from "./server/grpc/interceptors.ts";
import { GrpcClient } from "./client/grpc/client.ts";
import { GrpcServer } from "./server/grpc/server.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

// --- HTTP server routing (no network) --------------------------------------

Deno.test("http server routes, groups, health and 404", async () => {
  const server = new HttpServer({ middleware: [] });
  server.get("/ping", () => Response.json({ pong: true }));
  server.group("/api", (next) => (req) => next(req))
    .get("/users/:id", (req) => Response.json({ url: req.url }));
  const handler = server.handler();

  assertEquals((await (await handler(new Request("http://x/health"))).json()).status, "ok");
  assertEquals((await (await handler(new Request("http://x/ping"))).json()).pong, true);
  assert((await handler(new Request("http://x/api/users/7"))).ok);
  assertEquals((await handler(new Request("http://x/missing"))).status, 404);
});

Deno.test("http server middleware runs outermost-first", async () => {
  const order: string[] = [];
  const server = newHttpServer()
    .use((next) => (req) => {
      order.push("a");
      return next(req);
    })
    .use((next) => (req) => {
      order.push("b");
      return next(req);
    });
  server.get("/x", () => {
    order.push("handler");
    return new Response("ok");
  });
  await server.handler()(new Request("http://x/x"));
  assertEquals(order, ["a", "b", "handler"]);
});

Deno.test("health response remains compatible, is customizable, and can be disabled", async () => {
  const defaultServer = newHttpServer();
  const defaultResponse = await defaultServer.handler()(new Request("http://x/health"));
  assertEquals(defaultResponse.status, 200);
  assertEquals(defaultResponse.headers.get("content-type"), "application/json");
  assertEquals(await defaultResponse.text(), '{"status":"ok"}');

  let calls = 0;
  const customServer = newHttpServer({
    healthPath: "/ready",
    healthHandler: () => {
      calls++;
      return Response.json({ status: "ok", service: "container" }, {
        headers: { "cache-control": "no-store" },
      });
    },
  });
  const customResponse = await customServer.handler()(new Request("http://x/ready"));
  assertEquals(await customResponse.json(), { status: "ok", service: "container" });
  assertEquals(customResponse.headers.get("cache-control"), "no-store");
  assertEquals(calls, 1);
  assertEquals((await customServer.handler()(new Request("http://x/health"))).status, 404);

  const disabledServer = newHttpServer({ healthPath: "" });
  assertEquals((await disabledServer.handler()(new Request("http://x/health"))).status, 404);
});

// --- HTTP client/server integration ----------------------------------------

Deno.test("http client performs all verbs against a live server", async () => {
  const server = newHttpServer({ port: 0, hostname: "127.0.0.1", healthPath: "" });
  server.get("/echo", (req) => Response.json({ q: new URL(req.url).searchParams.get("q") }));
  server.post("/data", async (req) => Response.json({ got: await req.json() }));
  server.put("/data", () => new Response("put-ok"));
  server.patch("/data", () => new Response("patch-ok"));
  server.delete("/data", () => new Response(null, { status: 204 }));
  const srv = server.listen() as Any;
  const port = srv.addr.port;

  try {
    const client = newClientHTTP({
      baseUrl: `http://127.0.0.1:${port}`,
      headers: { "x-app": "t" },
    });

    const echo = await client.get<{ q: string }>("/echo", { query: { q: "hi" } });
    assertEquals(echo.status, 200);
    assertEquals(echo.data.q, "hi");

    const posted = await client.post<{ got: { a: number } }>("/data", { a: 1 });
    assertEquals(posted.data.got.a, 1);

    assertEquals((await client.put("/data", {})).data, "put-ok");
    assertEquals((await client.patch("/data", {})).data, "patch-ok");
    const del = await client.delete("/data");
    assertEquals(del.status, 204);
  } finally {
    await server.shutdown();
  }
});

Deno.test("http client times out and reports connection errors", async () => {
  const server = newHttpServer({ port: 0, hostname: "127.0.0.1", healthPath: "" });
  server.get("/slow", async () => {
    await new Promise((r) => setTimeout(r, 200));
    return new Response("late");
  });
  const srv = server.listen() as Any;
  const port = srv.addr.port;

  try {
    const client = newClientHTTP({ baseUrl: `http://127.0.0.1:${port}` });
    await assertRejects(() => client.get("/slow", { timeoutMs: 30 }));
  } finally {
    await server.shutdown();
  }

  const dead = newClientHTTP({ baseUrl: "http://127.0.0.1:0" });
  await assertRejects(() => dead.get("/x"));
});

// --- proto loader -----------------------------------------------------------

Deno.test("loadProto loads the bundled methods proto", () => {
  const proto = loadProto(new URL("./proto/methods.proto", import.meta.url));
  const Methods = (proto.denoforge as Any).v1.Methods;
  assert(typeof Methods === "function");
  assert(Methods.service);
});

Deno.test("loadProto rejects non-file URLs", () => {
  let threw = false;
  try {
    loadProto(new URL("http://example.com/x.proto"));
  } catch {
    threw = true;
  }
  assert(threw);
});

// --- grpc interceptors (no network) ----------------------------------------

Deno.test("unary composes interceptors and maps errors to status codes", async () => {
  const seen: string[] = [];
  const log = (_ctx: Any, next: () => Promise<unknown>) => {
    seen.push("before");
    return next();
  };

  const okHandler = unary<{ v: number }, { v: number }>((req) => ({ v: req.v + 1 }), log);
  const okResult = await new Promise((resolve) => {
    okHandler(
      { request: { v: 1 }, metadata: {}, getPath: () => "/svc/M" } as Any,
      (err: Any, value: Any) => resolve(err ?? value),
    );
  });
  assertEquals((okResult as { v: number }).v, 2);
  assertEquals(seen, ["before"]);

  const failHandler = unary(() => {
    throw new GrpcError(status.PERMISSION_DENIED, "no");
  });
  const failErr = await new Promise<Any>((resolve) => {
    failHandler(
      { request: {}, metadata: {}, getPath: () => "/svc/M" } as Any,
      (err: Any) => resolve(err),
    );
  });
  assertEquals(failErr.code, status.PERMISSION_DENIED);

  const internalHandler = unary(() => {
    throw new Error("boom");
  });
  const internalErr = await new Promise<Any>((resolve) => {
    internalHandler(
      { request: {}, metadata: {}, getPath: () => "/svc/M" } as Any,
      (err: Any) => resolve(err),
    );
  });
  assertEquals(internalErr.code, status.INTERNAL);
});

// --- grpc integration -------------------------------------------------------

Deno.test("grpc server/client round-trip with the Methods service", async () => {
  const proto = loadProto(new URL("./proto/methods.proto", import.meta.url));
  const Methods = (proto.denoforge as Any).v1.Methods;

  const server = new GrpcServer();
  server.addService(Methods.service, {
    Echo: (req: Any) => ({ message: req.message }),
    Health: () => ({ status: "ok" }),
  });
  const port = await server.listen("127.0.0.1:0");

  const client = new GrpcClient(Methods, `127.0.0.1:${port}`);
  try {
    const res = await client.unary<{ message: string }, { message: string }>(
      "Echo",
      { message: "round" },
      { metadata: { "x-trace": "1" }, deadlineMs: 5000, bearer: "tok" },
    );
    assertEquals(res.message, "round");
    assert(client.raw() !== undefined);

    await assertRejects(() => client.unary("DoesNotExist", {}));
  } finally {
    client.close();
    await server.shutdown();
  }
});

Deno.test("grpc server exposes raw handle and force shutdown", async () => {
  const proto = loadProto(new URL("./proto/methods.proto", import.meta.url));
  const Methods = (proto.denoforge as Any).v1.Methods;
  const server = new GrpcServer();
  server.addService(Methods.service, { Echo: (r: Any) => r, Health: () => ({ status: "ok" }) });
  const port = await server.listen("127.0.0.1:0");
  assert(port > 0);
  assert(server.raw() !== undefined);
  server.forceShutdown();
});
