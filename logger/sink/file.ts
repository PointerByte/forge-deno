// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Synchronous file sink with optional lumberjack-compatible rotation.
 *
 * @module
 */

import type { Sink } from "../builder/builder.ts";

const DEFAULT_MAX_SIZE_MB = 10;
const DEFAULT_MAX_BACKUPS = 5;
const DEFAULT_MAX_AGE_DAYS = 30;
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

/** Rotation policy mirroring GoForge's `logger.rotate` configuration. */
export interface RotateOptions {
  /** Enables rotation. Defaults to `false`. */
  enable?: boolean;
  /** Maximum active-file size in megabytes. Defaults to `10`. */
  maxSize?: number;
  /** Maximum rotated files to retain; `0` retains all. Defaults to `5`. */
  maxBackups?: number;
  /** Maximum backup age in days; `0` disables expiry. Defaults to `30`. */
  maxAge?: number;
  /** Gzip rotated files in a background task. Defaults to `false`. */
  compress?: boolean;
}

/** Options for {@link newFileSink}. */
export interface FileSinkOptions {
  /** Directory that contains the active log file. */
  dir: string;
  /** File name inside `dir`. */
  fileName: string;
  /** Optional rotation policy. */
  rotate?: RotateOptions;
  /**
   * Additional destination. Defaults to `console.log`, matching GoForge's
   * stdout/file tee. Pass `false` to write only to the file.
   */
  tee?: Sink | false;
}

interface FileSinkState {
  active: boolean;
  currentSize: number;
  lastRotationTime: number;
}

interface ResolvedRotation {
  enable: boolean;
  maxSizeBytes: number;
  maxBackups: number;
  maxAge: number;
  compress: boolean;
}

/**
 * Creates a synchronous file sink.
 *
 * File failures never escape into the calling application. The sink reports
 * each distinct failure once and falls back to its tee (stdout by default).
 * Constructing this sink explicitly always enables file output; `rotate.enable`
 * controls rotation only. {@link LoggerOptions} additionally uses
 * `rotate.enable` to decide whether its `dir` shorthand enables file output.
 */
export function newFileSink(options: FileSinkOptions): Sink {
  const reportedFailures = new Set<string>();
  const reportFailure = (operation: string, error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `[denoforge/logger] ${operation}: ${detail}`;
    if (reportedFailures.has(message)) return;
    reportedFailures.add(message);
    console.error(message);
  };

  const tee: Sink | undefined = options.tee === false
    ? undefined
    : options.tee ?? ((line) => console.log(line));
  const rotation = resolveRotation(options.rotate);
  const state: FileSinkState = {
    active: false,
    currentSize: 0,
    lastRotationTime: 0,
  };

  let activePath = "";
  let backupPrefix = "";
  try {
    const fileName = normalizeFileName(options.fileName);
    activePath = joinPath(options.dir, fileName);
    backupPrefix = `${stripLogExtension(fileName)}-`;
    prepareActiveFile(options.dir, activePath);
    state.currentSize = Deno.statSync(activePath).size;
    state.active = true;
  } catch (error) {
    reportFailure("file sink unavailable; using stdout", error);
  }

  return (line: string): void => {
    const bytes = new TextEncoder().encode(`${line}\n`);
    let wroteToFile = false;

    if (state.active) {
      try {
        if (
          rotation.enable &&
          state.currentSize > 0 &&
          state.currentSize + bytes.byteLength > rotation.maxSizeBytes
        ) {
          rotateActiveFile(
            options.dir,
            activePath,
            backupPrefix,
            rotation,
            state,
            reportFailure,
          );
        }
        appendBytes(activePath, bytes);
        state.currentSize += bytes.byteLength;
        wroteToFile = true;
      } catch (error) {
        state.active = false;
        reportFailure("file write failed; using stdout", error);
      }
    }

    if (tee) {
      tee(line);
    } else if (!wroteToFile) {
      console.log(line);
    }
  };
}

function resolveRotation(options: RotateOptions = {}): ResolvedRotation {
  const maxSize = Number.isFinite(options.maxSize) && (options.maxSize ?? 0) > 0
    ? options.maxSize!
    : DEFAULT_MAX_SIZE_MB;
  return {
    enable: options.enable ?? false,
    maxSizeBytes: Math.max(1, Math.floor(maxSize * 1024 * 1024)),
    maxBackups: nonNegativeInteger(options.maxBackups, DEFAULT_MAX_BACKUPS),
    maxAge: nonNegativeInteger(options.maxAge, DEFAULT_MAX_AGE_DAYS),
    compress: options.compress ?? false,
  };
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value >= 0 ? Math.floor(value) : fallback;
}

function normalizeFileName(fileName: string): string {
  const normalized = fileName.trim();
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\")
  ) {
    throw new TypeError("fileName must be a file name inside dir");
  }
  return normalized;
}

function joinPath(dir: string, fileName: string): string {
  if (!dir.trim()) throw new TypeError("dir must not be empty");
  return /[/\\]$/.test(dir) ? `${dir}${fileName}` : `${dir}/${fileName}`;
}

function stripLogExtension(fileName: string): string {
  return fileName.toLowerCase().endsWith(".log") ? fileName.slice(0, -4) : fileName;
}

function prepareActiveFile(dir: string, activePath: string): void {
  Deno.mkdirSync(dir, { recursive: true, mode: DIRECTORY_MODE });
  Deno.chmodSync(dir, DIRECTORY_MODE);
  const file = Deno.openSync(activePath, {
    append: true,
    create: true,
    write: true,
    mode: FILE_MODE,
  });
  file.close();
  Deno.chmodSync(activePath, FILE_MODE);
}

function appendBytes(path: string, bytes: Uint8Array): void {
  const file = Deno.openSync(path, { append: true, create: true, write: true, mode: FILE_MODE });
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += file.writeSync(bytes.subarray(offset));
    }
  } finally {
    file.close();
  }
}

function rotateActiveFile(
  dir: string,
  activePath: string,
  backupPrefix: string,
  rotation: ResolvedRotation,
  state: FileSinkState,
  reportFailure: (operation: string, error: unknown) => void,
): void {
  const backupPath = nextBackupPath(dir, backupPrefix, state);
  Deno.renameSync(activePath, backupPath);
  prepareActiveFile(dir, activePath);
  state.currentSize = 0;

  pruneBackups(dir, backupPrefix, rotation, reportFailure);
  if (rotation.compress) {
    queueMicrotask(() => {
      void compressBackup(backupPath)
        .then(() => pruneBackups(dir, backupPrefix, rotation, reportFailure))
        .catch((error) => reportFailure("backup compression failed; keeping plain backup", error));
    });
  }
}

function nextBackupPath(dir: string, prefix: string, state: FileSinkState): string {
  const now = Date.now();
  state.lastRotationTime = Math.max(now, state.lastRotationTime + 1);
  while (true) {
    const timestamp = new Date(state.lastRotationTime).toISOString()
      .replace("Z", "")
      .replaceAll(":", "-");
    const candidate = joinPath(dir, `${prefix}${timestamp}.log`);
    try {
      Deno.lstatSync(candidate);
      state.lastRotationTime++;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return candidate;
      throw error;
    }
  }
}

interface Backup {
  path: string;
  modified: number;
}

function pruneBackups(
  dir: string,
  prefix: string,
  rotation: ResolvedRotation,
  reportFailure: (operation: string, error: unknown) => void,
): void {
  let backups: Backup[];
  try {
    backups = listBackups(dir, prefix);
  } catch (error) {
    reportFailure("backup retention scan failed", error);
    return;
  }

  if (rotation.maxAge > 0) {
    const cutoff = Date.now() - rotation.maxAge * MILLIS_PER_DAY;
    for (const backup of backups) {
      if (backup.modified >= cutoff) continue;
      if (removeBackup(backup.path, reportFailure)) {
        backups = backups.filter((candidate) => candidate.path !== backup.path);
      }
    }
  }

  if (rotation.maxBackups === 0 || backups.length <= rotation.maxBackups) return;
  backups.sort((a, b) => b.modified - a.modified);
  for (const backup of backups.slice(rotation.maxBackups)) {
    removeBackup(backup.path, reportFailure);
  }
}

function listBackups(dir: string, prefix: string): Backup[] {
  const backups: Backup[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (!entry.isFile || !entry.name.startsWith(prefix)) continue;
    if (!entry.name.endsWith(".log") && !entry.name.endsWith(".log.gz")) continue;
    const path = joinPath(dir, entry.name);
    const info = Deno.statSync(path);
    backups.push({
      path,
      modified: info.mtime?.getTime() ?? info.birthtime?.getTime() ?? 0,
    });
  }
  return backups;
}

function removeBackup(
  path: string,
  reportFailure: (operation: string, error: unknown) => void,
): boolean {
  try {
    Deno.removeSync(path);
    return true;
  } catch (error) {
    reportFailure("backup removal failed", error);
    return false;
  }
}

async function compressBackup(path: string): Promise<void> {
  const source = await Deno.readFile(path);
  const compressed = new Blob([source]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(compressed).arrayBuffer());
  const gzipPath = `${path}.gz`;
  const temporaryPath = `${gzipPath}.tmp`;
  try {
    await Deno.writeFile(temporaryPath, bytes, { create: true, mode: FILE_MODE });
    await Deno.chmod(temporaryPath, FILE_MODE);
    await Deno.rename(temporaryPath, gzipPath);
    await Deno.remove(path);
  } catch (error) {
    try {
      await Deno.remove(temporaryPath);
    } catch {
      // The temporary file may not exist.
    }
    throw error;
  }
}
