// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertThrows } from "@std/assert";
import { parseIni } from "./ini.ts";

Deno.test("section headers and dotted keys build the same key path", () => {
  const settings = parseIni([
    "; leading comment",
    "# another comment",
    "standalone = root",
    "",
    "[app]",
    "name = dragon-cmk",
    "",
    "[server.gin]",
    "port = :8080",
    "",
    "[server]",
    "grpc.port = :50051",
    "",
    "[]",
    "back.to.root = yes",
  ].join("\n"));

  assertEquals(settings, {
    standalone: "root",
    app: { name: "dragon-cmk" },
    server: { gin: { port: ":8080" }, grpc: { port: ":50051" } },
    back: { to: { root: "yes" } },
  });
});

Deno.test("keys are lower-cased so lookups stay case-insensitive", () => {
  const settings = parseIni("[Traces]\nSkipPaths = [/health]\n");
  assertEquals(settings, { traces: { skippaths: ["/health"] } });
});

Deno.test("values with no declared type are inferred", () => {
  const settings = parseIni([
    "[server]",
    "port = :8080",
    "enabled = true",
    "disabled = FALSE",
    "limit = 1000",
    "ratio = 0.75",
    "version = 0.0.1",
    `name = "  spaced  "`,
    "quotedNumber = '42'",
    "commented = release ; trailing comment",
    "hashInValue = abc#123",
    "groups = [/api/v1, /api/v2]",
    "single = [/health]",
    "empty = []",
  ].join("\n"));

  assertEquals(settings.server, {
    port: ":8080",
    enabled: true,
    disabled: false,
    limit: 1000,
    ratio: 0.75,
    version: "0.0.1",
    name: "  spaced  ",
    quotednumber: "42",
    commented: "release",
    hashinvalue: "abc#123",
    groups: ["/api/v1", "/api/v2"],
    single: ["/health"],
    empty: [],
  });
});

Deno.test("a declared type survives the overlay", () => {
  const declared = (key: string): unknown => {
    switch (key) {
      case "server.gin.groups":
        return ["/api/v1"];
      case "server.gin.rate.limit":
        return 1000;
      case "jwt.enable":
        return false;
      case "app.version":
        return "0.0.1";
      default:
        return undefined;
    }
  };

  const settings = parseIni(
    [
      "[server.gin]",
      "groups = /v2, /v3",
      "rate.limit = 2500",
      "",
      "[jwt]",
      "enable = true",
      "",
      "[app]",
      "version = 1.0",
    ].join("\n"),
    { declared },
  );

  assertEquals(settings, {
    server: { gin: { groups: ["/v2", "/v3"], rate: { limit: 2500 } } },
    jwt: { enable: true },
    // A declared string stays a string even when the value looks numeric.
    app: { version: "1.0" },
  });
});

Deno.test("repeating a key appends to a list", () => {
  const settings = parseIni([
    "[traces]",
    "SkipPaths = /health",
    "SkipPaths = /metrics",
    "SkipPaths = /ready",
    "",
    "[server.gin]",
    "groups = [/api/v1, /api/v2]",
    "groups = /api/v3",
  ].join("\n"));

  assertEquals(settings, {
    traces: { skippaths: ["/health", "/metrics", "/ready"] },
    server: { gin: { groups: ["/api/v1", "/api/v2", "/api/v3"] } },
  });
});

Deno.test("malformed content raises instead of loading partially", () => {
  const cases: Record<string, string> = {
    "missing separator": "[app]\nname",
    "unterminated section": "[app\nname = x",
    "trailing garbage": "[app] oops\nname = x",
    "missing key name": "[app]\n. = x",
  };

  for (const [name, content] of Object.entries(cases)) {
    assertThrows(() => parseIni(content, { source: "default.ini" }), Error, "default.ini", name);
  }
});

Deno.test("the error names the offending line", () => {
  const error = assertThrows(
    () => parseIni("[app]\nname = ok\nbroken\n", { source: "dragon-cmk.ini" }),
    Error,
  ) as Error;
  assertEquals(error.message.startsWith("dragon-cmk.ini: line 3:"), true, error.message);
});

Deno.test("carriage returns and blank input are tolerated", () => {
  assertEquals(parseIni("[app]\r\nname = dragon-cmk\r\n"), { app: { name: "dragon-cmk" } });
  assertEquals(parseIni(""), {});
  assertEquals(parseIni("; only a comment\n"), {});
});

Deno.test("an empty value stays an empty string", () => {
  assertEquals(parseIni("[jwt]\nhmac.secret =\n"), { jwt: { hmac: { secret: "" } } });
});
