// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@std/assert";
import { initLogger } from "../builder/builder.ts";
import { newFileSink } from "./file.ts";

const tinyMaxSize = 0.000025;

Deno.test("file sink appends records in order", () => {
  withTempDir((dir) => {
    const sink = newFileSink({ dir, fileName: "app.log", tee: false });
    sink("first");
    sink("second");
    sink("third");
    assertEquals(Deno.readTextFileSync(`${dir}/app.log`), "first\nsecond\nthird\n");
  });
});

Deno.test("rotate.enable false leaves the active file growing", () => {
  withTempDir((dir) => {
    const sink = newFileSink({
      dir,
      fileName: "app.log",
      rotate: { enable: false, maxSize: tinyMaxSize },
      tee: false,
    });
    sink("first-record-is-larger-than-the-threshold");
    sink("second-record-is-also-larger-than-the-threshold");

    assertEquals(backups(dir).length, 0);
    assert(Deno.readTextFileSync(`${dir}/app.log`).includes("second-record"));
  });
});

Deno.test("file sink rotates before writing the record that crosses maxSize", () => {
  withTempDir((dir) => {
    const sink = newFileSink({
      dir,
      fileName: "app.log",
      rotate: { enable: true, maxSize: tinyMaxSize },
      tee: false,
    });
    sink("first-record-before-rotation");
    sink("last-record-after-rotation");

    const rotated = backups(dir);
    assertEquals(rotated.length, 1);
    assertEquals(Deno.readTextFileSync(`${dir}/app.log`), "last-record-after-rotation\n");
    assertEquals(Deno.readTextFileSync(`${dir}/${rotated[0]}`), "first-record-before-rotation\n");
  });
});

Deno.test("maxBackups retains only the newest rotated files", () => {
  withTempDir((dir) => {
    const sink = newFileSink({
      dir,
      fileName: "app.log",
      rotate: { enable: true, maxSize: tinyMaxSize, maxBackups: 2, maxAge: 0 },
      tee: false,
    });
    for (let index = 0; index < 5; index++) {
      sink(`record-${index}-large-enough-to-force-rotation`);
    }
    assertEquals(backups(dir).length, 2);
  });
});

Deno.test("maxAge removes expired backups and zero disables expiry", () => {
  withTempDir((dir) => {
    const expired = `${dir}/app-2000-01-01T00-00-00.000.log`;
    Deno.writeTextFileSync(expired, "old\n");
    const old = new Date("2000-01-01T00:00:00.000Z");
    Deno.utimeSync(expired, old, old);

    const sink = newFileSink({
      dir,
      fileName: "app.log",
      rotate: { enable: true, maxSize: tinyMaxSize, maxBackups: 0, maxAge: 1 },
      tee: false,
    });
    sink("first-record-before-rotation");
    sink("second-record-after-rotation");
    assert(!pathExists(expired));
  });

  withTempDir((dir) => {
    const expired = `${dir}/app-2000-01-01T00-00-00.000.log`;
    Deno.writeTextFileSync(expired, "old\n");
    const old = new Date("2000-01-01T00:00:00.000Z");
    Deno.utimeSync(expired, old, old);

    const sink = newFileSink({
      dir,
      fileName: "app.log",
      rotate: { enable: true, maxSize: tinyMaxSize, maxBackups: 0, maxAge: 0 },
      tee: false,
    });
    sink("first-record-before-rotation");
    sink("second-record-after-rotation");
    assert(Deno.statSync(expired).isFile);
  });
});

Deno.test("compress creates gzip and removes the plain backup", async () => {
  await withTempDirAsync(async (dir) => {
    const sink = newFileSink({
      dir,
      fileName: "app.log",
      rotate: {
        enable: true,
        maxSize: tinyMaxSize,
        maxBackups: 5,
        maxAge: 0,
        compress: true,
      },
      tee: false,
    });
    sink("first-record-before-rotation");
    sink("second-record-after-rotation");

    const gzipName = await waitForGzip(dir);
    assertEquals(backups(dir), [gzipName]);
    const plainName = gzipName.slice(0, -3);
    assert(!pathExists(`${dir}/${plainName}`));

    const compressed = await Deno.readFile(`${dir}/${gzipName}`);
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
    const content = await new Response(stream).text();
    assertEquals(content, "first-record-before-rotation\n");
  });
});

Deno.test("default tee writes to stdout and file; tee false writes only to file", () => {
  withTempDir((dir) => {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      newFileSink({ dir, fileName: "tee.log" })("with-tee");
      newFileSink({ dir, fileName: "only-file.log", tee: false })("without-tee");
    } finally {
      console.log = originalLog;
    }

    assertEquals(output, ["with-tee"]);
    assertEquals(Deno.readTextFileSync(`${dir}/tee.log`), "with-tee\n");
    assertEquals(Deno.readTextFileSync(`${dir}/only-file.log`), "without-tee\n");
  });
});

Deno.test("unusable dir falls back to stdout and reports each failure once", () => {
  withTempDir((dir) => {
    Deno.writeTextFileSync(`${dir}/not-a-directory`, "blocking file");
    const output: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      const sink = newFileSink({
        dir: `${dir}/not-a-directory/logs`,
        fileName: "app.log",
        tee: false,
      });
      sink("first");
      sink("second");
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    assertEquals(output, ["first", "second"]);
    assertEquals(errors.length, 1);
    assert(errors[0].includes("file sink unavailable"));
  });
});

Deno.test({
  name: "denied write permission falls back to stdout and reports once",
  permissions: { write: false },
  fn: () => {
    const output: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      const sink = newFileSink({
        dir: "./logger/sink/permission-denied",
        fileName: "app.log",
        tee: false,
      });
      sink("first");
      sink("second");
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    assertEquals(output, ["first", "second"]);
    assertEquals(errors.length, 1);
  },
});

Deno.test("explicit LoggerOptions.sink wins over dir and rotate", () => {
  withTempDir((dir) => {
    const blocker = `${dir}/not-a-directory`;
    Deno.writeTextFileSync(blocker, "blocking file");
    const lines: string[] = [];
    const logger = initLogger({
      formatter: "json",
      sink: (line) => lines.push(line),
      dir: `${blocker}/logs`,
      rotate: { enable: true },
    });
    logger.info("captured");
    assertEquals(lines.length, 1);
    assertEquals(JSON.parse(lines[0]).message, "captured");
  });
});

Deno.test("LoggerOptions.dir writes to the service file only when rotation is enabled", () => {
  withTempDir((dir) => {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      const fileLogger = initLogger({
        formatter: "json",
        dir,
        rotate: { enable: true },
        service: { name: "orders" },
      });
      fileLogger.info("persisted");

      const stdoutLogger = initLogger({
        formatter: "json",
        dir,
        rotate: { enable: false },
        service: { name: "stdout-only" },
      });
      stdoutLogger.info("not-persisted");
    } finally {
      console.log = originalLog;
    }

    assertEquals(JSON.parse(Deno.readTextFileSync(`${dir}/orders.log`)).message, "persisted");
    assert(!pathExists(`${dir}/stdout-only.log`));
    assertEquals(output.length, 2);
  });
});

Deno.test("file sink creates 0700 directories and 0600 files", () => {
  withTempDir((root) => {
    const dir = `${root}/logs`;
    const sink = newFileSink({ dir, fileName: "app.log", tee: false });
    sink("record");

    assertEquals((Deno.statSync(dir).mode ?? 0) & 0o777, 0o700);
    assertEquals((Deno.statSync(`${dir}/app.log`).mode ?? 0) & 0o777, 0o600);
  });
});

function backups(dir: string): string[] {
  return [...Deno.readDirSync(dir)]
    .filter((entry) =>
      entry.isFile &&
      entry.name.startsWith("app-") &&
      (entry.name.endsWith(".log") || entry.name.endsWith(".log.gz"))
    )
    .map((entry) => entry.name)
    .sort();
}

function withTempDir(run: (dir: string) => void): void {
  const dir = Deno.makeTempDirSync({ prefix: "denoforge-file-sink-" });
  try {
    run(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

async function withTempDirAsync(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = Deno.makeTempDirSync({ prefix: "denoforge-file-sink-" });
  try {
    await run(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

async function waitForGzip(dir: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const gzip = backups(dir).find((name) => name.endsWith(".gz"));
    if (gzip) return gzip;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("gzip backup was not created");
}

function pathExists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
