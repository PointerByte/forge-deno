// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Log entry formatting (mirrors GoForge `formatter/format.go`).
 *
 * A {@link CustomFormatter} renders a {@link LogFormat} entry according to its
 * template: `"json"` produces the structured JSON layout, `"text"`, `"txt"` or
 * the empty string (the default) produce the human-readable text layout, and
 * any other string is treated as a Go `text/template` with the `json`,
 * `buildDetails` and `buildServices` helpers.
 *
 * @module
 */

import { normalizeLatency, normalizeProcessLatency } from "./latency.ts";
import type { Details, LogFormat, Process } from "./models.ts";

/** Default Go-style timestamp layout (`logger.formatDate` in GoForge). */
export const DEFAULT_FORMAT_DATE = "2006-01-02T15:04:05.000";

/** Creates a {@link CustomFormatter} for the given template (mirrors `New`). */
export function newFormatter(template = ""): CustomFormatter {
  return new CustomFormatter(template);
}

/** Renders {@link LogFormat} entries as JSON, text or a custom template. */
export class CustomFormatter {
  /** Selected built-in format name or custom Go-style template. */
  template: string;

  /** Creates a formatter for JSON, text, or the supplied custom template. */
  constructor(template = "") {
    this.template = template;
  }

  /** Renders `log` according to the configured template. */
  format(log: LogFormat): string {
    switch (this.template.trim().toLowerCase()) {
      case "json":
        return this.formatJSON(log);
      case "text":
      case "txt":
      case "":
        return this.formatText(log);
      default:
        return this.formatTemplate(log);
    }
  }

  /** Renders the canonical JSON layout. */
  formatJSON(log: LogFormat): string {
    return marshalEntry(normalizeLog(log));
  }

  /** Renders the `[ts] [level] [traceID] method:line - message ...` text layout. */
  formatText(log: LogFormat): string {
    log = normalizeLog(log);
    let out = `[${log.timestamp}] [${log.level}] [${log.traceID}] ` +
      `${log.method}:${log.line} - ${log.message}`;

    if (log.latency > 0) out += ` latency=${log.latency}ms`;

    const d = log.details ?? { system: "" };
    const extras = detailExtras(d);
    const hasDetails = Boolean(
      d.system || d.client || d.protocol || d.method || d.path ||
        (d.headers && Object.keys(d.headers).length > 0) ||
        d.request != null || d.response != null || extras.length > 0,
    );
    if (hasDetails) {
      const fields: string[] = [];
      if (d.system) fields.push(`system=${d.system}`);
      if (d.client) fields.push(`client=${d.client}`);
      if (d.protocol) fields.push(`protocol=${d.protocol}`);
      if (d.method) fields.push(`method=${d.method}`);
      if (d.path) fields.push(`path=${d.path}`);
      if (d.headers && Object.keys(d.headers).length > 0) {
        fields.push(`headers=${toJSON(d.headers)}`);
      }
      if (d.request != null) fields.push(`request=${toJSON(d.request)}`);
      if (d.response != null) fields.push(`response=${toJSON(d.response)}`);
      for (const [key, value] of extras) fields.push(`${key}=${textValue(value)}`);
      out += ` | details={${fields.join(", ")}}`;
    }

    const services = log.process ?? [];
    if (services.length > 0) {
      const rendered = services.map((s) => {
        const fields: string[] = [];
        if (s.traceID) fields.push(`traceID=${s.traceID}`);
        if (s.spanID) fields.push(`spanID=${s.spanID}`);
        if (s.system) fields.push(`system=${s.system}`);
        if (s.process) fields.push(`process=${s.process}`);
        if (s.server) fields.push(`server=${s.server}`);
        if (s.protocol) fields.push(`protocol=${s.protocol}`);
        if (s.method) fields.push(`method=${s.method}`);
        if (s.path) fields.push(`path=${s.path}`);
        if (s.code) fields.push(`code=${s.code}`);
        if (s.request != null) fields.push(`request=${toJSON(s.request)}`);
        if (s.response != null) fields.push(`response=${toJSON(s.response)}`);
        if (s.status) fields.push(`status=${s.status}`);
        if (s.latency) fields.push(`latency=${s.latency}ms`);
        return `{${fields.join(", ")}}`;
      });
      out += ` | process=[${rendered.join(", ")}]`;
    }
    return out;
  }

  /** Renders the configured custom template (mirrors `FormatTemplate`). */
  formatTemplate(log: LogFormat): string {
    return executeTemplate(this.template, normalizeLog(log));
  }
}

/**
 * Normalizes `details` into a plain map, dropping empty optional fields
 * (`system` is always kept). Available inside templates as `buildDetails`.
 */
export function buildDetails(d: Details): Record<string, unknown> {
  const out: Record<string, unknown> = { system: d.system ?? "" };
  if (d.client) out.client = d.client;
  if (d.protocol) out.protocol = d.protocol;
  if (d.method) out.method = d.method;
  if (d.path) out.path = d.path;
  if (d.headers && Object.keys(d.headers).length > 0) out.headers = d.headers;
  if (d.request != null) out.request = d.request;
  if (d.response != null) out.response = d.response;
  for (const [key, value] of detailExtras(d)) out[key] = value;
  return sortKeys(out);
}

/**
 * Normalizes the `process` array into plain maps, dropping empty fields.
 * Available inside templates as `buildServices`.
 */
export function buildServices(items: Process[]): Record<string, unknown>[] {
  return (items ?? []).map((s) => {
    const row: Record<string, unknown> = {};
    const latency = normalizeLatency(s.latency);
    if (s.traceID) row.traceID = s.traceID;
    if (s.spanID) row.spanID = s.spanID;
    if (s.system) row.system = s.system;
    if (s.process) row.process = s.process;
    if (s.server) row.server = s.server;
    if (s.protocol) row.protocol = s.protocol;
    if (s.method) row.method = s.method;
    if (s.path) row.path = s.path;
    if (s.code) row.code = s.code;
    if (s.request != null) row.request = s.request;
    if (s.response != null) row.response = s.response;
    if (s.status) row.status = s.status;
    if (latency > 0) row.latency = latency;
    return sortKeys(row);
  });
}

// --- canonical JSON marshalling ----------------------------------------------

const DETAIL_SLOTS = [
  "system",
  "client",
  "protocol",
  "method",
  "path",
  "headers",
  "request",
  "response",
] as const;

function detailExtras(d: Details): Array<[string, unknown]> {
  return Object.entries(d).filter(([key]) => !(DETAIL_SLOTS as readonly string[]).includes(key));
}

/**
 * Serializes an entry with the exact key order and omit-empty semantics of
 * GoForge's `json.Marshal(LogFormat)`: `spanID` and `process` are omitted when
 * empty.
 */
function marshalEntry(log: LogFormat): string {
  const process = log.process ?? [];
  return JSON.stringify({
    level: log.level ?? "",
    timestamp: log.timestamp ?? "",
    traceID: log.traceID ?? "",
    ...(log.spanID ? { spanID: log.spanID } : {}),
    message: log.message ?? "",
    details: marshalDetails(log.details ?? { system: "" }),
    ...(process.length > 0 ? { process: process.map(marshalProcess) } : {}),
    method: log.method ?? "",
    line: log.line ?? 0,
    latency: normalizeLatency(log.latency),
  });
}

function marshalDetails(d: Details): Record<string, unknown> {
  const out: Record<string, unknown> = { system: d.system ?? "" };
  if (d.client) out.client = d.client;
  if (d.protocol) out.protocol = d.protocol;
  if (d.method) out.method = d.method;
  if (d.path) out.path = d.path;
  if (d.headers && Object.keys(d.headers).length > 0) out.headers = d.headers;
  if (d.request != null) out.request = d.request;
  if (d.response != null) out.response = d.response;
  for (const [key, value] of detailExtras(d)) out[key] = value;
  return out;
}

function marshalProcess(s: Process): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (s.traceID) out.traceID = s.traceID;
  if (s.spanID) out.spanID = s.spanID;
  out.system = s.system ?? "";
  out.process = s.process ?? "";
  if (s.server) out.server = s.server;
  if (s.headers != null) out.headers = s.headers;
  if (s.protocol) out.protocol = s.protocol;
  if (s.method) out.method = s.method;
  if (s.code) out.code = s.code;
  if (s.path) out.path = s.path;
  if (s.request != null) out.request = s.request;
  if (s.response != null) out.response = s.response;
  out.status = s.status ?? "";
  out.latency = normalizeLatency(s.latency);
  return out;
}

function normalizeLog(log: LogFormat): LogFormat {
  return {
    ...log,
    latency: normalizeLatency(log.latency),
    process: (log.process ?? []).map(normalizeProcessLatency),
  };
}

function toJSON(v: unknown): string {
  if (v == null) return "";
  const out = JSON.stringify(v);
  return out === undefined ? String(v) : out;
}

function textValue(v: unknown): string {
  if (v == null) return "";
  return typeof v === "string" ? v : toJSON(v);
}

/** Recreates Go's sorted-key map marshalling for template helper outputs. */
function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

// --- Go text/template subset --------------------------------------------------

/** Maps Go `LogFormat` field names to the JSON keys used by the TS models. */
const ROOT_ALIASES: Record<string, string> = { Process: "process" };

const KNOWN_ZERO: Record<string, unknown> = {
  Timestamp: "",
  TraceID: "",
  Level: "",
  Message: "",
  Method: "",
  Line: 0,
  Latency: 0,
  Details: {},
  Process: [],
  System: "",
  Client: "",
  Protocol: "",
  Path: "",
  Headers: undefined,
  Request: undefined,
  Response: undefined,
  SpanID: "",
  Server: "",
  Code: 0,
  Status: "",
};

/**
 * Renders `tpl` against `log` and, like Go, re-normalizes JSON-shaped output
 * back into the canonical entry keys (custom templates cannot rename them).
 */
function executeTemplate(tpl: string, log: LogFormat): string {
  const rendered = renderTemplate(tpl, log).trim();
  try {
    const parsed = JSON.parse(rendered);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return rendered;
    return marshalEntry(coerceEntry(parsed as Record<string, unknown>));
  } catch {
    return rendered;
  }
}

function coerceEntry(parsed: Record<string, unknown>): LogFormat {
  const details = parsed.details;
  const process = parsed.process;
  return {
    level: typeof parsed.level === "string" ? parsed.level : "",
    timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
    traceID: typeof parsed.traceID === "string" ? parsed.traceID : "",
    ...(typeof parsed.spanID === "string" && parsed.spanID ? { spanID: parsed.spanID } : {}),
    message: typeof parsed.message === "string" ? parsed.message : "",
    details: details !== null && typeof details === "object" && !Array.isArray(details)
      ? details as Details
      : { system: "" },
    process: Array.isArray(process) ? process as Process[] : [],
    method: typeof parsed.method === "string" ? parsed.method : "",
    line: typeof parsed.line === "number" ? parsed.line : 0,
    latency: normalizeLatency(parsed.latency),
  };
}

function renderTemplate(tpl: string, log: LogFormat): string {
  let out = "";
  let index = 0;
  while (index < tpl.length) {
    const open = tpl.indexOf("{{", index);
    if (open === -1) {
      out += tpl.slice(index);
      break;
    }
    out += tpl.slice(index, open);
    const close = tpl.indexOf("}}", open + 2);
    if (close === -1) throw new Error(`template: unclosed action in ${JSON.stringify(tpl)}`);
    out += stringifyResult(evalAction(tpl.slice(open + 2, close).trim(), log));
    index = close + 2;
  }
  return out;
}

function stringifyResult(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return toJSON(value);
  return String(value);
}

function evalAction(action: string, log: LogFormat): unknown {
  const tokens = tokenize(action);
  if (tokens.length === 0) throw new Error("template: empty action");
  return evalTokens(tokens, log);
}

function evalTokens(tokens: string[], log: LogFormat): unknown {
  const [head, ...args] = tokens;
  if (head.startsWith(".")) {
    if (args.length > 0) throw new Error(`template: unexpected arguments after ${head}`);
    return resolveField(head, log);
  }
  const fn = TEMPLATE_FUNCS[head];
  if (!fn) throw new Error(`template: function ${JSON.stringify(head)} not defined`);
  if (args.length !== 1) throw new Error(`template: ${head} expects exactly one argument`);
  return fn(evalArg(args[0], log), log);
}

function evalArg(arg: string, log: LogFormat): unknown {
  if (arg.startsWith("(") && arg.endsWith(")")) {
    return evalTokens(tokenize(arg.slice(1, -1).trim()), log);
  }
  if (arg.startsWith(".")) return resolveField(arg, log);
  throw new Error(`template: unexpected argument ${JSON.stringify(arg)}`);
}

const TEMPLATE_FUNCS: Record<string, (value: unknown, log: LogFormat) => unknown> = {
  json: (value, log) => {
    if (value === log) return marshalEntry(log);
    return toJSON(value);
  },
  buildDetails: (value) => buildDetails((value ?? { system: "" }) as Details),
  buildServices: (value) => buildServices((value ?? []) as Process[]),
};

function resolveField(path: string, log: LogFormat): unknown {
  if (path === ".") return log;
  let current: unknown = log;
  for (const segment of path.slice(1).split(".")) {
    if (current === null || typeof current !== "object") {
      throw new Error(`template: can't evaluate field ${segment} in non-object value`);
    }
    const record = current as Record<string, unknown>;
    const lower = segment.charAt(0).toLowerCase() + segment.slice(1);
    if (segment in record) current = record[segment];
    else if (lower in record) current = record[lower];
    else if (current === log && ROOT_ALIASES[segment] !== undefined) {
      current = record[ROOT_ALIASES[segment]];
    } else if (segment in KNOWN_ZERO) current = KNOWN_ZERO[segment];
    else throw new Error(`template: can't evaluate field ${segment}`);
  }
  return current;
}

function tokenize(action: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of action) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (depth < 0) throw new Error(`template: unbalanced parenthesis in ${JSON.stringify(action)}`);
    if (char === " " && depth === 0) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (depth !== 0) throw new Error(`template: unbalanced parenthesis in ${JSON.stringify(action)}`);
  if (current) tokens.push(current);
  return tokens;
}

// --- Go layout timestamps -----------------------------------------------------

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function tzOffset(date: Date, zulu: boolean): string {
  const offset = -date.getTimezoneOffset();
  if (offset === 0 && zulu) return "Z";
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${sign}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`;
}

/** Supported Go layout tokens, longest-match first. */
const LAYOUT_TOKENS: Array<[string, (d: Date) => string]> = [
  ["2006", (d) => pad(d.getFullYear(), 4)],
  [".000000", (d) => `.${pad(d.getMilliseconds(), 3)}000`],
  [".000", (d) => `.${pad(d.getMilliseconds(), 3)}`],
  ["January", (d) => MONTHS_LONG[d.getMonth()]],
  ["Monday", (d) => DAYS_LONG[d.getDay()]],
  ["Z07:00", (d) => tzOffset(d, true)],
  ["-07:00", (d) => tzOffset(d, false)],
  ["Jan", (d) => MONTHS_SHORT[d.getMonth()]],
  ["Mon", (d) => DAYS_SHORT[d.getDay()]],
  ["PM", (d) => (d.getHours() < 12 ? "AM" : "PM")],
  ["pm", (d) => (d.getHours() < 12 ? "am" : "pm")],
  ["15", (d) => pad(d.getHours(), 2)],
  ["06", (d) => pad(d.getFullYear() % 100, 2)],
  ["05", (d) => pad(d.getSeconds(), 2)],
  ["04", (d) => pad(d.getMinutes(), 2)],
  ["03", (d) => pad(d.getHours() % 12 || 12, 2)],
  ["02", (d) => pad(d.getDate(), 2)],
  ["01", (d) => pad(d.getMonth() + 1, 2)],
];

/**
 * Formats `date` (local time) using a Go reference-time layout. Supports the
 * token subset `2006 06 01 02 03 04 05 15 .000 .000000 PM pm Jan January Mon
 * Monday Z07:00 -07:00`; other characters are copied literally.
 */
export function formatTimestamp(date: Date, layout: string = DEFAULT_FORMAT_DATE): string {
  let out = "";
  let index = 0;
  outer: while (index < layout.length) {
    for (const [token, render] of LAYOUT_TOKENS) {
      if (layout.startsWith(token, index)) {
        out += render(date);
        index += token.length;
        continue outer;
      }
    }
    out += layout[index];
    index++;
  }
  return out;
}
