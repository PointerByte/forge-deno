// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fails when `deno.json` or a workflow references a file or package that does not exist.
 *
 * This exists because of a real defect: `deno.json` referenced
 * `tools/check-dependency-isolation.ts`, `tools/check-coverage.ts` and `tools/check-docs.ts` with
 * hyphens while the files use underscores. `deno task check` and `check:deps` failed outright, and
 * because the publish allow-list carried the same wrong names, two CI-only tools were shipped in the
 * JSR package. Nothing caught it, because a task that cannot resolve its entry point looks like a
 * broken task rather than a broken configuration.
 *
 * It also pins the OpenSpec package identity. The published CLI is `@fission-ai/openspec`; the bare
 * `openspec` name on npm is an unrelated `0.0.0` placeholder with no binary, so a workflow using it
 * fails to resolve at CI time rather than at review time.
 *
 * ```
 * deno task check:config
 * ```
 *
 * @module
 */

const root = new URL("../", import.meta.url);

/** The npm package that actually publishes the OpenSpec CLI. */
export const OPENSPEC_PACKAGE = "@fission-ai/openspec";

interface DenoConfig {
  exports?: Record<string, string>;
  publish?: { exclude?: string[] };
  tasks?: Record<string, string>;
  fmt?: { exclude?: string[] };
}

const problems: string[] = [];

function exists(relative: string): boolean {
  try {
    Deno.statSync(new URL(relative, root));
    return true;
  } catch {
    return false;
  }
}

const config = JSON.parse(await Deno.readTextFile(new URL("deno.json", root))) as DenoConfig;

// Every export must resolve, or consumers get a broken package.
for (const [name, path] of Object.entries(config.exports ?? {})) {
  if (!exists(path)) problems.push(`exports[${JSON.stringify(name)}] -> missing ${path}`);
}

// Publish exclusions that name nothing exclude nothing. A stale name here means
// the file it was meant to keep out is being published.
for (const pattern of config.publish?.exclude ?? []) {
  if (pattern.includes("*")) continue;
  if (!exists(pattern)) problems.push(`publish.exclude -> missing ${pattern}`);
}

for (const pattern of config.fmt?.exclude ?? []) {
  if (pattern.includes("*")) continue;
  if (!exists(pattern)) problems.push(`fmt.exclude -> missing ${pattern}`);
}

// Task command lines are shell strings; pull out anything that looks like a
// repository-relative TypeScript entry point and require it to exist.
const entryPoint =
  /(?<![\w./-])((?:tools|wasm|cmd|benchmarks|examples|config|encrypt)\/[\w./-]+\.ts)/g;
for (const [name, command] of Object.entries(config.tasks ?? {})) {
  for (const [, path] of command.matchAll(entryPoint)) {
    if (path.includes("*")) continue;
    if (!exists(path)) problems.push(`tasks[${JSON.stringify(name)}] -> missing ${path}`);
  }
}

// Workflows must use the real OpenSpec package.
for (const workflow of [".github/workflows/ci.yml"]) {
  if (!exists(workflow)) continue;
  const contents = await Deno.readTextFile(new URL(workflow, root));
  for (const [, spec] of contents.matchAll(/npx\s+(?:--yes\s+)?(\S*openspec\S*)/g)) {
    if (!spec.startsWith(OPENSPEC_PACKAGE + "@") && spec !== OPENSPEC_PACKAGE) {
      problems.push(
        `${workflow} -> ${spec} is not the published OpenSpec CLI; use ${OPENSPEC_PACKAGE}`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error("configuration references files or packages that do not exist:");
  for (const problem of problems) console.error(`  ${problem}`);
  Deno.exit(1);
}
console.log("config: every deno.json and workflow reference resolves.");
