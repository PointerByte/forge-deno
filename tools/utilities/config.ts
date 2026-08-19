// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime configuration loading, ported from forge-go's `utilities.LoadEnv`.
 *
 * An application keeps its settings in a `resources/` directory and reads them
 * through {@link loadEnv}, which resolves that directory, merges every source
 * in a fixed order and hands back a {@link Config} to query:
 *
 * 1. `application.yml`, `application.yaml` or `application.json`
 * 2. `default.ini`
 * 3. `<app.name>.ini`
 * 4. the files listed in `env.files`
 * 5. process environment variables, derived from the key path
 *    (`server.http.port` reads `SERVER_HTTP_PORT`)
 *
 * Each source overrides the previous one, and a key an earlier source declared
 * keeps its type, so an INI overlay can refine a YAML list without turning it
 * into a string. Key lookups are case-insensitive.
 *
 * YAML and `.env` parsers are imported lazily, on the first file that needs
 * them, so an application configured through JSON and INI never resolves them.
 *
 * Requires `--allow-read` for the configuration directory. `--allow-env` is
 * optional: without it, environment overrides are simply not applied.
 *
 * @module
 */

import { parseIni } from "./ini.ts";
import {
  envNameFromPath,
  forEachLeaf,
  insensitive,
  isSettings,
  mergeSettings,
  parseBoolean,
  parseEnvValue,
  readPath,
  type Settings,
  splitCommaSeparated,
  splitKey,
  writePath,
} from "./values.ts";

/** Application file names, in the order forge-go checks them. */
const APPLICATION_FILES = [
  { name: "application.yml", format: "yaml" },
  { name: "application.yaml", format: "yaml" },
  { name: "application.json", format: "json" },
] as const;

/** The shared INI overlay, and the only one discoverable before app.name is known. */
const DEFAULT_INI = "default.ini";
const RESOURCES_DIR = "resources";
const APP_NAME_KEY = "app.name";
const APP_NAME_ENV = "APP_NAME";

/**
 * Read-only view over the merged configuration.
 *
 * Keys are dotted paths (`server.http.port`) and are case-insensitive. Every
 * accessor takes a fallback used when the key is absent or cannot be read as
 * the requested type.
 */
export interface Config {
  /** Returns the raw value at `key`, or undefined when it is not set. */
  get(key: string): unknown;
  /** Returns `key` as text. */
  getString(key: string, fallback?: string): string;
  /** Returns `key` as a number. */
  getNumber(key: string, fallback?: number): number;
  /** Returns `key` as a boolean. */
  getBoolean(key: string, fallback?: boolean): boolean;
  /** Returns `key` as a list of strings, splitting a comma-separated value. */
  getStringList(key: string, fallback?: string[]): string[];
  /** Reports whether `key` is set. */
  has(key: string): boolean;
  /** Overrides `key` in memory, without touching any file. */
  set(key: string, value: unknown): void;
  /** Returns a copy of the whole settings tree. */
  all(): Record<string, unknown>;
}

/** Options accepted by {@link loadEnv}. */
export interface LoadEnvOptions {
  /**
   * Applies environment-variable overrides. Defaults to true; set it to false
   * to load exactly what the files declare.
   */
  environmentOverrides?: boolean;
  /**
   * Writes the values of the loaded `.env` files back to the process
   * environment, the way forge-go's godotenv overload does, so code reading
   * `Deno.env` directly sees them. Defaults to true and is best-effort: it is
   * skipped when `--allow-env` is not granted.
   */
  exportEnvFiles?: boolean;
}

/** Settings loaded from `.env` files, consulted ahead of the process environment. */
type EnvOverlay = Map<string, string>;

let current: Config = createConfig({});

/**
 * Loads the runtime configuration and returns it, also making it the value
 * {@link getConfig} hands out.
 *
 * `prefixPath` controls where the search starts. An empty value uses the
 * current working directory. A directory holding an application file or
 * `default.ini` is used as-is; otherwise the nearest `resources/` directory
 * with one of those files is looked up from `prefixPath` upwards, so a binary
 * started from a nested directory such as `cmd/example` still finds it.
 *
 * Throws when no configuration is found, and when a file it did find is
 * malformed. Missing `.ini` and `.env` files are ignored.
 */
export async function loadEnv(
  prefixPath = "",
  options: LoadEnvOptions = {},
): Promise<Config> {
  const configDir = resolveConfigDir(prefixPath);
  const settings = await readApplicationFile(configDir);

  await loadIniFiles(configDir, settings);
  const overlay = await loadEnvFiles(configDir, settings, options.exportEnvFiles ?? true);

  if (options.environmentOverrides ?? true) applyEnvOverrides(settings, overlay);

  current = createConfig(settings);
  return current;
}

/**
 * Returns the configuration loaded by the last {@link loadEnv} call, or an
 * empty configuration when none has run yet.
 */
export function getConfig(): Config {
  return current;
}

/** Reads the application file, or an empty tree for an INI-only project. */
async function readApplicationFile(configDir: string): Promise<Settings> {
  for (const candidate of APPLICATION_FILES) {
    const content = await readOptionalFile(joinPath(configDir, candidate.name));
    if (content === undefined) continue;

    const parsed = insensitive(
      candidate.format === "yaml"
        ? await parseYaml(content, candidate.name)
        : parseJson(content, candidate.name),
    );
    if (!isSettings(parsed)) {
      throw new Error(`${candidate.name}: expected a mapping of configuration keys`);
    }
    return parsed;
  }

  // A project configured through INI alone has no application file to read, and
  // reporting one as missing would be wrong.
  if (hasIniFile(configDir)) return {};

  throw new Error(
    `no configuration found in ${configDir}: expected one of ` +
      `${APPLICATION_FILES.map((file) => file.name).join(", ")} or ${DEFAULT_INI}`,
  );
}

/**
 * Merges `default.ini` and then `<app.name>.ini`, so the project-specific file
 * always wins over the shared defaults.
 */
async function loadIniFiles(configDir: string, settings: Settings): Promise<void> {
  await mergeIniFile(joinPath(configDir, DEFAULT_INI), DEFAULT_INI, settings);

  // app.name may itself come from default.ini, so it is resolved afterwards.
  const name = applicationIniName(settings);
  if (name === undefined) return;
  await mergeIniFile(joinPath(configDir, name), name, settings);
}

/** Merges one INI file. A missing file is ignored; a malformed one throws. */
async function mergeIniFile(path: string, source: string, settings: Settings): Promise<void> {
  const content = await readOptionalFile(path);
  if (content === undefined) return;

  const parsed = parseIni(content, {
    source,
    declared: (key) => readPath(settings, splitKey(key)),
  });
  mergeSettings(settings, parsed);
}

/**
 * Loads the files listed under `env.files`, returning their values as the
 * overlay consulted ahead of the process environment.
 */
async function loadEnvFiles(
  configDir: string,
  settings: Settings,
  exportToProcess: boolean,
): Promise<EnvOverlay> {
  const overlay: EnvOverlay = new Map();

  const declared = readPath(settings, ["env", "files"]);
  const files = Array.isArray(declared)
    ? declared.map((file) => String(file))
    : typeof declared === "string"
    ? splitCommaSeparated(declared)
    : [];

  for (const file of files) {
    const name = file.trim();
    if (name === "") continue;

    const content = await readOptionalFile(
      isAbsolutePath(name) ? name : joinPath(configDir, name),
    );
    if (content === undefined) continue;

    const { parse } = await import("@std/dotenv");
    for (const [key, value] of Object.entries(parse(content))) {
      overlay.set(key, value);
      if (exportToProcess) trySetEnv(key, value);
    }
  }
  return overlay;
}

/**
 * Overrides every declared key whose environment variable is set, keeping the
 * type the configuration files gave it.
 */
function applyEnvOverrides(settings: Settings, overlay: EnvOverlay): void {
  forEachLeaf(settings, (path, value) => {
    const name = envNameFromPath(path);
    const raw = overlay.get(name) ?? readEnv(name);
    if (raw === undefined) return;
    writePath(settings, path, parseEnvValue(raw, value));
  });
}

/**
 * Returns the INI file named after the application, or undefined when there is
 * none to look for. `APP_NAME` wins over the loaded `app.name` so a deployment
 * can select its overlay the same way it overrides every other key.
 */
function applicationIniName(settings: Settings): string | undefined {
  const fromEnv = iniFileName(readEnv(APP_NAME_ENV));
  if (fromEnv !== undefined) return fromEnv;

  const declared = readPath(settings, splitKey(APP_NAME_KEY));
  return iniFileName(typeof declared === "string" ? declared : undefined);
}

/**
 * Turns an application name into its INI file name. Names holding a path
 * separator are rejected: `app.name` is configuration data, and it must not be
 * able to select a file outside the configuration directory.
 */
function iniFileName(appName: string | undefined): string | undefined {
  const name = appName?.trim() ?? "";
  if (name === "" || name === "." || name === "..") return undefined;
  if (name.includes("/") || name.includes("\\")) return undefined;

  const file = `${name}.ini`;
  // Already merged as the shared overlay.
  return file.toLowerCase() === DEFAULT_INI ? undefined : file;
}

/**
 * Resolves the configuration directory, falling back to `<prefixPath>/resources`
 * so the "not found" error points at the expected location.
 */
function resolveConfigDir(prefixPath: string): string {
  const start = prefixPath.trim() === "" ? currentDirectory() : prefixPath;
  if (hasConfigFiles(start)) return start;

  const resources = findResourcesDir(start);
  if (resources !== undefined) return resources;

  return joinPath(start, RESOURCES_DIR);
}

/** Walks upwards looking for the nearest usable `resources/` directory. */
function findResourcesDir(start: string): string | undefined {
  let directory = isAbsolutePath(start) ? start : joinPath(currentDirectory(), start);

  while (directory !== "") {
    const candidate = joinPath(directory, RESOURCES_DIR);
    if (hasConfigFiles(candidate)) return candidate;

    const parent = parentPath(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

/** Reports whether a directory holds configuration this loader can read. */
function hasConfigFiles(directory: string): boolean {
  return APPLICATION_FILES.some((file) => fileExists(joinPath(directory, file.name))) ||
    hasIniFile(directory);
}

/**
 * Reports whether a directory holds an INI file discoverable before anything is
 * loaded: `default.ini`, or the file named by `APP_NAME`. `<app.name>.ini`
 * alone cannot make a directory discoverable, because the name is only known
 * once a file has been read.
 */
function hasIniFile(directory: string): boolean {
  if (fileExists(joinPath(directory, DEFAULT_INI))) return true;

  const name = iniFileName(readEnv(APP_NAME_ENV));
  return name !== undefined && fileExists(joinPath(directory, name));
}

/** Parses YAML through the lazily imported standard-library codec. */
async function parseYaml(content: string, source: string): Promise<unknown> {
  const { parse } = await import("@std/yaml");
  try {
    return parse(content) ?? {};
  } catch (cause) {
    throw new Error(`${source}: ${(cause as Error).message}`, { cause });
  }
}

/** Parses JSON, naming the file when it is malformed. */
function parseJson(content: string, source: string): unknown {
  try {
    return JSON.parse(content);
  } catch (cause) {
    throw new Error(`${source}: ${(cause as Error).message}`, { cause });
  }
}

/** Reads a file, returning undefined when it does not exist. */
async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return undefined;
    throw cause;
  }
}

/** Reports whether a path exists and is readable. */
function fileExists(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/** Reads an environment variable, treating a missing permission as unset. */
function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/** Writes an environment variable, ignoring a missing permission. */
function trySetEnv(name: string, value: string): void {
  try {
    Deno.env.set(name, value);
  } catch {
    // --allow-env is optional: the overlay still carries the value.
  }
}

/** Returns the working directory, or "" when it cannot be read. */
function currentDirectory(): string {
  try {
    return Deno.cwd();
  } catch {
    return "";
  }
}

/** Joins a directory and a name with a single separator. */
function joinPath(directory: string, name: string): string {
  if (directory === "") return name;
  return `${directory.replace(/[\/\\]+$/, "")}/${name}`;
}

/** Returns the parent directory, or the input itself once at the root. */
function parentPath(directory: string): string {
  const trimmed = directory.replace(/[\/\\]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0) return trimmed;
  if (index === 0) return "/";
  return trimmed.slice(0, index);
}

/** Reports whether a path is absolute, on POSIX or Windows. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\/\\]/.test(path);
}

/** Builds a {@link Config} backed by an already merged settings tree. */
function createConfig(settings: Settings): Config {
  return {
    get(key) {
      return readPath(settings, splitKey(key));
    },
    getString(key, fallback = "") {
      const value = readPath(settings, splitKey(key));
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      return fallback;
    },
    getNumber(key, fallback = 0) {
      const value = readPath(settings, splitKey(key));
      if (typeof value === "number") return value;
      if (typeof value === "boolean") return value ? 1 : 0;
      if (typeof value === "string") {
        const parsed = Number(value.trim());
        if (value.trim() !== "" && Number.isFinite(parsed)) return parsed;
      }
      return fallback;
    },
    getBoolean(key, fallback = false) {
      const value = readPath(settings, splitKey(key));
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value !== 0;
      if (typeof value === "string") return parseBoolean(value) ?? fallback;
      return fallback;
    },
    getStringList(key, fallback = []) {
      const value = readPath(settings, splitKey(key));
      if (Array.isArray(value)) return value.map((item) => String(item));
      if (typeof value === "string") return splitCommaSeparated(value);
      return fallback;
    },
    has(key) {
      return readPath(settings, splitKey(key)) !== undefined;
    },
    set(key, value) {
      writePath(settings, splitKey(key), value);
    },
    all() {
      return structuredClone(settings);
    },
  };
}
