// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs Deno documentation lint against every public package entry point.
 *
 * The export map is the source of truth: adding an entry to `deno.json`
 * automatically adds it to this gate.
 *
 * @module
 */

interface PackageConfig {
  /** Public package entry points keyed by import specifier. */
  exports: Record<string, string>;
}

const root = new URL("../", import.meta.url);
const configUrl = new URL("deno.json", root);
const config = JSON.parse(await Deno.readTextFile(configUrl)) as PackageConfig;
const entries = Object.entries(config.exports).sort(([left], [right]) =>
  left < right ? -1 : left > right ? 1 : 0
);

if (entries.length === 0) {
  fail("deno.json does not declare any exports");
}

const failed: string[] = [];
for (const [specifier, entry] of entries) {
  if (typeof entry !== "string" || !entry.startsWith("./")) {
    failed.push(`${specifier} has unsupported export target ${JSON.stringify(entry)}`);
    continue;
  }

  console.log(`documentation lint: ${specifier} -> ${entry}`);
  const child = new Deno.Command("deno", {
    args: ["doc", "--lint", entry],
    cwd: root,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await child.status;
  if (!status.success) failed.push(`${specifier} (${entry})`);
}

if (failed.length > 0) {
  fail(`failed for ${failed.join(", ")}`);
}

console.log(`documentation lint: checked ${entries.length} public exports`);

function fail(message: string): never {
  console.error(`documentation lint: ${message}`);
  Deno.exit(1);
}
