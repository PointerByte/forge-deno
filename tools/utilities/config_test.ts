// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertRejects } from "@std/assert";
import { type Config, getConfig, loadEnv } from "./config.ts";

/** Runs `body` in a throwaway directory, cleaned up afterwards. */
async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denoforge-config-" });
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Sets environment variables for one test and restores them afterwards. */
async function withEnv(
  variables: Record<string, string>,
  body: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(variables)) {
    previous.set(name, Deno.env.get(name));
    Deno.env.set(name, value);
  }
  try {
    await body();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

/** Writes one configuration file into `dir`. */
function write(dir: string, name: string, content: string): Promise<void> {
  return Deno.writeTextFile(`${dir}/${name}`, content);
}

/** Loads without touching the process environment, for deterministic assertions. */
function loadFiles(dir: string): Promise<Config> {
  return loadEnv(dir, { environmentOverrides: false, exportEnvFiles: false });
}

Deno.test("loads a YAML application file", async () => {
  await withTempDir(async (dir) => {
    await write(
      dir,
      "application.yml",
      [
        "app:",
        "  name: dragon-cmk",
        "  version: 0.0.1",
        "server:",
        "  http:",
        "    port: 8080",
        "    groups:",
        "      - /api/v1",
        "jwt:",
        "  enable: false",
      ].join("\n"),
    );

    const config = await loadFiles(dir);
    assertEquals(config.getString("app.name"), "dragon-cmk");
    assertEquals(config.getNumber("server.http.port"), 8080);
    assertEquals(config.getStringList("server.http.groups"), ["/api/v1"]);
    assertEquals(config.getBoolean("jwt.enable"), false);
  });
});

Deno.test("application.yml wins over application.json", async () => {
  await withTempDir(async (dir) => {
    await write(dir, "application.yml", "app:\n  name: from-yaml\n");
    await write(dir, "application.json", JSON.stringify({ app: { name: "from-json" } }));

    const config = await loadFiles(dir);
    assertEquals(config.getString("app.name"), "from-yaml");
  });
});

Deno.test("INI overlays refine the application file in order", async () => {
  await withTempDir(async (dir) => {
    await write(
      dir,
      "application.yml",
      [
        "app:",
        "  name: dragon-cmk",
        "  version: 0.0.1",
        "server:",
        "  http:",
        "    port: 8080",
        "    groups:",
        "      - /api/v1",
      ].join("\n"),
    );
    await write(
      dir,
      "default.ini",
      [
        "[app]",
        "version = 0.0.2",
        "",
        "[server.http]",
        "port = 9090",
        "groups = /api/v1, /api/v2",
      ].join("\n"),
    );
    await write(dir, "dragon-cmk.ini", "[server.http]\nport = 7070\n");

    const config = await loadFiles(dir);
    assertEquals(config.getString("app.name"), "dragon-cmk");
    // default.ini overrides the application file.
    assertEquals(config.getString("app.version"), "0.0.2");
    // <app.name>.ini overrides default.ini.
    assertEquals(config.getNumber("server.http.port"), 7070);
    assertEquals(config.getStringList("server.http.groups"), ["/api/v1", "/api/v2"]);
  });
});

Deno.test("app.name declared in default.ini still selects its overlay", async () => {
  await withTempDir(async (dir) => {
    await write(dir, "application.json", JSON.stringify({ server: { port: ":8080" } }));
    await write(dir, "default.ini", "[app]\nname = dragon-cmk\n");
    await write(dir, "dragon-cmk.ini", "[server]\nport = :7070\n");

    const config = await loadFiles(dir);
    assertEquals(config.getString("server.port"), ":7070");
  });
});

Deno.test("APP_NAME selects the overlay", async () => {
  await withTempDir(async (dir) => {
    await write(dir, "application.json", JSON.stringify({ app: { name: "dragon-cmk" } }));
    await write(dir, "dragon-cmk.ini", "[server]\nport = :7070\n");
    await write(dir, "wyvern-cmk.ini", "[server]\nport = :6060\n");

    await withEnv({ APP_NAME: "wyvern-cmk" }, async () => {
      const config = await loadEnv(dir, { exportEnvFiles: false });
      assertEquals(config.getString("server.port"), ":6060");
    });
  });
});

Deno.test("a project configured through INI alone loads from a parent resources/", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(`${dir}/resources`);
    await Deno.mkdir(`${dir}/cmd/example`, { recursive: true });
    await write(
      `${dir}/resources`,
      "default.ini",
      [
        "[app]",
        "name = dragon-cmk",
        "",
        "[server.http]",
        "port = 8080",
        "rate.limit = 1000",
      ].join("\n"),
    );

    const config = await loadFiles(`${dir}/cmd/example`);
    assertEquals(config.getString("app.name"), "dragon-cmk");
    assertEquals(config.getNumber("server.http.rate.limit"), 1000);
  });
});

Deno.test("env.files override the INI overlays", async () => {
  await withTempDir(async (dir) => {
    await write(
      dir,
      "application.json",
      JSON.stringify({
        app: { name: "dragon-cmk" },
        env: { files: [".env", ".env.local"] },
        server: { port: ":8080", modeTest: false },
      }),
    );
    await write(dir, "default.ini", "[server]\nport = :9090\nmodeTest = true\n");
    await write(dir, ".env", "SERVER_PORT=:6060\n");

    const config = await loadEnv(dir, { exportEnvFiles: false });
    assertEquals(config.getString("server.port"), ":6060");
    // A key the .env does not mention keeps its INI value.
    assertEquals(config.getBoolean("server.modeTest"), true);
  });
});

Deno.test("process environment variables override every file", async () => {
  await withTempDir(async (dir) => {
    await write(
      dir,
      "application.json",
      JSON.stringify({
        app: { name: "dragon-cmk" },
        server: { port: ":8080", modeTest: false, rate: { limit: 1000 } },
        traces: { SkipPaths: ["/health"] },
      }),
    );
    await write(dir, "default.ini", "[server]\nport = :9090\n");

    await withEnv({
      SERVER_PORT: ":5050",
      SERVER_MODETEST: "true",
      SERVER_RATE_LIMIT: "2500",
      TRACES_SKIPPATHS: "/health,/metrics",
    }, async () => {
      const config = await loadEnv(dir, { exportEnvFiles: false });
      assertEquals(config.getString("server.port"), ":5050");
      // Overrides keep the type the files declared.
      assertEquals(config.getBoolean("server.modeTest"), true);
      assertEquals(config.getNumber("server.rate.limit"), 2500);
      assertEquals(config.getStringList("traces.SkipPaths"), ["/health", "/metrics"]);
    });
  });
});

Deno.test("environmentOverrides: false loads exactly what the files declare", async () => {
  await withTempDir(async (dir) => {
    await write(dir, "application.json", JSON.stringify({ app: { name: "dragon-cmk" } }));

    await withEnv({ APP_NAME: "from-env" }, async () => {
      const config = await loadFiles(dir);
      assertEquals(config.getString("app.name"), "dragon-cmk");
    });
  });
});

Deno.test("a missing configuration directory is reported", async () => {
  await withTempDir(async (dir) => {
    await assertRejects(
      () => loadFiles(dir),
      Error,
      "no configuration found",
    );
  });
});

Deno.test("a malformed INI overlay is reported by name", async () => {
  await withTempDir(async (dir) => {
    await write(dir, "application.json", JSON.stringify({ app: { name: "dragon-cmk" } }));
    await write(dir, "default.ini", "[server\nport = :8080\n");

    await assertRejects(() => loadFiles(dir), Error, "default.ini");
  });
});

Deno.test("a malformed application file is reported by name", async () => {
  await withTempDir(async (dir) => {
    await write(dir, "application.json", "{ not json");
    await assertRejects(() => loadFiles(dir), Error, "application.json");
  });
});

Deno.test("an application file that is not a mapping is rejected", async () => {
  await withTempDir(async (dir) => {
    await write(dir, "application.yml", "- one\n- two\n");
    await assertRejects(() => loadFiles(dir), Error, "expected a mapping");
  });
});

Deno.test("missing INI and .env files are ignored", async () => {
  await withTempDir(async (dir) => {
    await write(
      dir,
      "application.json",
      JSON.stringify({ app: { name: "dragon-cmk" }, env: { files: [".env", "  "] } }),
    );

    const config = await loadFiles(dir);
    assertEquals(config.getString("app.name"), "dragon-cmk");
  });
});

Deno.test("accessors coerce, fall back and stay case-insensitive", async () => {
  await withTempDir(async (dir) => {
    await write(
      dir,
      "application.json",
      JSON.stringify({
        app: { name: "dragon-cmk", version: 1 },
        server: { port: "8080", enabled: "true", groups: "/a, /b", tls: { enable: true } },
      }),
    );

    const config = await loadFiles(dir);

    assertEquals(config.getString("APP.NAME"), "dragon-cmk");
    assertEquals(config.getString("app.version"), "1");
    assertEquals(config.getNumber("server.port"), 8080);
    assertEquals(config.getBoolean("server.enabled"), true);
    assertEquals(config.getBoolean("server.tls.enable"), true);
    assertEquals(config.getStringList("server.groups"), ["/a", "/b"]);

    assertEquals(config.getString("missing.key", "fallback"), "fallback");
    assertEquals(config.getNumber("missing.key", 42), 42);
    assertEquals(config.getBoolean("missing.key", true), true);
    assertEquals(config.getStringList("missing.key", ["x"]), ["x"]);
    assertEquals(config.getString("missing.key"), "");
    assertEquals(config.getNumber("missing.key"), 0);
    assertEquals(config.getBoolean("missing.key"), false);
    assertEquals(config.getStringList("missing.key"), []);
    assertEquals(config.get("missing.key"), undefined);

    // A record is not readable as a scalar.
    assertEquals(config.getString("server.tls", "fallback"), "fallback");
    assertEquals(config.getNumber("server.port", 1), 8080);

    assert(config.has("app.name"));
    assert(!config.has("app.missing"));

    config.set("server.port", 9090);
    assertEquals(config.getNumber("server.port"), 9090);

    const all = config.all();
    assertEquals((all.app as Record<string, unknown>).name, "dragon-cmk");
    // all() is a copy: mutating it cannot corrupt the loaded configuration.
    (all.app as Record<string, unknown>).name = "mutated";
    assertEquals(config.getString("app.name"), "dragon-cmk");
  });
});

Deno.test("getConfig returns the configuration the last load produced", async () => {
  await withTempDir(async (dir) => {
    await write(dir, "application.json", JSON.stringify({ app: { name: "dragon-cmk" } }));

    const config = await loadFiles(dir);
    assertEquals(getConfig(), config);
    assertEquals(getConfig().getString("app.name"), "dragon-cmk");
  });
});

Deno.test("env.files values reach the process environment when exported", async () => {
  await withTempDir(async (dir) => {
    await write(
      dir,
      "application.json",
      JSON.stringify({ app: { name: "dragon-cmk" }, env: { files: [".env"] } }),
    );
    await write(dir, ".env", "DENOFORGE_TEST_SECRET=from-env-file\n");

    await withEnv({ DENOFORGE_TEST_SECRET: "" }, async () => {
      await loadEnv(dir, { environmentOverrides: false });
      assertEquals(Deno.env.get("DENOFORGE_TEST_SECRET"), "from-env-file");
    });
  });
});
