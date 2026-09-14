// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Structured logger and its public builder API.
 *
 * Every log call is rendered as a GoForge-compatible {@link LogFormat} entry
 * (`{level, timestamp, traceID, spanID, message, details, process, method,
 * line, latency}`) and written to a pluggable {@link Sink} (the console by default).
 * The output layout is selected with the `formatter` option exactly like
 * GoForge's `logger.formatter` key: `"json"`, `"text"`/`"txt"`/`""` (default)
 * or a custom template.
 *
 * @module
 */

import { levelName, LogLevel } from "../common/enums.ts";
import {
  type CustomFormatter,
  DEFAULT_FORMAT_DATE,
  formatTimestamp,
  newFormatter,
} from "../formatter/format.ts";
import { normalizeLatency, normalizeProcessLatency } from "../formatter/latency.ts";
import type { Details, LogFormat, Process } from "../formatter/models.ts";
import { newSanitizer, type Sanitizer } from "../sanitizer/sanitizer.ts";
import { newFileSink, type RotateOptions } from "../sink/file.ts";
import { activeSpanContext } from "../../telemetry/mod.ts";

/** Destination for a formatted log line. */
export type Sink = (line: string) => void;

/** Options accepted by {@link initLogger} / {@link Logger}. */
export interface LoggerOptions {
  /** Minimum level to emit. Defaults to {@link LogLevel.Info}. */
  level?: LogLevel;
  /**
   * Output format (mirrors GoForge `logger.formatter`): `"json"`, `"text"`,
   * `"txt"` or `""` (text, the default), or a custom template such as
   * `"{{.Level}} | {{.Message}}"`.
   */
  formatter?: string;
  /**
   * Go-style timestamp layout (mirrors GoForge `logger.formatDate`).
   * Defaults to `"2006-01-02T15:04:05.000"` (local time).
   */
  formatDate?: string;
  /**
   * Optional sanitizer used to redact sensitive values. When omitted, the
   * logger reads `LOGGER_SENSIBLEKEYS`.
   */
  sanitizer?: Sanitizer;
  /** Header names omitted from any `headers` attribute. Compared case-insensitively. */
  ignoredHeaders?: string[];
  /** Where formatted lines go. Defaults to `console.log`. */
  sink?: Sink;
  /**
   * Directory for the log file (`logger.dir`). File output is enabled only
   * when `rotate.enable` is true. Ignored when `sink` is provided.
   */
  dir?: string;
  /**
   * File name inside `dir`. Defaults to `<service.name>.log` (or
   * `denoforge.log` when the service has no name). Ignored when `sink` is
   * provided.
   */
  fileName?: string;
  /** File rotation policy (`logger.rotate`). Ignored when `sink` is provided. */
  rotate?: RotateOptions;
  /** Service metadata; `name` becomes `details.system` (GoForge `app.name`). */
  service?: {
    /** Service identifier recorded as `details.system`. */
    name?: string;
    /** Service version recorded alongside the name. */
    version?: string;
  };
  /** Attributes attached to every record produced by this logger. */
  base?: Record<string, unknown>;
}

let testMode = false;

/** Enables logger test mode; suppresses all output (mirrors `EnableModeTest`). */
export function enableModeTest(): void {
  testMode = true;
}

/** Disables logger test mode (mirrors `DisableModeTest`). */
export function disableModeTest(): void {
  testMode = false;
}

/** Attribute keys lifted to the top level of the entry. */
const TOP_LEVEL_ATTRS = ["traceID", "spanID", "latency", "services", "process"] as const;
const DEFAULT_CALLER_SKIP_FILES = new Set(["logging.ts"]);
/** Attribute keys mapped onto their canonical `details` slot. */
const DETAIL_ATTRS = [
  "system",
  "client",
  "protocol",
  "method",
  "path",
  "headers",
  "request",
  "response",
] as const;

/** Leveled, structured logger. Create one with {@link initLogger}. */
export class Logger {
  #level: LogLevel;
  #formatter: CustomFormatter;
  #formatDate: string;
  #sanitizer: Sanitizer;
  #ignoredHeaders: Set<string>;
  #sink: Sink;
  #system: string;
  #base: Record<string, unknown>;

  /** Creates a logger configured with the supplied level, format, sanitizer, and sink. */
  constructor(options: LoggerOptions = {}) {
    this.#level = options.level ?? LogLevel.Info;
    this.#formatter = newFormatter(options.formatter ?? "");
    this.#formatDate = options.formatDate ?? DEFAULT_FORMAT_DATE;
    this.#sanitizer = options.sanitizer ?? newSanitizer();
    this.#ignoredHeaders = normalizeIgnoredHeaders(options.ignoredHeaders ?? []);
    this.#system = options.service?.name ?? "";
    this.#sink = resolveSink(options, this.#system);
    this.#base = options.base ?? {};
  }

  /** Returns a child logger with additional always-on attributes. */
  with(attrs: Record<string, unknown>): Logger {
    const child = new Logger({ sanitizer: this.#sanitizer, sink: this.#sink });
    child.#level = this.#level;
    child.#formatter = this.#formatter;
    child.#formatDate = this.#formatDate;
    child.#sanitizer = this.#sanitizer;
    child.#ignoredHeaders = this.#ignoredHeaders;
    child.#sink = this.#sink;
    child.#system = this.#system;
    child.#base = { ...this.#base, ...attrs };
    return child;
  }

  /** Emits a debug-level record when debug logging is enabled. */
  debug(message: string, attrs: Record<string, unknown> = {}): void {
    this.#log(LogLevel.Debug, message, attrs);
  }
  /** Emits an info-level record when info logging is enabled. */
  info(message: string, attrs: Record<string, unknown> = {}): void {
    this.#log(LogLevel.Info, message, attrs);
  }
  /** Emits a warning-level record when warning logging is enabled. */
  warn(message: string, attrs: Record<string, unknown> = {}): void {
    this.#log(LogLevel.Warn, message, attrs);
  }
  /** Emits an error-level record when error logging is enabled. */
  error(message: string, attrs: Record<string, unknown> = {}): void {
    this.#log(LogLevel.Error, message, attrs);
  }

  /** True when a record at `level` would be emitted (mirrors `Enabled`). */
  enabled(level: LogLevel): boolean {
    return !testMode && level >= this.#level;
  }

  #log(level: LogLevel, message: string, attrs: Record<string, unknown>): void {
    if (!this.enabled(level)) return;
    let merged: Record<string, unknown> = { ...this.#base, ...attrs };
    merged = omitIgnoredHeaders(merged, this.#ignoredHeaders) as Record<string, unknown>;

    const caller = traceCaller();
    let entry = this.#buildEntry(level, message, merged, caller);
    entry = this.#sanitizer.value(entry) as LogFormat;
    this.#sink(this.#formatter.format(entry));
  }

  #buildEntry(
    level: LogLevel,
    message: string,
    attrs: Record<string, unknown>,
    caller: { method: string; line: number },
  ): LogFormat {
    const spanContext = activeSpanContext();
    const details: Record<string, unknown> = {
      system: typeof attrs.system === "string" && attrs.system ? attrs.system : this.#system,
    };
    for (const slot of DETAIL_ATTRS) {
      if (slot === "system" || attrs[slot] === undefined) continue;
      details[slot] = slot === "headers" ? normalizeHeaders(attrs.headers) : attrs[slot];
    }
    for (const [key, value] of Object.entries(attrs)) {
      if ((DETAIL_ATTRS as readonly string[]).includes(key)) continue;
      if ((TOP_LEVEL_ATTRS as readonly string[]).includes(key)) continue;
      details[key] = value;
    }

    const services = attrs.services ?? attrs.process;
    return {
      level: levelName(level),
      timestamp: formatTimestamp(new Date(), this.#formatDate),
      traceID: typeof attrs.traceID === "string" ? attrs.traceID : spanContext?.traceId ?? "",
      ...(typeof attrs.spanID === "string"
        ? (attrs.spanID ? { spanID: attrs.spanID } : {})
        : spanContext?.spanId
        ? { spanID: spanContext.spanId }
        : {}),
      message,
      details: details as Details,
      process: Array.isArray(services) ? (services as Process[]).map(normalizeProcessLatency) : [],
      method: caller.method,
      line: caller.line,
      latency: normalizeLatency(attrs.latency),
    };
  }
}

/**
 * Resolves the calling function and line from the stack, skipping logger
 * frames (the Deno analogue of GoForge's `utilities.TraceCaller`).
 */
function traceCaller(): { method: string; line: number } {
  const stack = new Error().stack;
  if (!stack) return { method: "unknown", line: 0 };
  let fallback: { method: string; line: number } | undefined;
  for (const frame of stack.split("\n").slice(1)) {
    const match = frame.match(/^\s*at\s+(?:async\s+)?(?:(.+?)\s+\()?(.+?):(\d+):\d+\)?$/);
    if (!match) continue;
    const [, name, file, line] = match;
    if (isLoggerInternalFrame(file)) continue;
    const caller = { method: name ?? fileBaseName(file), line: Number(line) };
    fallback ??= caller;
    if (shouldSkipCallerFile(file)) continue;
    return caller;
  }
  return fallback ?? { method: "unknown", line: 0 };
}

function isLoggerInternalFrame(file: string): boolean {
  return file.includes("/logger/builder/builder.ts") ||
    file.includes("\\logger\\builder\\builder.ts");
}

function shouldSkipCallerFile(file: string): boolean {
  return DEFAULT_CALLER_SKIP_FILES.has(fileBaseName(file));
}

function fileBaseName(file: string): string {
  const normalized = file.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function normalizeHeaders(value: unknown): unknown {
  if (value instanceof Headers) return Object.fromEntries(value.entries());
  return value;
}

function normalizeIgnoredHeaders(headers: string[]): Set<string> {
  return new Set(headers.map((header) => header.trim().toLowerCase()).filter(Boolean));
}

function omitIgnoredHeaders(value: unknown, ignoredHeaders: Set<string>): unknown {
  if (ignoredHeaders.size === 0) return value;
  return omitIgnoredHeadersValue(value, ignoredHeaders, false);
}

function omitIgnoredHeadersValue(
  value: unknown,
  ignoredHeaders: Set<string>,
  isHeadersAttribute: boolean,
): unknown {
  if (value instanceof Headers) {
    return filterHeaderEntries([...value.entries()], ignoredHeaders);
  }
  if (Array.isArray(value)) {
    return value.map((item) => omitIgnoredHeadersValue(item, ignoredHeaders, false));
  }
  if (!isRecord(value)) return value;

  if (isHeadersAttribute) {
    return filterHeaderEntries(Object.entries(value), ignoredHeaders);
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = omitIgnoredHeadersValue(val, ignoredHeaders, key.toLowerCase() === "headers");
  }
  return out;
}

function filterHeaderEntries(
  entries: Array<[string, unknown]>,
  ignoredHeaders: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of entries) {
    if (ignoredHeaders.has(key.toLowerCase())) continue;
    out[key] = val;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function resolveSink(options: LoggerOptions, serviceName: string): Sink {
  if (options.sink) return options.sink;
  if (options.dir?.trim() && options.rotate?.enable) {
    return newFileSink({
      dir: options.dir,
      fileName: options.fileName?.trim() || `${serviceName || "denoforge"}.log`,
      rotate: options.rotate,
    });
  }
  return (line) => console.log(line);
}

/**
 * Builds and returns a configured {@link Logger} (the Deno analogue of
 * `InitLogger`). Unlike Go it does not return a shutdown handle because there is
 * no OTLP provider to flush; if you supply a buffering sink, flush it yourself.
 */
export function initLogger(options: LoggerOptions = {}): Logger {
  return new Logger(options);
}

export { LogLevel };
