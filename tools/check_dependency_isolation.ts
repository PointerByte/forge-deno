// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Verifies optional gRPC package boundaries against Deno's resolved graph.
 *
 * Source-text checks can miss re-exports and type-only dependencies. This gate
 * asks `deno info --json` for every focused public entry point and inspects the
 * actual resolved module specifiers instead.
 *
 * @module
 */

interface InfoModule {
  specifier: string;
}

interface InfoGraph {
  modules: InfoModule[];
}

const OPTIONAL_GRPC_PACKAGES = [
  "@grpc/grpc-js",
  "@grpc/proto-loader",
] as const;

const isolatedEntries = [
  "config/http/mod.ts",
  "logger/mod.ts",
  "security/mod.ts",
] as const;

const grpcEntry = "config/grpc/mod.ts";

for (const entry of isolatedEntries) {
  const graph = await resolvedGraph(entry);
  const present = OPTIONAL_GRPC_PACKAGES.filter((packageName) => hasPackage(graph, packageName));
  if (present.length > 0) {
    fail(`${entry} unexpectedly resolves optional gRPC packages: ${present.join(", ")}`);
  }
  console.log(`dependency isolation: ${entry} excludes optional gRPC packages`);
}

const grpcGraph = await resolvedGraph(grpcEntry);
const missing = OPTIONAL_GRPC_PACKAGES.filter((packageName) => !hasPackage(grpcGraph, packageName));
if (missing.length > 0) {
  fail(`${grpcEntry} must resolve its runtime packages; missing: ${missing.join(", ")}`);
}
console.log(`dependency isolation: ${grpcEntry} includes optional gRPC packages`);

async function resolvedGraph(entry: string): Promise<InfoGraph> {
  const command = new Deno.Command("deno", {
    args: ["info", "--json", entry],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    const detail = new TextDecoder().decode(output.stderr).trim();
    fail(`deno info failed for ${entry}${detail ? `: ${detail}` : ""}`);
  }

  const raw = new TextDecoder().decode(output.stdout);
  try {
    return JSON.parse(raw) as InfoGraph;
  } catch (cause) {
    fail(
      `deno info returned invalid JSON for ${entry}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

function hasPackage(graph: InfoGraph, packageName: string): boolean {
  const npmPrefix = `npm:/${packageName}@`;
  const legacyNpmPrefix = `npm:${packageName}@`;
  return graph.modules.some(({ specifier }) =>
    specifier.startsWith(npmPrefix) || specifier.startsWith(legacyNpmPrefix)
  );
}

function fail(message: string): never {
  console.error(`dependency isolation: ${message}`);
  Deno.exit(1);
}
