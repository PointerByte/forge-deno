// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * INI parsing for the configuration loader.
 *
 * Mirrors forge-go's `tools/utilities` INI reader so `default.ini` and
 * `<app.name>.ini` mean the same thing in both runtimes: section headers and
 * dotted keys build the same key path, values are typed against whatever an
 * earlier source declared, and a malformed file raises instead of loading
 * partially.
 *
 * @module
 */

import {
  inferScalar,
  parseEnvValue,
  parseList,
  type Settings,
  splitKey,
  writePath,
} from "./values.ts";

/** Options accepted by {@link parseIni}. */
export interface ParseIniOptions {
  /**
   * Returns the value an earlier source declared for a dotted key, so the
   * overlay can keep that type. Defaults to "nothing was declared".
   */
  declared?: (key: string) => unknown;
  /** File name used in error messages. */
  source?: string;
}

/**
 * Parses INI content into the nested settings tree the loader merges.
 *
 * Section headers and dotted keys build the same key path, so `[server.gin]`
 * with `port` and `[server]` with `gin.port` both produce `server.gin.port`,
 * and an empty `[]` header returns to the root. Quoting a value keeps it a
 * string, `[a, b]` declares a list, and repeating a key appends to one.
 * Comments start with `;` or `#` at the beginning of a line, or after
 * whitespace on an unquoted value.
 */
export function parseIni(content: string, options: ParseIniOptions = {}): Settings {
  const declared = options.declared ?? (() => undefined);
  const settings: Settings = {};
  let section: string[] = [];

  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index].trim();
    if (text === "" || text.startsWith(";") || text.startsWith("#")) continue;

    const at = (message: string) => iniError(options.source, index + 1, message);

    if (text.startsWith("[")) {
      section = parseSection(text, at);
      continue;
    }

    const separator = text.indexOf("=");
    if (separator < 0) {
      throw at(`expected [section] or key = value, got ${JSON.stringify(text)}`);
    }

    const leaf = splitKey(text.slice(0, separator));
    if (leaf.length === 0) {
      throw at(`missing key name in ${JSON.stringify(text)}`);
    }

    const path = [...section, ...leaf];
    const value = parseIniValue(text.slice(separator + 1), declared(path.join(".")));
    setIniValue(settings, path, value);
  }

  return settings;
}

/** Builds the error a malformed line raises, naming the file when it is known. */
function iniError(source: string | undefined, line: number, message: string): Error {
  const where = source === undefined ? `line ${line}` : `${source}: line ${line}`;
  return new Error(`${where}: ${message}`);
}

/** Reads a `[section]` header into a key path. An empty `[]` returns to the root. */
function parseSection(text: string, at: (message: string) => Error): string[] {
  const end = text.indexOf("]");
  if (end < 0) throw at(`unterminated section header ${JSON.stringify(text)}`);

  const rest = text.slice(end + 1).trim();
  if (rest !== "" && !rest.startsWith(";") && !rest.startsWith("#")) {
    throw at(`unexpected ${JSON.stringify(rest)} after section header`);
  }
  return splitKey(text.slice(1, end));
}

/**
 * Stores a value at a key path. Repeating a key inside one file appends to a
 * list instead of replacing the first value.
 */
function setIniValue(settings: Settings, path: string[], value: unknown): void {
  const existing = readExisting(settings, path);
  if (existing === undefined) {
    writePath(settings, path, value);
    return;
  }
  writePath(settings, path, [...asList(existing), ...asList(value)]);
}

/** Reads the value already stored at a path within the file being parsed. */
function readExisting(settings: Settings, path: string[]): unknown {
  let node: unknown = settings;
  for (const part of path) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
    node = (node as Settings)[part];
  }
  return node;
}

/** Normalizes a value into the list form repeated keys build. */
function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Converts one raw INI value into the type the settings tree should hold.
 * A key an earlier source already declared reuses that type; a new key is
 * inferred.
 */
function parseIniValue(raw: string, template: unknown): unknown {
  const { value, quoted } = trimIniValue(raw);
  if (quoted) return value;

  if (value.startsWith("[") && value.endsWith("]")) {
    return parseList(value, false);
  }
  if (template !== undefined && template !== null) {
    return parseEnvValue(value, template);
  }
  return inferScalar(value);
}

/**
 * Removes surrounding whitespace, one matching pair of quotes and any trailing
 * comment. A quoted value stays a string regardless of its contents.
 */
function trimIniValue(raw: string): { value: string; quoted: boolean } {
  const value = raw.trim();
  if (value === "") return { value: "", quoted: false };

  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    if (end >= 0) return { value: value.slice(1, end), quoted: true };
  }
  return { value: stripComment(value).trim(), quoted: false };
}

/**
 * Removes a trailing `;` or `#` comment. The marker must follow whitespace, so
 * values that embed one, such as a password or a colour, survive intact.
 */
function stripComment(value: string): string {
  for (let index = 1; index < value.length; index++) {
    const char = value[index];
    if (char !== ";" && char !== "#") continue;

    const previous = value[index - 1];
    if (previous === " " || previous === "\t") return value.slice(0, index);
  }
  return value;
}
