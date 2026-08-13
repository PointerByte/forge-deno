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

/**
 * Minimum share of exported symbols that must carry a doc comment.
 *
 * JSR awards its "has docs for most symbols" point at 80%; this gate holds the
 * package at 100% so the published score can never drift down to the JSR floor
 * one undocumented export at a time. Lower it only as a reviewed decision.
 */
const MINIMUM_DOCUMENTED = 1;

const { total, documented, missing } = await measureSymbolCoverage(
  entries.map(([, entry]) => entry as string),
);
const ratio = total === 0 ? 1 : documented / total;
console.log(
  `documentation coverage: ${documented}/${total} symbols ` +
    `(${(ratio * 100).toFixed(2)}%)`,
);
if (ratio < MINIMUM_DOCUMENTED) {
  for (const symbol of missing) console.error(`  undocumented: ${symbol}`);
  fail(
    `${missing.length} exported symbol(s) without documentation; ` +
      `required ${(MINIMUM_DOCUMENTED * 100).toFixed(0)}%`,
  );
}

/** One `deno doc` node; only the fields this gate reads are modelled. */
interface DocNode {
  name?: string;
  kind?: string | null;
  location?: unknown;
  accessibility?: string;
  jsDoc?: { doc?: string };
  def?: Record<string, unknown>;
  tsType?: Record<string, unknown>;
}

/**
 * Counts exported symbols and their members, mirroring how JSR scores a
 * package: a class, an interface, an enum-like const and their members each
 * count as one symbol.
 */
async function measureSymbolCoverage(
  targets: string[],
): Promise<{ total: number; documented: number; missing: string[] }> {
  const child = new Deno.Command("deno", {
    args: ["doc", "--json", ...targets],
    cwd: root,
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const { success, stdout } = await child.output();
  if (!success) fail("`deno doc --json` failed");

  const parsed = JSON.parse(new TextDecoder().decode(stdout)) as {
    nodes: Record<string, { symbols?: { name?: string; declarations?: DocNode[] }[] }>;
  };

  const seen = new Map<string, boolean>();
  const documentedNode = (node: DocNode) => Boolean(node.jsDoc?.doc?.trim());
  const mark = (path: string, ok: boolean) => seen.set(path, (seen.get(path) ?? false) || ok);

  // Un typeLiteral aparece como `typeLiteral` o como `value` segun la version
  // del esquema de deno doc; se leen las dos para no contar de menos.
  const members = (container: Record<string, unknown> | undefined): DocNode[] => {
    if (!container) return [];
    const out: DocNode[] = [];
    for (const key of ["typeLiteral", "value"]) {
      const block = container[key] as Record<string, unknown> | undefined;
      if (!block) continue;
      out.push(...((block.properties ?? []) as DocNode[]));
      out.push(...((block.methods ?? []) as DocNode[]));
    }
    return out;
  };

  const walk = (node: DocNode, path: string): void => {
    // Un `reference` es un re-export: se documenta en su modulo de origen.
    if (node.kind === "reference") return;
    mark(path, documentedNode(node));
    const def = node.def ?? {};

    for (
      const member of [
        ...((def.methods ?? []) as DocNode[]),
        ...((def.properties ?? []) as DocNode[]),
      ]
    ) {
      if (member.accessibility === "private") continue;
      if (member.name?.startsWith("[")) continue;
      const child = `${path}.${member.name}`;
      mark(child, documentedNode(member));
      for (const leaf of members(member.tsType)) {
        mark(`${child}.${leaf.name}`, documentedNode(leaf));
      }
    }
    for (const ctor of (def.constructors ?? []) as DocNode[]) {
      if (ctor.accessibility === "private") continue;
      mark(`${path}.constructor`, documentedNode(ctor));
    }
    for (const member of (def.members ?? []) as DocNode[]) {
      mark(`${path}.${member.name}`, documentedNode(member));
    }
    for (const leaf of members(def.tsType as Record<string, unknown> | undefined)) {
      mark(`${path}.${leaf.name}`, documentedNode(leaf));
    }
    for (const element of (def.elements ?? []) as DocNode[]) {
      // Stub de `export * as ns`: sin kind ni location, resuelto en su origen.
      if (element.kind == null && element.location == null) continue;
      walk(element, `${path}.${element.name}`);
    }
  };

  for (const module of Object.values(parsed.nodes)) {
    for (const symbol of module.symbols ?? []) {
      for (const declaration of symbol.declarations ?? []) {
        walk(declaration, symbol.name ?? "(anonymous)");
      }
    }
  }

  const missing = [...seen.entries()].filter(([, ok]) => !ok).map(([p]) => p).sort();
  return { total: seen.size, documented: seen.size - missing.length, missing };
}

function fail(message: string): never {
  console.error(`documentation lint: ${message}`);
  Deno.exit(1);
}
