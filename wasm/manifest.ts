// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  GOFORGE_ABI_V1,
  GOFORGE_ABI_V1_OPERATION_CAPABILITIES,
  GOFORGE_ABI_V1_OPERATIONS,
  GOFORGE_BUNDLE_MANIFEST_SCHEMA_V1,
  GOFORGE_PORTABLE_MANIFEST_SCHEMA_V1,
  GOFORGE_PORTABLE_PACKAGE,
  GOFORGE_PORTABLE_VERSION,
  type GoforgeAbiOperationV1,
  type VerifiedWasmBundle,
  type WasmArtifactDescriptor,
  type WasmBundleLocator,
  type WasmBundleManifestV1,
  type WasmCompatibility,
  type WasmOperationContract,
} from "./contracts.ts";
import { assertUniqueAbiJsonObjectFields, GOFORGE_ABI_ERROR_CATALOG } from "./codec.ts";
import { WasmCompatibilityError, WasmIntegrityError, WasmManifestError } from "./errors.ts";

const sha256Pattern = /^[a-f0-9]{64}$/;
const versionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const witPattern = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const operationPattern = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;
const capabilityPattern = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;

/** Reads a package-relative artifact path. */
export type WasmArtifactReader = (path: string) => Promise<Uint8Array>;

/** Creates a reader scoped to one file URL directory. */
export function createFileArtifactReader(baseUrl: URL): WasmArtifactReader {
  if (baseUrl.protocol !== "file:") {
    throw new WasmManifestError("the default artifact reader accepts only a file: base URL");
  }
  const directory = baseUrl.pathname.endsWith("/") ? baseUrl : new URL("./", baseUrl);
  return async (path: string) => {
    assertRelativeArtifactPath(path, "artifact path");
    try {
      return await Deno.readFile(new URL(path, directory));
    } catch (cause) {
      throw new WasmIntegrityError(`unable to read component artifact ${JSON.stringify(path)}`, {
        cause,
      });
    }
  };
}

/** Computes the lowercase SHA-256 digest used by bundle descriptors. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
  );
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * Reads and verifies a complete component bundle before returning any bytes to a factory.
 *
 * The trusted manifest checksum is verified before JSON parsing. Exact schema, ABI, component,
 * and WIT compatibility are then checked before source, glue, and core module bytes are loaded.
 */
export async function verifyWasmBundle(
  locator: WasmBundleLocator,
  compatibility: WasmCompatibility,
  readArtifact: WasmArtifactReader,
): Promise<VerifiedWasmBundle> {
  assertRelativeArtifactPath(locator.manifestPath, "manifestPath");
  assertSha256(locator.manifestSha256, "manifestSha256");
  let manifestBytes: Uint8Array;
  try {
    manifestBytes = Uint8Array.from(await readArtifact(locator.manifestPath));
  } catch (cause) {
    if (cause instanceof WasmIntegrityError) throw cause;
    throw new WasmIntegrityError("unable to read the component manifest", { cause });
  }
  await verifyDigest(locator.manifestPath, manifestBytes, locator.manifestSha256);

  const manifest = parseManifest(manifestBytes);
  validateCompatibility(manifest, compatibility);

  const descriptors: Array<[string, WasmArtifactDescriptor]> = [
    ["source", manifest.source],
    ["glue", manifest.glue],
    ...Object.entries(manifest.coreModules)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, descriptor]): [string, WasmArtifactDescriptor] => [
        `core module ${name}`,
        descriptor,
      ]),
  ];
  const paths = new Set<string>();
  for (const [label, descriptor] of descriptors) {
    if (paths.has(descriptor.path)) {
      throw new WasmManifestError(`multiple artifacts use path ${JSON.stringify(descriptor.path)}`);
    }
    paths.add(descriptor.path);
    validateDescriptor(descriptor, label);
  }

  const verified = new Map<string, Uint8Array>();
  for (const [, descriptor] of descriptors) {
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(await readArtifact(descriptor.path));
    } catch (cause) {
      if (cause instanceof WasmIntegrityError) throw cause;
      throw new WasmIntegrityError(
        `unable to read component artifact ${JSON.stringify(descriptor.path)}`,
        { cause },
      );
    }
    await verifyDigest(descriptor.path, bytes, descriptor.sha256);
    verified.set(descriptor.path, bytes);
  }

  const coreModuleBytes = new Map<string, Uint8Array>();
  for (const [name, descriptor] of Object.entries(manifest.coreModules)) {
    coreModuleBytes.set(name, requireVerified(verified, descriptor.path));
  }
  return {
    manifest: deepFreezeManifest(manifest),
    manifestBytes,
    sourceBytes: requireVerified(verified, manifest.source.path),
    glueBytes: requireVerified(verified, manifest.glue.path),
    coreModuleBytes,
  };
}

/**
 * Verifies the contract manifest exported by the instantiated Go component.
 *
 * The immutable release-bundle manifest proves artifact integrity; this independent manifest proves
 * that the instantiated guest implements the canonical GoForge portable contract. Conflating these
 * schemas would permit release metadata to masquerade as the business ABI.
 */
export function assertPortableContractManifest(
  json: string,
  bundle: Readonly<WasmBundleManifestV1>,
): void {
  let value: unknown;
  try {
    assertUniqueAbiJsonObjectFields(json);
    value = JSON.parse(json);
  } catch (cause) {
    throw new WasmCompatibilityError("component portable manifest is not valid JSON", { cause });
  }
  const root = requireRecord(value, "portable manifest");
  requireExactKeys(root, [
    "schema",
    "package",
    "version",
    "abi",
    "encoding",
    "limits",
    "operations",
    "capabilities",
    "errors",
  ], "portable manifest");
  if (
    root.schema !== GOFORGE_PORTABLE_MANIFEST_SCHEMA_V1 ||
    root.package !== GOFORGE_PORTABLE_PACKAGE ||
    root.version !== GOFORGE_PORTABLE_VERSION ||
    root.abi !== GOFORGE_ABI_V1
  ) {
    throw new WasmCompatibilityError("component portable manifest identity is incompatible");
  }
  if (bundle.abi !== root.abi || bundle.witPackage !== `${root.package}@${root.version}`) {
    throw new WasmCompatibilityError(
      "release bundle and component portable manifest identify different contracts",
    );
  }

  const operations = root.operations;
  if (!Array.isArray(operations) || operations.length !== GOFORGE_ABI_V1_OPERATIONS.length) {
    throw new WasmCompatibilityError("component portable manifest operation set is incomplete");
  }
  for (let index = 0; index < GOFORGE_ABI_V1_OPERATIONS.length; index++) {
    const expectedName = GOFORGE_ABI_V1_OPERATIONS[index];
    const operation = requireRecord(operations[index], `portable manifest operations[${index}]`);
    requireExactKeys(operation, ["name", "capability"], `portable manifest operations[${index}]`);
    const expectedCapability = GOFORGE_ABI_V1_OPERATION_CAPABILITIES[expectedName];
    if (operation.name !== expectedName || operation.capability !== expectedCapability) {
      throw new WasmCompatibilityError(
        `component portable operation ${JSON.stringify(expectedName)} is incompatible`,
      );
    }
    if (bundle.operations[expectedName].capability !== expectedCapability) {
      throw new WasmCompatibilityError(
        `release bundle operation ${JSON.stringify(expectedName)} drifted from GoForge`,
      );
    }
  }

  const errors = root.errors;
  const expectedErrors = Object.entries(GOFORGE_ABI_ERROR_CATALOG);
  if (!Array.isArray(errors) || errors.length !== expectedErrors.length) {
    throw new WasmCompatibilityError("component portable error catalog is incomplete");
  }
  for (let index = 0; index < expectedErrors.length; index++) {
    const [code, definition] = expectedErrors[index];
    const error = requireRecord(errors[index], `portable manifest errors[${index}]`);
    requireExactKeys(error, ["code", "message", "retryable"], `portable manifest errors[${index}]`);
    if (
      error.code !== code || error.message !== definition.message ||
      error.retryable !== definition.retryable
    ) {
      throw new WasmCompatibilityError(`component portable error ${JSON.stringify(code)} drifted`);
    }
  }

  // These fields are owned by GoForge. Their full shape is validated before accepting the manifest;
  // operation execution still enforces the guest-provided limits.
  if (
    root.encoding === null || typeof root.encoding !== "object" || Array.isArray(root.encoding) ||
    root.limits === null || typeof root.limits !== "object" || Array.isArray(root.limits) ||
    !Array.isArray(root.capabilities)
  ) {
    throw new WasmCompatibilityError("component portable manifest metadata is malformed");
  }
}

function parseManifest(bytes: Uint8Array): WasmBundleManifestV1 {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assertUniqueAbiJsonObjectFields(text);
    value = JSON.parse(text);
  } catch (cause) {
    throw new WasmManifestError("component manifest is not valid UTF-8 JSON", { cause });
  }
  const root = requireRecord(value, "manifest");
  requireExactKeys(root, [
    "schema",
    "abi",
    "componentVersion",
    "witPackage",
    "source",
    "glue",
    "coreModules",
    "capabilities",
    "operations",
  ], "manifest");
  if (root.schema !== GOFORGE_BUNDLE_MANIFEST_SCHEMA_V1) {
    throw new WasmCompatibilityError(
      `unsupported release-bundle schema ${JSON.stringify(root.schema)}`,
    );
  }
  if (root.abi !== GOFORGE_ABI_V1) {
    throw new WasmCompatibilityError(`unsupported portable ABI ${JSON.stringify(root.abi)}`);
  }
  if (typeof root.componentVersion !== "string" || !versionPattern.test(root.componentVersion)) {
    throw new WasmManifestError("componentVersion must be a semantic version");
  }
  if (typeof root.witPackage !== "string" || !witPattern.test(root.witPackage)) {
    throw new WasmManifestError("witPackage must be a versioned namespace:name@x.y.z package");
  }
  const source = parseDescriptor(root.source, "source");
  const glue = parseDescriptor(root.glue, "glue");
  const coreRecord = requireRecord(root.coreModules, "coreModules");
  if (Object.keys(coreRecord).length === 0) {
    throw new WasmManifestError("coreModules must contain at least one module");
  }
  const coreModules: Record<string, WasmArtifactDescriptor> = Object.create(null);
  for (const [name, descriptor] of Object.entries(coreRecord)) {
    if (!name.endsWith(".wasm") || name.includes("/") || name.includes("\\")) {
      throw new WasmManifestError(`invalid generated core module name ${JSON.stringify(name)}`);
    }
    coreModules[name] = parseDescriptor(descriptor, `coreModules.${name}`);
  }
  if (!Array.isArray(root.capabilities) || root.capabilities.length === 0) {
    throw new WasmManifestError("capabilities must be a non-empty array");
  }
  const capabilities = parseUniqueStrings(root.capabilities, capabilityPattern, "capabilities");
  const operationRecord = requireRecord(root.operations, "operations");
  const operationNames = Object.keys(operationRecord).sort();
  const expectedOperationNames = [...GOFORGE_ABI_V1_OPERATIONS].sort();
  if (
    operationNames.length !== expectedOperationNames.length ||
    operationNames.some((name, index) => name !== expectedOperationNames[index])
  ) {
    throw new WasmManifestError(
      "operations must describe every canonical GoForge ABI v1 operation",
    );
  }
  const operations = Object.create(null) as Record<GoforgeAbiOperationV1, WasmOperationContract>;
  for (const name of GOFORGE_ABI_V1_OPERATIONS) {
    const contract = parseOperationContract(operationRecord[name], `operations.${name}`);
    const expectedCapability = GOFORGE_ABI_V1_OPERATION_CAPABILITIES[name];
    if (contract.capability !== expectedCapability) {
      throw new WasmManifestError(
        `operations.${name}.capability must be ${JSON.stringify(expectedCapability)}`,
      );
    }
    if (!capabilities.includes(contract.capability)) {
      throw new WasmManifestError(`operations.${name}.capability is absent from capabilities`);
    }
    operations[name] = contract;
  }
  return {
    schema: GOFORGE_BUNDLE_MANIFEST_SCHEMA_V1,
    abi: GOFORGE_ABI_V1,
    componentVersion: root.componentVersion,
    witPackage: root.witPackage,
    source,
    glue,
    coreModules,
    capabilities,
    operations,
  };
}

function parseDescriptor(value: unknown, path: string): WasmArtifactDescriptor {
  const descriptor = requireRecord(value, path);
  requireExactKeys(descriptor, ["path", "sha256"], path);
  if (typeof descriptor.path !== "string" || typeof descriptor.sha256 !== "string") {
    throw new WasmManifestError(`${path} path and sha256 must be strings`);
  }
  const result = { path: descriptor.path, sha256: descriptor.sha256 };
  validateDescriptor(result, path);
  return result;
}

function parseOperationContract(value: unknown, path: string): WasmOperationContract {
  const contract = requireRecord(value, path);
  const keys = ["capability", "retrySafe", "securitySensitive"];
  if ("nativeAdapters" in contract) keys.push("nativeAdapters");
  requireExactKeys(contract, keys, path);
  if (
    typeof contract.capability !== "string" || !capabilityPattern.test(contract.capability) ||
    typeof contract.retrySafe !== "boolean" || typeof contract.securitySensitive !== "boolean"
  ) {
    throw new WasmManifestError(`${path} capability or flags are invalid`);
  }
  const result: WasmOperationContract = {
    capability: contract.capability,
    retrySafe: contract.retrySafe,
    securitySensitive: contract.securitySensitive,
  };
  if ("nativeAdapters" in contract) {
    if (!Array.isArray(contract.nativeAdapters)) {
      throw new WasmManifestError(`${path}.nativeAdapters must be an array`);
    }
    result.nativeAdapters = parseUniqueStrings(
      contract.nativeAdapters,
      operationPattern,
      `${path}.nativeAdapters`,
    );
  }
  return result;
}

function validateCompatibility(
  manifest: WasmBundleManifestV1,
  compatibility: WasmCompatibility,
): void {
  const schema = compatibility.bundleSchema ?? compatibility.schemaVersion ??
    GOFORGE_BUNDLE_MANIFEST_SCHEMA_V1;
  const abi = compatibility.abi ?? compatibility.abiVersion ?? GOFORGE_ABI_V1;
  if (manifest.schema !== schema) {
    throw new WasmCompatibilityError(
      `release-bundle schema ${manifest.schema} does not match host schema ${schema}`,
    );
  }
  if (manifest.abi !== abi) {
    throw new WasmCompatibilityError(
      `component ABI ${manifest.abi} does not match host ABI ${abi}`,
    );
  }
  if (manifest.componentVersion !== compatibility.componentVersion) {
    throw new WasmCompatibilityError(
      `component ${manifest.componentVersion} does not match host ${compatibility.componentVersion}`,
    );
  }
  if (manifest.witPackage !== compatibility.witPackage) {
    throw new WasmCompatibilityError(
      `WIT package ${manifest.witPackage} does not match host ${compatibility.witPackage}`,
    );
  }
}

function validateDescriptor(descriptor: WasmArtifactDescriptor, path: string): void {
  assertRelativeArtifactPath(descriptor.path, `${path}.path`);
  assertSha256(descriptor.sha256, `${path}.sha256`);
}

function assertRelativeArtifactPath(value: string, path: string): void {
  if (
    value.length === 0 || value.startsWith("/") || value.startsWith("\\") ||
    value.includes(":") || value.includes("?") || value.includes("#") || value.includes("%") ||
    value.includes("\\")
  ) {
    throw new WasmManifestError(`${path} must be a package-relative path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new WasmManifestError(`${path} contains an invalid path segment`);
  }
}

function assertSha256(value: string, path: string): void {
  if (!sha256Pattern.test(value)) {
    throw new WasmManifestError(`${path} must be a lowercase SHA-256 digest`);
  }
}

async function verifyDigest(path: string, bytes: Uint8Array, expected: string): Promise<void> {
  const actual = await sha256Hex(bytes);
  if (actual !== expected) {
    throw new WasmIntegrityError(
      `SHA-256 mismatch for ${JSON.stringify(path)}: expected ${expected}, got ${actual}`,
    );
  }
}

function requireVerified(values: Map<string, Uint8Array>, path: string): Uint8Array {
  const value = values.get(path);
  if (!value) throw new WasmIntegrityError(`verified artifact ${JSON.stringify(path)} is missing`);
  return value;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WasmManifestError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new WasmManifestError(`${path} has unsupported or missing fields`);
  }
}

function parseUniqueStrings(values: unknown[], pattern: RegExp, path: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !pattern.test(value)) {
      throw new WasmManifestError(`${path} contains an invalid name`);
    }
    if (seen.has(value)) throw new WasmManifestError(`${path} contains duplicate ${value}`);
    seen.add(value);
    result.push(value);
  }
  return result;
}

function deepFreezeManifest(manifest: WasmBundleManifestV1): Readonly<WasmBundleManifestV1> {
  Object.freeze(manifest.source);
  Object.freeze(manifest.glue);
  for (const descriptor of Object.values(manifest.coreModules)) Object.freeze(descriptor);
  Object.freeze(manifest.coreModules);
  Object.freeze(manifest.capabilities);
  for (const contract of Object.values(manifest.operations)) {
    if (contract.nativeAdapters) Object.freeze(contract.nativeAdapters);
    Object.freeze(contract);
  }
  Object.freeze(manifest.operations);
  return Object.freeze(manifest);
}
