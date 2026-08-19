// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Value typing and key-path helpers shared by the configuration sources.
 *
 * Configuration files, INI overlays and environment variables all arrive as
 * text, while the settings they feed are booleans, numbers and lists. These
 * helpers hold the single conversion rule the loader applies: a key that an
 * earlier source already declared keeps that type, and a key nobody declared is
 * inferred.
 *
 * Key paths are lower-cased throughout, mirroring forge-go's Viper behaviour,
 * so `traces.SkipPaths` and `traces.skippaths` address the same setting.
 *
 * @module
 */

/** Nested settings tree, keyed by one lower-cased path segment per level. */
export type Settings = Record<string, unknown>;

/** Splits a comma-separated value, dropping blank entries. */
export function splitCommaSeparated(raw: string): string[] {
  if (raw === "") return [];
  return raw.split(",").map((part) => part.trim()).filter((part) => part !== "");
}

/**
 * Types a raw value against the value an earlier source declared, so an
 * overlay never changes the type of an existing setting.
 */
export function parseEnvValue(raw: string, template: unknown): unknown {
  const value = raw.trim();

  if (typeof template === "boolean") {
    const parsed = parseBoolean(value);
    return parsed === undefined ? value : parsed;
  }
  if (typeof template === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (Array.isArray(template)) {
    return parseList(value, template.every((item) => typeof item === "string"));
  }
  return value;
}

/**
 * Infers a type for a value no earlier source declared. Only `true` and
 * `false` become booleans: `1` and `0` stay numbers, because ports, limits and
 * sizes are far more common in this configuration than flags written as digits.
 */
export function inferScalar(raw: string): string | number | boolean {
  const value = raw.trim();
  if (value === "") return "";

  const lower = value.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;

  // Number("") and Number(" ") are 0, and both are already handled above.
  const parsed = Number(value);
  if (Number.isFinite(parsed) && /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(value)) {
    return parsed;
  }
  return value;
}

/**
 * Reads the `[a, b, c]` and comma-separated list forms. `stringsOnly` keeps
 * every entry a string, matching the declared list it is replacing.
 */
export function parseList(value: string, stringsOnly: boolean): unknown[] {
  if (value.startsWith("[")) {
    try {
      const decoded = JSON.parse(value);
      if (Array.isArray(decoded)) {
        return stringsOnly ? decoded.map((item) => String(item)) : decoded;
      }
    } catch {
      // Not JSON: fall through to the bare comma-separated form below.
    }
    if (value.endsWith("]")) {
      const items = splitCommaSeparated(value.slice(1, -1));
      return stringsOnly ? items : items.map((item) => inferScalar(item));
    }
  }

  const items = splitCommaSeparated(value);
  return stringsOnly ? items : items.map((item) => inferScalar(item));
}

/** Parses the boolean spellings forge-go accepts, or undefined when it is not one. */
export function parseBoolean(value: string): boolean | undefined {
  switch (value.trim().toLowerCase()) {
    case "1":
    case "t":
    case "true":
      return true;
    case "0":
    case "f":
    case "false":
      return false;
    default:
      return undefined;
  }
}

/** Builds the environment variable name for a key path: app.name -> APP_NAME. */
export function envNameFromPath(path: string[]): string {
  return path
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => part.toUpperCase())
    .join("_");
}

/** Splits a dotted key into its lower-cased path segments. */
export function splitKey(key: string): string[] {
  return key
    .split(".")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== "");
}

/** Reads the value at a key path, or undefined when the path is not set. */
export function readPath(settings: Settings, path: string[]): unknown {
  let node: unknown = settings;
  for (const part of path) {
    if (!isSettings(node)) return undefined;
    node = node[part];
  }
  return node;
}

/** Writes a value at a key path, creating the intermediate records. */
export function writePath(settings: Settings, path: string[], value: unknown): void {
  if (path.length === 0) return;

  let node = settings;
  for (const part of path.slice(0, -1)) {
    const child = node[part];
    if (isSettings(child)) {
      node = child;
      continue;
    }
    const created: Settings = {};
    node[part] = created;
    node = created;
  }
  node[path[path.length - 1]] = value;
}

/**
 * Merges `source` into `target`, with `source` winning. Records are merged
 * recursively; every other value, lists included, is replaced outright.
 */
export function mergeSettings(target: Settings, source: Settings): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (isSettings(existing) && isSettings(value)) {
      mergeSettings(existing, value);
      continue;
    }
    target[key] = value;
  }
}

/** Walks every leaf of the settings tree, deepest key path first. */
export function forEachLeaf(
  settings: Settings,
  visit: (path: string[], value: unknown) => void,
  path: string[] = [],
): void {
  for (const [key, value] of Object.entries(settings)) {
    const next = [...path, key];
    if (isSettings(value)) {
      forEachLeaf(value, visit, next);
      continue;
    }
    visit(next, value);
  }
}

/** Reports whether a value is a plain record the loader can descend into. */
export function isSettings(value: unknown): value is Settings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Lower-cases every key of a parsed tree so lookups are case-insensitive. */
export function insensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => insensitive(item));
  if (!isSettings(value)) return value;

  const result: Settings = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key.toLowerCase()] = insensitive(nested);
  }
  return result;
}
