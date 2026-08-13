// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Redacts sensitive values from log output.
 *
 * Recurses over a structured value (objects, arrays, `Headers`, strings that
 * parse as JSON) and replaces any property whose key matches a sensitive name
 * with `[REDACTED]`. Matching is case-insensitive and substring-based.
 *
 * @module
 */

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 32;

/**
 * Reads the GoForge-compatible `logger.sensibleKeys` override from
 * `LOGGER_SENSIBLEKEYS`. JSON arrays and comma-separated values are accepted.
 * An absent or empty variable produces an empty list.
 */
export function sensibleKeysFromEnv(): string[] {
  const raw = Deno.env.get("LOGGER_SENSIBLEKEYS")?.trim() ?? "";
  if (!raw) return [];

  if (raw.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
        return normalizeSensitiveKeys(parsed);
      }
    } catch {
      // Match GoForge: malformed JSON falls back to comma-separated parsing.
    }
  }
  return normalizeSensitiveKeys(raw.split(","));
}

/** Sanitizes values by redacting properties that match sensitive key names. */
export class Sanitizer {
  readonly #keys: string[];

  /**
   * Creates a sanitizer from a list of sensitive key names.
   *
   * Omitting the list reads `LOGGER_SENSIBLEKEYS`; passing a list uses exactly
   * those keys without built-in defaults.
   */
  constructor(sensitiveKeys: readonly string[] = sensibleKeysFromEnv()) {
    this.#keys = normalizeSensitiveKeys(sensitiveKeys);
  }

  /** True when `key` contains any configured sensitive name (case-insensitive). */
  #isSensitive(key: string): boolean {
    const lower = key.toLowerCase();
    return this.#keys.some((sensitive) => lower.includes(sensitive));
  }

  /**
   * Returns a redacted deep copy of `value`. Strings that contain JSON are
   * parsed, sanitized and re-stringified so secrets embedded in serialized
   * payloads are caught too.
   */
  value(value: unknown): unknown {
    return this.#redact(value, 0);
  }

  /** Convenience wrapper for log detail maps. */
  details(details: Record<string, unknown>): Record<string, unknown> {
    return this.#redact(details, 0) as Record<string, unknown>;
  }

  /** Alias for {@link Sanitizer.value}. */
  service(value: unknown): unknown {
    return this.value(value);
  }

  /** Returns a redacted plain-object copy of the given headers. */
  headers(headers: Headers | Record<string, string>): Record<string, string> {
    const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
    const out: Record<string, string> = {};
    for (const [key, val] of entries) {
      out[key] = this.#isSensitive(key) ? REDACTED : val;
    }
    return out;
  }

  /** Sanitizes a string that may itself contain a JSON document. */
  logFormat(line: string): string {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.stringify(this.#redact(JSON.parse(trimmed), 0));
      } catch {
        return line;
      }
    }
    return line;
  }

  #redact(value: unknown, depth: number): unknown {
    if (depth >= MAX_DEPTH || value === null || value === undefined) return value;

    if (value instanceof Headers) return this.headers(value);

    if (Array.isArray(value)) {
      return value.map((item) => this.#redact(item, depth + 1));
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          return JSON.stringify(this.#redact(JSON.parse(trimmed), depth + 1));
        } catch {
          return value;
        }
      }
      return value;
    }

    if (typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        out[key] = this.#isSensitive(key) ? REDACTED : this.#redact(val, depth + 1);
      }
      return out;
    }

    return value;
  }
}

/**
 * Constructs a {@link Sanitizer}. Omitting `sensitiveKeys` reads
 * `LOGGER_SENSIBLEKEYS`; passing a list uses exactly those values.
 */
export function newSanitizer(sensitiveKeys: readonly string[] = sensibleKeysFromEnv()): Sanitizer {
  return new Sanitizer(sensitiveKeys);
}

function normalizeSensitiveKeys(sensitiveKeys: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const key of sensitiveKeys) {
    const value = key.trim().toLowerCase();
    if (value) normalized.add(value);
  }
  return [...normalized];
}
