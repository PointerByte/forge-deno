// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared logger enums.
 *
 * Severities are an ordered numeric union so handlers can compare them
 * (`level >= threshold`).
 */

/** Severity levels, ordered ascending. */
export const LogLevel = {
  Debug: -4,
  Info: 0,
  Warn: 4,
  Error: 8,
} as const;
/** Union of supported logger severity values. */
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

/** Maps a level value to its canonical upper-case name. */
export function levelName(level: LogLevel): string {
  switch (level) {
    case LogLevel.Debug:
      return "DEBUG";
    case LogLevel.Warn:
      return "WARN";
    case LogLevel.Error:
      return "ERROR";
    default:
      return "INFO";
  }
}

/** Parses a textual level (case-insensitive), defaulting to Info. */
export function parseLevel(value: string): LogLevel {
  switch (value.trim().toLowerCase()) {
    case "debug":
      return LogLevel.Debug;
    case "warn":
    case "warning":
      return LogLevel.Warn;
    case "error":
      return LogLevel.Error;
    default:
      return LogLevel.Info;
  }
}
