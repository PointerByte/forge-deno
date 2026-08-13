// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Collects a fresh full-suite coverage profile and enforces the Phase 0 floor.
 *
 * Deno's threshold is applied independently to line, branch and function
 * coverage. Keeping orchestration in Deno avoids shell-specific cleanup.
 *
 * @module
 */

const repository = new URL("../", import.meta.url);
const profile = new URL("../coverage", import.meta.url);

try {
  await Deno.remove(profile, { recursive: true });
} catch (cause) {
  if (!(cause instanceof Deno.errors.NotFound)) throw cause;
}

await runDeno(
  ["test", "-A", "--coverage=coverage"],
  "coverage test collection",
);
await runDeno(
  ["coverage", "--exclude=research/**", "--threshold=80", "coverage"],
  "coverage threshold",
);

async function runDeno(args: string[], label: string): Promise<void> {
  const child = new Deno.Command(Deno.execPath(), {
    args,
    cwd: repository,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await child.status;
  if (!status.success) {
    console.error(`${label} failed with exit code ${status.code}`);
    Deno.exit(status.code);
  }
}
