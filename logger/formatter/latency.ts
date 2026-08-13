// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/** Normalizes latency values to finite, non-negative integer milliseconds. */
export function normalizeLatency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

/** Normalizes a process/service latency when that field is present. */
export function normalizeProcessLatency<T>(item: T): T {
  if (item === null || typeof item !== "object" || !("latency" in item)) return item;
  const record = item as Record<string, unknown>;
  return { ...record, latency: normalizeLatency(record.latency) } as T;
}
