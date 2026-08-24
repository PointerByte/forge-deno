// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/** Build the machine-checkable GoForge-to-DenoForge public API matrix. */

interface GoAPI {
  id: string;
  package: string;
  directory: string;
  file: string;
  line: number;
  name: string;
  receiver?: string;
  kind: string;
  classification: string;
  documented: boolean;
  tested: boolean;
  benchmarked: boolean;
  portability: string;
}

interface GoInventory {
  schemaVersion: string;
  apis: GoAPI[];
}

interface DenoAPI {
  id: string;
  specifier: string;
  name: string;
  kind: string;
  source: string;
  line: number;
  documented: boolean;
}

interface DenoInventory {
  schemaVersion: string;
  apis: DenoAPI[];
}

type WasmClass = "A" | "B" | "C" | "D" | "E";

interface MatrixRow {
  goApi: string;
  module: string;
  publicApi: string;
  kind: string;
  source: string;
  classification: string;
  documented: boolean;
  tested: boolean;
  benchmarked: boolean;
  currentDenoStatus: "native-equivalent" | "documented-exception" | "deprecated-contract";
  denoRepresentative: string;
  portability: string;
  wasmClass: WasmClass;
  wasm: string;
  nativeAdapter: boolean;
  hybrid: boolean;
  priority: "critical" | "high" | "medium" | "low";
  complexity: "high" | "medium" | "low";
  rationale: string;
  migrationPath: string;
}

interface Options {
  go: string;
  deno: string;
  json: string;
  markdown: string;
  generatedAt: string;
  check: boolean;
}

function parseOptions(args: string[]): Options {
  const defaults: Options = {
    go:
      "../forge-go-private/openspec/changes/tinygo-wasip2-goforge-integration/research/evidence/go-api-inventory.json",
    deno:
      "openspec/changes/tinygo-wasip2-goforge-integration/research/evidence/deno-api-inventory.json",
    json:
      "openspec/changes/tinygo-wasip2-goforge-integration/research/evidence/functional-coverage-matrix.json",
    markdown:
      "openspec/changes/tinygo-wasip2-goforge-integration/research/evidence/functional-coverage-matrix.md",
    generatedAt: "2026-08-02T00:00:00Z",
    check: false,
  };
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === "--check") {
      defaults.check = true;
      continue;
    }
    if (!["--go", "--deno", "--json", "--markdown", "--generated-at"].includes(key)) {
      throw new Error(`unknown argument: ${key}`);
    }
    const value = args[++index];
    if (!value) throw new Error(`${key} requires a value`);
    if (key === "--go") defaults.go = value;
    if (key === "--deno") defaults.deno = value;
    if (key === "--json") defaults.json = value;
    if (key === "--markdown") defaults.markdown = value;
    if (key === "--generated-at") defaults.generatedAt = value;
  }
  return defaults;
}

function normalize(value: string): string {
  return value
    .replaceAll("Symetryc", "Symmetric")
    .replaceAll("Asymetryc", "Asymmetric")
    .replaceAll("Initialice", "Initialize")
    .replaceAll("Reciever", "Receiver")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, "");
}

function nameCandidates(api: GoAPI): Set<string> {
  const result = new Set<string>();
  const name = normalize(api.name);
  result.add(name);
  if (api.receiver) result.add(normalize(`${api.receiver}.${api.name}`));
  if (name.startsWith("new") && name.length > 3) {
    result.add(name.slice(3));
    result.add(`create${name.slice(3)}`);
    result.add(`${name.slice(3)}constructor`);
  }
  if (name.startsWith("get") && name.length > 3) result.add(name.slice(3));
  if (name.startsWith("is") && name.length > 2) result.add(name.slice(2));
  return result;
}

function domain(api: GoAPI): { module: string; specifiers: string[] } {
  const path = `/${api.directory}/`;
  if (path.includes("/encrypt/")) {
    if (path.includes("/aws-kms/")) return { module: "AWS KMS", specifiers: ["./encrypt/aws-kms"] };
    if (path.includes("/azure-key-vault/")) {
      return { module: "Azure Key Vault", specifiers: ["./encrypt/azure-key-vault"] };
    }
    if (path.includes("/gcp-kms/")) {
      return { module: "Google Cloud KMS", specifiers: ["./encrypt/gcp-kms"] };
    }
    return { module: "Encrypt / local crypto", specifiers: ["./encrypt"] };
  }
  if (path.includes("/logger/")) {
    return { module: "Logger / OpenTelemetry", specifiers: ["./logger"] };
  }
  if (path.includes("/security/")) return { module: "Security / JWT", specifiers: ["./security"] };
  if (path.includes("/config/client/http/") || path.includes("/config/server/gin/")) {
    return { module: "HTTP", specifiers: ["./config/http", "./config"] };
  }
  if (path.includes("/config/client/grpc/") || path.includes("/config/server/grpc/")) {
    return { module: "gRPC", specifiers: ["./config/grpc", "./config"] };
  }
  if (path.includes("/config/")) return { module: "Configuration", specifiers: ["./config"] };
  if (path.includes("/tools/jobs/")) return { module: "Jobs", specifiers: ["./tools"] };
  if (path.includes("/tools/workers/")) return { module: "Workers", specifiers: ["./tools"] };
  if (path.includes("/tools/")) {
    return { module: "Validation / utilities", specifiers: ["./tools"] };
  }
  if (path.includes("/cmd/go-openssl/")) {
    return { module: "CLI / local crypto", specifiers: ["./deno-openssl"] };
  }
  if (path.includes("/cmd/qgo/")) return { module: "CLI", specifiers: ["./qdeno"] };
  return { module: "Framework", specifiers: ["."] };
}

function findDeno(api: GoAPI, candidates: DenoAPI[]): DenoAPI | undefined {
  const names = nameCandidates(api);
  return candidates.find((candidate) => names.has(normalize(candidate.name))) ??
    candidates.find((candidate) => {
      const tail = candidate.name.split(".").at(-1) ?? candidate.name;
      return names.has(normalize(tail));
    });
}

function wasmClassification(api: GoAPI, module: string): WasmClass {
  if (api.classification === "Deprecated") return "D";
  if (["HTTP", "gRPC", "Logger / OpenTelemetry", "Jobs", "Workers", "CLI"].includes(module)) {
    return "D";
  }
  if (["AWS KMS", "Azure Key Vault", "Google Cloud KMS", "CLI / local crypto"].includes(module)) {
    return "E";
  }
  if (api.portability === "host-dependent") {
    return module === "Configuration" ? "C" : "B";
  }
  return "A";
}

function wasmLabel(value: WasmClass): string {
  return {
    A: "native component",
    B: "component after dependency inversion",
    C: "component with scoped host import",
    D: "native Deno adapter",
    E: "hybrid component and native adapter",
  }[value];
}

function priority(module: string, api: GoAPI): MatrixRow["priority"] {
  if (module.includes("Security") || module.includes("crypto") || module.includes("KMS")) {
    return "critical";
  }
  if (api.classification === "Deprecated") return "low";
  if (["HTTP", "gRPC", "Configuration", "Logger / OpenTelemetry"].includes(module)) return "high";
  return "medium";
}

function complexity(value: WasmClass, api: GoAPI): MatrixRow["complexity"] {
  if (value === "C" || value === "E") return "high";
  if (value === "B" || api.kind === "interface") return "medium";
  return "low";
}

/** Build a complete matrix from normalized source inventories. */
export function buildMatrix(go: GoInventory, deno: DenoInventory, generatedAt: string) {
  const rows: MatrixRow[] = go.apis.filter((api) =>
    api.classification !== "Internal" &&
    api.id && api.kind && api.name
  )
    .filter((api) => {
      // The generator owns visibility; an Internal classification is the only
      // non-public item that can survive in old catalogs.
      return api.classification === "Stable" || api.classification === "Experimental" ||
        api.classification === "Deprecated";
    })
    .map((api) => {
      const target = domain(api);
      const candidates = deno.apis.filter((item) => target.specifiers.includes(item.specifier));
      const match = findDeno(api, candidates);
      const wasmClass = wasmClassification(api, target.module);
      const deprecated = api.classification === "Deprecated";
      const currentDenoStatus: MatrixRow["currentDenoStatus"] = match
        ? "native-equivalent"
        : deprecated
        ? "deprecated-contract"
        : "documented-exception";
      const representative = match?.id ?? target.specifiers.join(" or ");
      const rationale = match
        ? "A forge-deno symbol with the normalized Go API name exists in the domain export; semantic parity remains test-gated."
        : deprecated
        ? "The compatibility catalog retains this deprecated Go contract without adding new runtime coupling."
        : wasmClass === "D" || wasmClass === "E"
        ? "The capability depends on runtime effects and is represented by the named Deno domain adapter pending an exact generated contract."
        : "No exact Deno symbol exists yet; the exception is explicit and remains a release-blocking migration item.";
      const migrationPath = match
        ? "Keep native and component behavior on shared vectors; replace the facade only after parity and benchmark gates pass."
        : deprecated
        ? "Publish its replacement and removal window; keep manifest metadata through the support window."
        : wasmClass === "D" || wasmClass === "E"
        ? "Generate the WIT/TypeScript contract, bind the existing native adapter, and add Go/Deno parity and capability-denial tests."
        : "Add the operation to the portable Go core and versioned WIT world, generate bindings, and pass tri-runtime parity tests.";
      return {
        goApi: api.id,
        module: target.module,
        publicApi: api.receiver ? `${api.receiver}.${api.name}` : api.name,
        kind: api.kind,
        source: `${api.file}:${api.line}`,
        classification: api.classification,
        documented: api.documented,
        tested: api.tested,
        benchmarked: api.benchmarked,
        currentDenoStatus,
        denoRepresentative: representative,
        portability: api.portability,
        wasmClass,
        wasm: wasmLabel(wasmClass),
        nativeAdapter: wasmClass === "D" || wasmClass === "E",
        hybrid: wasmClass === "E",
        priority: priority(target.module, api),
        complexity: complexity(wasmClass, api),
        rationale,
        migrationPath,
      } satisfies MatrixRow;
    });
  rows.sort((left, right) => left.goApi.localeCompare(right.goApi));
  const exact = rows.filter((row) => row.currentDenoStatus === "native-equivalent").length;
  const exceptions = rows.filter((row) => row.currentDenoStatus === "documented-exception").length;
  const deprecated = rows.filter((row) => row.currentDenoStatus === "deprecated-contract").length;
  const classes = Object.fromEntries(
    (["A", "B", "C", "D", "E"] as WasmClass[]).map((value) => [
      value,
      rows.filter((row) => row.wasmClass === value).length,
    ]),
  );
  return {
    schemaVersion: "1.0.0",
    generatedAt,
    source: { goInventorySchema: go.schemaVersion, denoInventorySchema: deno.schemaVersion },
    summary: {
      goPublicApis: rows.length,
      represented: rows.length,
      representationCoveragePercent: rows.length === 0 ? 0 : 100,
      exactNativeEquivalents: exact,
      exactNativePercent: rows.length === 0 ? 0 : Number((exact * 100 / rows.length).toFixed(1)),
      documentedExceptions: exceptions,
      deprecatedContracts: deprecated,
      wasmClasses: classes,
    },
    interpretation:
      "Representation coverage includes explicit exceptions as permitted by plan.md; it is not a claim of semantic parity. Only exactNativeEquivalents have a name-level Deno match, and every row remains subject to parity tests.",
    rows,
  };
}

function markdown(matrix: ReturnType<typeof buildMatrix>): string {
  const summary = matrix.summary;
  const lines = [
    "# forge-go → forge-deno Functional Coverage Matrix",
    "",
    `Generated: \`${matrix.generatedAt}\``,
    "",
    `All **${summary.goPublicApis}** cataloged Go public APIs are represented by an exact Deno symbol, a deprecated contract, or an explicit exception with a migration path (**${summary.representationCoveragePercent}% representation**). This is not a semantic-parity claim: **${summary.exactNativeEquivalents} (${summary.exactNativePercent}%)** currently have a name-level native match and **${summary.documentedExceptions}** remain documented migration exceptions.`,
    "",
    `WASM classes: A=${summary.wasmClasses.A}, B=${summary.wasmClasses.B}, C=${summary.wasmClasses.C}, D=${summary.wasmClasses.D}, E=${summary.wasmClasses.E}.`,
    "",
    "| Go API | Module | Deno status | Representative | Portability | WASM | Priority | Complexity | Migration path |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const row of matrix.rows) {
    lines.push(
      `| \`${row.goApi}\` | ${row.module} | ${row.currentDenoStatus} | \`${row.denoRepresentative}\` | ${row.portability} | ${row.wasmClass} | ${row.priority} | ${row.complexity} | ${row.migrationPath} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function writeOrCheck(path: string, value: string, check: boolean): Promise<void> {
  if (!check) {
    await Deno.writeTextFile(path, value);
    return;
  }
  const existing = await Deno.readTextFile(path);
  if (existing !== value) throw new Error(`compatibility matrix drifted: ${path}`);
}

/** Generate or verify the committed compatibility matrix. */
export async function generateCompatibilityMatrix(args: string[]): Promise<void> {
  const opts = parseOptions(args);
  const [go, deno] = await Promise.all([
    Deno.readTextFile(opts.go).then((value) => JSON.parse(value) as GoInventory),
    Deno.readTextFile(opts.deno).then((value) => JSON.parse(value) as DenoInventory),
  ]);
  const matrix = buildMatrix(go, deno, opts.generatedAt);
  await Promise.all([
    writeOrCheck(opts.json, `${JSON.stringify(matrix, null, 2)}\n`, opts.check),
    writeOrCheck(opts.markdown, markdown(matrix), opts.check),
  ]);
  console.log(opts.check ? "Compatibility matrix is current." : "Compatibility matrix generated.");
}

if (import.meta.main) await generateCompatibilityMatrix(Deno.args);
