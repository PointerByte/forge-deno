// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Generates the TypeScript view of GoForge's canonical contract from the release bundle.
 *
 * The source of truth is `goforge.abi.manifest.json` — the manifest the Go `portable` module emits
 * and the component re-exports — plus the WIT extracted from the built component. Nothing here is
 * authored by hand, and nothing here duplicates business logic: the output is types and constant
 * tables only.
 *
 * The generated module is deliberately *not* what the runtime imports. `wasm/contracts.ts` stays the
 * hand-written public surface, and `wasm/generated_contract_test.ts` asserts the two agree. That way
 * a GoForge contract change fails a test naming the exact drift instead of silently rewriting the
 * public API.
 *
 * ```
 * deno task contract          # regenerate
 * deno task contract:check    # fail if the committed output is stale
 * ```
 *
 * @module
 */

const GENERATED_PATH = new URL("../wasm/generated/goforge-contract.ts", import.meta.url);

interface PortableManifest {
  schema: string;
  package: string;
  version: string;
  abi: string;
  encoding: { json: string; binary: string };
  limits: Record<string, number>;
  operations: Array<{ name: string; capability: string }>;
  capabilities: Array<{ name: string; version: string; host: boolean; operations?: string[] }>;
  errors: Array<{ code: string; message: string; retryable: boolean }>;
}

/** Locates the release bundle the contract is generated from. */
function bundleDirectory(): URL {
  const override = Deno.env.get("GOFORGE_COMPONENT_BUNDLE");
  if (override) return new URL(override.endsWith("/") ? override : `${override}/`, import.meta.url);
  return new URL("../../forge-go-private/component/artifacts/", import.meta.url);
}

/** Extracts the exported WIT interface name so the generated module records its provenance. */
function witInterface(wit: string): string {
  const match = wit.match(/export\s+(pointerbyte:goforge\/operations@[0-9]+\.[0-9]+\.[0-9]+)/);
  if (!match) throw new Error("the extracted WIT does not export pointerbyte:goforge/operations");
  return match[1];
}

/** Extracts the execution-state record field names, in WIT declaration order. */
function witExecutionStateFields(wit: string): string[] {
  const record = wit.match(/record\s+execution-state\s*\{([^}]*)\}/);
  if (!record) throw new Error("the extracted WIT does not declare an execution-state record");
  return record[1]
    .split(",")
    .map((line) => line.split(":")[0].trim())
    .filter((name) => name.length > 0);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function render(manifest: PortableManifest, wit: string): string {
  const operations = manifest.operations.map((operation) => operation.name);
  const capabilityEntries = manifest.operations
    .map((operation) => `  ${quote(operation.name)}: ${quote(operation.capability)},`)
    .join("\n");
  const errorEntries = manifest.errors
    .map((error) =>
      `  ${quote(error.code)}: { message: ${quote(error.message)}, retryable: ${error.retryable} },`
    )
    .join("\n");
  const limitEntries = Object.entries(manifest.limits)
    .map(([name, value]) => `  ${quote(name)}: ${value},`)
    .join("\n");

  return `// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0
//
// GENERATED FILE — DO NOT EDIT.
// Produced by tools/wit_contract.ts from the GoForge release bundle:
//   ${manifest.schema} / ${manifest.package}@${manifest.version} / ${manifest.abi}
//   WIT export: ${witInterface(wit)}
// Regenerate with \`deno task contract\`; \`deno task contract:check\` fails when this is stale.

/** Contract identity as declared by GoForge. */
export const GENERATED_PORTABLE_PACKAGE = ${quote(manifest.package)} as const;
/** Contract version as declared by GoForge. */
export const GENERATED_PORTABLE_VERSION = ${quote(manifest.version)} as const;
/** Portable contract manifest schema as declared by GoForge. */
export const GENERATED_PORTABLE_MANIFEST_SCHEMA = ${quote(manifest.schema)} as const;
/** JSON bridge ABI as declared by GoForge. */
export const GENERATED_ABI = ${quote(manifest.abi)} as const;
/** Versioned WIT interface exported by the built component. */
export const GENERATED_WIT_INTERFACE = ${quote(witInterface(wit))} as const;

/** Serialization profile GoForge accepts. */
export const GENERATED_ENCODING = Object.freeze({
  json: ${quote(manifest.encoding.json)},
  binary: ${quote(manifest.encoding.binary)},
});

/** Every operation, in GoForge's declaration order. */
export const GENERATED_OPERATIONS = [
${operations.map((name) => `  ${quote(name)},`).join("\n")}
] as const;

/** An operation name derived from the GoForge contract. */
export type GeneratedOperation = typeof GENERATED_OPERATIONS[number];

/** Required capability per operation. */
export const GENERATED_OPERATION_CAPABILITIES: Readonly<Record<GeneratedOperation, string>> = Object
  .freeze({
${capabilityEntries}
});

/** Every capability GoForge declares, including host-supplied controls. */
export const GENERATED_CAPABILITIES = [
${manifest.capabilities.map((capability) => `  ${quote(capability.name)},`).join("\n")}
] as const;

/** Host-supplied control capabilities, which the guest cannot satisfy alone. */
export const GENERATED_HOST_CAPABILITIES = [
${
    manifest.capabilities.filter((capability) => capability.host).map((capability) =>
      `  ${quote(capability.name)},`
    ).join("\n")
  }
] as const;

/** Resource bounds the guest enforces. */
export const GENERATED_LIMITS: Readonly<Record<string, number>> = Object.freeze({
${limitEntries}
});

/** Error codes in GoForge's catalog order; the guest manifest is compared position by position. */
export const GENERATED_ERROR_CODES = [
${manifest.errors.map((error) => `  ${quote(error.code)},`).join("\n")}
] as const;

/** A canonical error code derived from the GoForge contract. */
export type GeneratedErrorCode = typeof GENERATED_ERROR_CODES[number];

/** The immutable error catalog, message and retryability included. */
export const GENERATED_ERROR_CATALOG: Readonly<
  Record<GeneratedErrorCode, { readonly message: string; readonly retryable: boolean }>
> = Object.freeze({
${errorEntries}
});

/** Execution-state record fields, in WIT declaration order. */
export const GENERATED_EXECUTION_STATE_FIELDS = [
${witExecutionStateFields(wit).map((field) => `  ${quote(field)},`).join("\n")}
] as const;
`;
}

/**
 * Formats the rendered module exactly as `deno fmt` would.
 *
 * Without this the generated file and the repository formatter disagree, and `contract:check` and
 * `fmt:check` would take turns failing after each other's fixes.
 */
async function formatted(source: string): Promise<string> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["fmt", "--ext", "ts", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const process = command.spawn();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(source));
  await writer.close();
  const { code, stdout, stderr } = await process.output();
  if (code !== 0) {
    throw new Error(`deno fmt failed: ${new TextDecoder().decode(stderr)}`);
  }
  return new TextDecoder().decode(stdout);
}

async function main(): Promise<void> {
  const check = Deno.args.includes("--check");
  const directory = bundleDirectory();
  let manifestText: string;
  let wit: string;
  try {
    manifestText = await Deno.readTextFile(new URL("goforge.abi.manifest.json", directory));
    wit = await Deno.readTextFile(new URL("goforge.component.wit", directory));
  } catch {
    // The bundle is released separately, so a standalone checkout simply keeps what is committed.
    console.log(
      "contract: no release bundle found; keeping the committed generated contract unchanged",
    );
    return;
  }

  const manifest = JSON.parse(manifestText) as PortableManifest;
  const rendered = await formatted(render(manifest, wit));

  if (check) {
    let committed: string;
    try {
      committed = await Deno.readTextFile(GENERATED_PATH);
    } catch {
      console.error("contract: the generated contract is missing; run `deno task contract`");
      Deno.exit(1);
    }
    if (committed !== rendered) {
      console.error("contract: the generated contract is stale; run `deno task contract`");
      Deno.exit(1);
    }
    console.log("contract: the generated GoForge contract is current.");
    return;
  }

  await Deno.mkdir(new URL("./", GENERATED_PATH), { recursive: true });
  await Deno.writeTextFile(GENERATED_PATH, rendered);
  console.log(`contract: wrote ${GENERATED_PATH.pathname}`);
}

if (import.meta.main) await main();
