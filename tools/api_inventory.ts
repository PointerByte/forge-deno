// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Generates a deterministic inventory of every configured DenoForge export.
 *
 * The tool delegates parsing to the exact Deno runtime under test (`deno doc
 * --json`) and normalizes the result into a stable, reviewable catalog.
 *
 * @module
 */

interface Location {
  filename?: string;
  line?: number;
}

interface DocNode {
  name?: string;
  kind?: string;
  jsDoc?: { doc?: string; tags?: Array<{ kind?: string }> };
  location?: Location;
  declarations?: Declaration[];
  def?: Record<string, unknown>;
}

interface Declaration extends DocNode {
  declarationKind?: string;
}

interface ApiItem {
  id: string;
  specifier: string;
  entrypoint: string;
  name: string;
  kind: string;
  source: string;
  line: number;
  documented: boolean;
  deprecated: boolean;
}

interface ExportConfig {
  name: string;
  version: string;
  exports: Record<string, string>;
}

interface Options {
  json?: string;
  markdown?: string;
  generatedAt: string;
}

function options(args: string[]): Options {
  const result: Options = { generatedAt: generatedAt() };
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--json" || value === "--markdown" || value === "--generated-at") {
      const next = args[++index];
      if (!next) throw new Error(`${value} requires a value`);
      if (value === "--json") result.json = next;
      if (value === "--markdown") result.markdown = next;
      if (value === "--generated-at") {
        if (Number.isNaN(Date.parse(next))) throw new Error("--generated-at must be RFC3339");
        result.generatedAt = next;
      }
      continue;
    }
    throw new Error(`unknown argument: ${value}`);
  }
  return result;
}

function generatedAt(): string {
  const epoch = Deno.env.get("SOURCE_DATE_EPOCH");
  if (epoch !== undefined) {
    const seconds = Number(epoch);
    if (!Number.isSafeInteger(seconds)) throw new Error("invalid SOURCE_DATE_EPOCH");
    return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
  }
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function normalizeSource(filename = ""): string {
  if (!filename) return "";
  if (!filename.startsWith("file:")) return filename;
  const path = new URL(filename).pathname;
  const cwd = Deno.cwd().replaceAll("\\", "/");
  return decodeURIComponent(path).replace(`${cwd}/`, "");
}

function documentation(node: DocNode): { documented: boolean; deprecated: boolean } {
  const text = node.jsDoc?.doc?.trim() ?? "";
  const tags = node.jsDoc?.tags ?? [];
  return {
    documented: text.length > 0,
    deprecated: /(^|\n)\s*@?deprecated\b/i.test(text) ||
      tags.some((tag) => tag.kind === "deprecated"),
  };
}

function pushApi(
  output: ApiItem[],
  seen: Set<string>,
  specifier: string,
  entrypoint: string,
  path: string,
  node: DocNode,
  fallback?: Declaration,
): void {
  const declaration = fallback ?? node;
  const kind = declaration.kind ?? node.kind ?? "unknown";
  const key = `${specifier}:${path}:${kind}`;
  if (seen.has(key)) return;
  seen.add(key);
  const docs = documentation(declaration.jsDoc ? declaration : node);
  output.push({
    id: `${specifier}:${path}`,
    specifier,
    entrypoint,
    name: path,
    kind,
    source: normalizeSource(declaration.location?.filename ?? node.location?.filename),
    line: declaration.location?.line ?? node.location?.line ?? 0,
    documented: docs.documented,
    deprecated: docs.deprecated,
  });
}

function namedChildren(def: Record<string, unknown> | undefined): DocNode[] {
  if (!def) return [];
  const children: DocNode[] = [];
  for (const key of ["elements", "methods", "properties", "constructors", "callSignatures"]) {
    const value = def[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object") children.push(child as DocNode);
      }
    }
  }
  const type = def.tsType;
  if (type && typeof type === "object") {
    const value = (type as Record<string, unknown>).value;
    if (value && typeof value === "object") {
      const properties = (value as Record<string, unknown>).properties;
      if (Array.isArray(properties)) {
        for (const property of properties) {
          if (property && typeof property === "object") {
            children.push({
              ...(property as DocNode),
              kind: (property as DocNode).kind ?? "property",
            });
          }
        }
      }
    }
  }
  return children;
}

function walkSymbol(
  output: ApiItem[],
  seen: Set<string>,
  specifier: string,
  entrypoint: string,
  parent: string,
  symbol: DocNode,
): void {
  const name = symbol.name ?? (symbol.kind === "constructor" ? "constructor" : "anonymous");
  const path = parent ? `${parent}.${name}` : name;
  const declarations = symbol.declarations ?? [];
  if (declarations.length === 0) {
    pushApi(output, seen, specifier, entrypoint, path, symbol);
    for (const child of namedChildren(symbol.def)) {
      walkSymbol(output, seen, specifier, entrypoint, path, child);
    }
    return;
  }
  const primary = declarations.find((item) => item.kind !== "reference") ?? declarations[0];
  pushApi(output, seen, specifier, entrypoint, path, symbol, primary);
  for (const declaration of declarations) {
    for (const child of namedChildren(declaration.def)) {
      walkSymbol(output, seen, specifier, entrypoint, path, child);
    }
  }
}

async function documentEntrypoint(specifier: string, entrypoint: string): Promise<ApiItem[]> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", entrypoint],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  if (!result.success) {
    throw new Error(
      `deno doc failed for ${specifier}: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
  const parsed = JSON.parse(new TextDecoder().decode(result.stdout)) as {
    nodes: Record<string, { symbols?: DocNode[] }>;
  };
  const output: ApiItem[] = [];
  const seen = new Set<string>();
  for (const module of Object.values(parsed.nodes)) {
    for (const symbol of module.symbols ?? []) {
      walkSymbol(output, seen, specifier, entrypoint, "", symbol);
    }
  }
  return output;
}

function markdown(value: ReturnType<typeof buildCatalog>): string {
  const rows = value.apis.map((api) =>
    `| \`${api.specifier}\` | \`${api.name}\` | ${api.kind} | ${api.documented} | ${api.source}:${api.line} |`
  );
  return [
    "# forge-deno Public API Inventory",
    "",
    `Generated: \`${value.generatedAt}\``,
    "",
    `Entrypoints: **${value.summary.entrypoints}** · APIs: **${value.summary.apis}** · Documented: **${value.summary.documented}** · Deprecated: **${value.summary.deprecated}**`,
    "",
    "| Specifier | API | Kind | Documented | Source |",
    "|---|---|---|---:|---|",
    ...rows,
    "",
  ].join("\n");
}

function buildCatalog(config: ExportConfig, apis: ApiItem[], stamp: string) {
  apis.sort((left, right) =>
    left.id.localeCompare(right.id) || left.kind.localeCompare(right.kind)
  );
  return {
    schemaVersion: "1.0.0",
    generatedAt: stamp,
    repository: "forge-deno-private",
    package: config.name,
    packageVersion: config.version,
    summary: {
      entrypoints: Object.keys(config.exports).length,
      apis: apis.length,
      documented: apis.filter((api) => api.documented).length,
      undocumented: apis.filter((api) => !api.documented).length,
      deprecated: apis.filter((api) => api.deprecated).length,
    },
    exports: Object.entries(config.exports).map(([specifier, entrypoint]) => ({
      specifier,
      entrypoint,
      apiCount: apis.filter((api) => api.specifier === specifier).length,
    })),
    apis,
  };
}

/** Generate the inventory and write the requested artifacts. */
export async function generate(args: string[]): Promise<void> {
  const opts = options(args);
  const config = JSON.parse(await Deno.readTextFile("deno.json")) as ExportConfig;
  const groups = await Promise.all(
    Object.entries(config.exports).map(([specifier, entrypoint]) =>
      documentEntrypoint(specifier, entrypoint)
    ),
  );
  const result = buildCatalog(config, groups.flat(), opts.generatedAt);
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (opts.json) await Deno.writeTextFile(opts.json, json);
  else await Deno.stdout.write(new TextEncoder().encode(json));
  if (opts.markdown) await Deno.writeTextFile(opts.markdown, markdown(result));
}

if (import.meta.main) await generate(Deno.args);
