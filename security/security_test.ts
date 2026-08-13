// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { createService, JWTError } from "./auth/jwt/jwt.ts";
import { CookieService, newCookieService } from "./auth/cookies/cookies.ts";
import {
  getClaims,
  getRequestContext,
  setClaims,
  setRequestContext,
  unauthorized,
} from "./middlewares/context.ts";
import { securityHeaders } from "./middlewares/headers.ts";
import { jwtMiddleware } from "./middlewares/jwt.ts";
import { cookieMiddleware } from "./middlewares/cookies.ts";
import { grpcClaims, grpcJwtInterceptor } from "./middlewares/grpc_jwt.ts";
import { newLocalProvider, SizeAsymmetricKey } from "../encrypt/mod.ts";

const enc = newLocalProvider();
const hs = createService({ algorithm: "HS256", hmacSecret: "secret" });

// --- jwt --------------------------------------------------------------------

Deno.test("HS256 sign/verify round-trip", async () => {
  const token = await hs.sign({ sub: "u1", role: "admin" });
  const verified = await hs.verify(token);
  assertEquals(verified.claims.sub, "u1");
  assertEquals(hs.algorithm(), "HS256");
});

Deno.test("verify rejects tampered, malformed and wrong-alg tokens", async () => {
  const token = await hs.sign({ sub: "u1" });
  await assertRejects(
    () => createService({ algorithm: "HS256", hmacSecret: "other" }).verify(token),
    JWTError,
  );
  await assertRejects(() => hs.verify("not.a.jwt.token"), JWTError);
  await assertRejects(() => hs.verify("only.two"), JWTError);
});

Deno.test("validators run after signature verification", async () => {
  const guarded = createService({
    algorithm: "HS256",
    hmacSecret: "secret",
    validators: [(c) => {
      if (c.role === "blocked") throw new Error("blocked");
    }],
  });
  const blockedToken = await guarded.sign({ role: "blocked" });
  await assertRejects(() => guarded.verify(blockedToken));
  const ok = await guarded.verify(await guarded.sign({ role: "admin" }));
  assertEquals(ok.claims.role, "admin");
});

Deno.test("RS256 and EdDSA work with generated keys", async () => {
  const rsa = await enc.generateRSAKeys({ size: SizeAsymmetricKey.Key2048Bits });
  const rs = createService({
    algorithm: "RS256",
    rsaPrivateKey: rsa.keyRef,
    rsaPublicKey: rsa.publicKey,
  });
  assertEquals((await rs.verify(await rs.sign({ sub: "r" }))).claims.sub, "r");

  const ed = await enc.generateEd25519Keys();
  const es = createService({
    algorithm: "EdDSA",
    eddsaPrivateKey: ed.keyRef,
    eddsaPublicKey: ed.publicKey,
  });
  assertEquals((await es.verify(await es.sign({ sub: "e" }))).claims.sub, "e");
});

Deno.test("custom strategy is supported and config is validated", async () => {
  const custom = createService({
    algorithm: "CUSTOM",
    sign: (input) => input.slice(0, 4),
    verify: () => true,
  });
  const token = await custom.sign({ sub: "c" });
  assertEquals((await custom.verify(token)).claims.sub, "c");

  let threw = false;
  try {
    createService({ algorithm: "HS256" });
  } catch {
    threw = true;
  }
  assert(threw);
});

// --- cookies ----------------------------------------------------------------

Deno.test("cookie service extracts and validates tokens", async () => {
  const svc = newCookieService({ jwtService: hs, cookieName: "session" });
  const token = await hs.sign({ sub: "cookie-user" });
  const req = new Request("http://x/", { headers: { cookie: `session=${token}` } });
  assertEquals(svc.cookieName(), "session");
  assertEquals(svc.tokenFromRequest(req), token);
  await svc.validateRequest(req);
  assertEquals((await svc.read<{ sub: string }>(req)).sub, "cookie-user");
  assertEquals((await svc.decode(req)).claims.sub, "cookie-user");
});

Deno.test("cookie service errors on missing cookie or jwt service", () => {
  const svc = new CookieService({ jwtService: hs });
  assertEquals(svc.cookieName(), "access_token");
  let missing = false;
  try {
    svc.tokenFromRequest(new Request("http://x/"));
  } catch {
    missing = true;
  }
  assert(missing);
  let noJwt = false;
  try {
    // deno-lint-ignore no-explicit-any
    new CookieService({ jwtService: undefined as any });
  } catch {
    noJwt = true;
  }
  assert(noJwt);
});

// --- middleware context/headers --------------------------------------------

Deno.test("claims store and unauthorized helper", () => {
  const req = new Request("http://x/");
  assertEquals(getClaims(req), undefined);
  setClaims(req, { sub: "z" });
  assertEquals(getClaims<{ sub: string }>(req)?.sub, "z");
  assertEquals(unauthorized("nope").status, 401);
  assertEquals(unauthorized("nope", 403).status, 403);
});

Deno.test("generic request context is isolated by request and independent from claims", () => {
  const first = new Request("http://x/first");
  const second = new Request("http://x/second");
  const context = { tenant: "a" };

  setRequestContext(first, context);
  setClaims(first, { sub: "user-1" });
  setRequestContext(second, { tenant: "b" });

  assertStrictEquals(getRequestContext(first), context);
  assertEquals(getRequestContext<{ tenant: string }>(second)?.tenant, "b");
  assertEquals(getClaims<{ sub: string }>(first)?.sub, "user-1");
  assertEquals(getClaims(second), undefined);
});

Deno.test("securityHeaders sets and overrides headers", async () => {
  const mw = securityHeaders({ headers: { "X-Frame-Options": "SAMEORIGIN" } });
  const res = await mw(() => new Response("ok"))(new Request("http://x/"));
  assertEquals(res.headers.get("x-content-type-options"), "nosniff");
  assertEquals(res.headers.get("x-frame-options"), "SAMEORIGIN");
  assertEquals(await res.text(), "ok");
});

// --- jwt / cookie middleware ------------------------------------------------

Deno.test("jwtMiddleware enforces a valid bearer token", async () => {
  const token = await hs.sign({ sub: "mw" });
  const handler = jwtMiddleware(hs)((req) => Response.json({ sub: getClaims(req)?.sub }));

  const okRes = await handler(
    new Request("http://x/", { headers: { authorization: `Bearer ${token}` } }),
  );
  assertEquals((await okRes.json()).sub, "mw");

  assertEquals((await handler(new Request("http://x/"))).status, 401);
  assertEquals(
    (await handler(new Request("http://x/", { headers: { authorization: "Basic xyz" } }))).status,
    401,
  );
  assertEquals(
    (await handler(new Request("http://x/", { headers: { authorization: "Bearer bad" } }))).status,
    401,
  );
});

Deno.test("cookieMiddleware enforces a valid cookie", async () => {
  const svc = newCookieService({ jwtService: hs });
  const token = await hs.sign({ sub: "ck" });
  const handler = cookieMiddleware(svc)((req) => Response.json({ sub: getClaims(req)?.sub }));

  const okRes = await handler(
    new Request("http://x/", { headers: { cookie: `access_token=${token}` } }),
  );
  assertEquals((await okRes.json()).sub, "ck");
  assertEquals((await handler(new Request("http://x/"))).status, 401);
});

// --- grpc jwt interceptor ---------------------------------------------------

Deno.test("grpcJwtInterceptor authenticates via metadata", async () => {
  const token = await hs.sign({ sub: "grpc" });
  const interceptor = grpcJwtInterceptor(hs);

  const make = (auth?: string) => ({
    method: "/svc/M",
    metadata: { get: (_k: string) => (auth ? [auth] : []) },
    call: {},
    state: {} as Record<string, unknown>,
    // deno-lint-ignore no-explicit-any
  } as any);

  const ctx = make(`Bearer ${token}`);
  await interceptor(ctx, () => Promise.resolve("ok"));
  assertEquals(grpcClaims<{ sub: string }>(ctx)?.sub, "grpc");

  await assertRejects(() => interceptor(make(), () => Promise.resolve("ok")));
  await assertRejects(() => interceptor(make("Basic x"), () => Promise.resolve("ok")));
  await assertRejects(() => interceptor(make("Bearer bad"), () => Promise.resolve("ok")));
});
