// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Least-authority WASI 0.2.12 host imports for the GoForge production component.
 *
 * GoForge's portable core is dependency-free: it performs no I/O, reads no environment and opens no
 * files. The Go runtime inside the component nevertheless links `wasi:cli`, `wasi:filesystem` and
 * `wasi:io` because the standard library's initialization references them, so the host must supply
 * every declared interface. Each one is supplied in its **denied** form: arguments and environment
 * are empty, standard streams are closed, terminals are absent, and every filesystem operation
 * returns `not-permitted`.
 *
 * Only two real capabilities are granted, because the guest genuinely needs them:
 *
 * - clocks, so Go's scheduler and timers work;
 * - `wasi:random/random`, backed by the host CSPRNG, so Go's runtime hash seeding is not predictable.
 *
 * Denying an interface here is a security boundary, not an omission. Replacing any denied stub with
 * a working implementation grants the guest authority the portable contract never asks for.
 *
 * @module
 */

import { WasmCapabilityDeniedError } from "./errors.ts";

const CHUNK_BYTES = 65_536;

/**
 * WASI stream/filesystem errors travel through generated glue that expects plain WIT variant
 * payloads, not JavaScript `Error` instances. These helpers throw the exact tagged shapes.
 */
function closed(): never {
  throw { tag: "closed" };
}

function notPermitted(): never {
  throw "not-permitted";
}

/** A `wasi:io/streams` input stream that is always at end of input. */
class ClosedInputStream {
  read(_length: bigint): Uint8Array {
    return new Uint8Array(0);
  }
  blockingRead(_length: bigint): never {
    return closed();
  }
  skip(_length: bigint): bigint {
    return 0n;
  }
  blockingSkip(_length: bigint): never {
    return closed();
  }
  subscribe(): Pollable {
    return new Pollable();
  }
}

/** A `wasi:io/streams` output stream that discards nothing because it accepts nothing. */
class ClosedOutputStream {
  checkWrite(): bigint {
    return 0n;
  }
  write(_contents: Uint8Array): never {
    return closed();
  }
  blockingWriteAndFlush(_contents: Uint8Array): never {
    return closed();
  }
  flush(): never {
    return closed();
  }
  blockingFlush(): never {
    return closed();
  }
  writeZeroes(_length: bigint): never {
    return closed();
  }
  blockingWriteZeroesAndFlush(_length: bigint): never {
    return closed();
  }
  splice(_source: ClosedInputStream, _length: bigint): never {
    return closed();
  }
  blockingSplice(_source: ClosedInputStream, _length: bigint): never {
    return closed();
  }
  subscribe(): Pollable {
    return new Pollable();
  }
}

/** A `wasi:io/poll` pollable that is always immediately ready, so the guest never blocks on I/O. */
class Pollable {
  ready(): boolean {
    return true;
  }
  block(): void {}
}

/** Every `wasi:filesystem/types` entry point refuses; no directory is ever preopened. */
class DeniedDescriptor {
  readViaStream(_offset: bigint): never {
    return notPermitted();
  }
  writeViaStream(_offset: bigint): never {
    return notPermitted();
  }
  appendViaStream(): never {
    return notPermitted();
  }
  advise(_offset: bigint, _length: bigint, _advice: unknown): never {
    return notPermitted();
  }
  syncData(): never {
    return notPermitted();
  }
  getFlags(): never {
    return notPermitted();
  }
  getType(): never {
    return notPermitted();
  }
  setSize(_size: bigint): never {
    return notPermitted();
  }
  setTimes(_dataAccess: unknown, _dataModified: unknown): never {
    return notPermitted();
  }
  read(_length: bigint, _offset: bigint): never {
    return notPermitted();
  }
  write(_buffer: Uint8Array, _offset: bigint): never {
    return notPermitted();
  }
  readDirectory(): never {
    return notPermitted();
  }
  sync(): never {
    return notPermitted();
  }
  createDirectoryAt(_path: string): never {
    return notPermitted();
  }
  stat(): never {
    return notPermitted();
  }
  statAt(_pathFlags: unknown, _path: string): never {
    return notPermitted();
  }
  setTimesAt(
    _pathFlags: unknown,
    _path: string,
    _dataAccess: unknown,
    _dataModified: unknown,
  ): never {
    return notPermitted();
  }
  linkAt(
    _oldPathFlags: unknown,
    _oldPath: string,
    _newDescriptor: DeniedDescriptor,
    _newPath: string,
  ): never {
    return notPermitted();
  }
  openAt(
    _pathFlags: unknown,
    _path: string,
    _openFlags: unknown,
    _flags: unknown,
  ): never {
    return notPermitted();
  }
  readlinkAt(_path: string): never {
    return notPermitted();
  }
  removeDirectoryAt(_path: string): never {
    return notPermitted();
  }
  renameAt(_oldPath: string, _newDescriptor: DeniedDescriptor, _newPath: string): never {
    return notPermitted();
  }
  symlinkAt(_oldPath: string, _newPath: string): never {
    return notPermitted();
  }
  unlinkFileAt(_path: string): never {
    return notPermitted();
  }
  isSameObject(_other: DeniedDescriptor): boolean {
    return false;
  }
  metadataHash(): never {
    return notPermitted();
  }
  metadataHashAt(_pathFlags: unknown, _path: string): never {
    return notPermitted();
  }
}

/** A directory stream that is always exhausted. */
class EmptyDirectoryEntryStream {
  readDirectoryEntry(): undefined {
    return undefined;
  }
}

/** The `wasi:io/error` resource class; instances are never produced by this host. */
class WasiIoError {
  toDebugString(): string {
    return "denied";
  }
}

/** Terminal resource classes exist only so the guest can observe that no terminal is attached. */
class TerminalInput {}
class TerminalOutput {}

function randomBytes(length: bigint): Uint8Array {
  const numericLength = Number(length);
  if (!Number.isSafeInteger(numericLength) || numericLength < 0) {
    throw new RangeError(`invalid random byte length: ${length}`);
  }
  const result = new Uint8Array(numericLength);
  for (let offset = 0; offset < result.length; offset += CHUNK_BYTES) {
    crypto.getRandomValues(result.subarray(offset, Math.min(offset + CHUNK_BYTES, result.length)));
  }
  return result;
}

/**
 * Builds the complete unversioned WASI import object required by jco's async instantiation mode.
 *
 * jco 1.26.1 strips interface versions from runtime lookup keys even though its generated
 * declaration retains `@0.2.12`, so the keys here are intentionally unversioned.
 *
 * @param onExit Invoked when the guest calls `wasi:cli/exit`. Defaults to raising
 * {@link WasmCapabilityDeniedError}, because a healthy dispatch never terminates the component.
 */
export function createDeniedWasiImports(
  onExit?: (status: { tag: "ok" } | { tag: "err" }) => void,
): Record<string, Record<string, unknown>> {
  return {
    "wasi:cli/environment": {
      getArguments: (): string[] => [],
      getEnvironment: (): Array<[string, string]> => [],
      initialCwd: (): undefined => undefined,
    },
    "wasi:cli/exit": {
      exit: (status: { tag: "ok" } | { tag: "err" }): void => {
        if (onExit) {
          onExit(status);
          return;
        }
        throw new WasmCapabilityDeniedError("wasi:cli/exit");
      },
    },
    "wasi:cli/stderr": { getStderr: () => new ClosedOutputStream() },
    "wasi:cli/stdin": { getStdin: () => new ClosedInputStream() },
    "wasi:cli/stdout": { getStdout: () => new ClosedOutputStream() },
    "wasi:cli/terminal-input": { TerminalInput },
    "wasi:cli/terminal-output": { TerminalOutput },
    "wasi:cli/terminal-stderr": { getTerminalStderr: (): undefined => undefined },
    "wasi:cli/terminal-stdin": { getTerminalStdin: (): undefined => undefined },
    "wasi:cli/terminal-stdout": { getTerminalStdout: (): undefined => undefined },
    "wasi:clocks/monotonic-clock": {
      now: (): bigint => BigInt(Math.floor(performance.now() * 1_000_000)),
      resolution: (): bigint => 1_000n,
      subscribeDuration: (_nanoseconds: bigint): Pollable => new Pollable(),
      subscribeInstant: (_instant: bigint): Pollable => new Pollable(),
    },
    "wasi:clocks/wall-clock": {
      now: () => {
        const milliseconds = Date.now();
        return {
          seconds: BigInt(Math.floor(milliseconds / 1_000)),
          nanoseconds: (milliseconds % 1_000) * 1_000_000,
        };
      },
      resolution: () => ({ seconds: 0n, nanoseconds: 1_000_000 }),
    },
    "wasi:filesystem/preopens": { getDirectories: (): never[] => [] },
    "wasi:filesystem/types": {
      Descriptor: DeniedDescriptor,
      DirectoryEntryStream: EmptyDirectoryEntryStream,
      filesystemErrorCode: (_error: unknown): undefined => undefined,
    },
    "wasi:io/error": { Error: WasiIoError },
    "wasi:io/poll": {
      Pollable,
      poll: (pollables: Pollable[]): Uint32Array =>
        Uint32Array.from(pollables.map((_pollable, index) => index)),
    },
    "wasi:io/streams": { InputStream: ClosedInputStream, OutputStream: ClosedOutputStream },
    "wasi:random/random": {
      getRandomBytes: randomBytes,
      getRandomU64: (): bigint => new DataView(randomBytes(8n).buffer).getBigUint64(0, true),
    },
  };
}

/** Interface names this host supplies, in the order the generated glue destructures them. */
export const GOFORGE_WASI_INTERFACES: readonly string[] = Object.freeze([
  "wasi:cli/environment",
  "wasi:cli/exit",
  "wasi:cli/stderr",
  "wasi:cli/stdin",
  "wasi:cli/stdout",
  "wasi:cli/terminal-input",
  "wasi:cli/terminal-output",
  "wasi:cli/terminal-stderr",
  "wasi:cli/terminal-stdin",
  "wasi:cli/terminal-stdout",
  "wasi:clocks/monotonic-clock",
  "wasi:clocks/wall-clock",
  "wasi:filesystem/preopens",
  "wasi:filesystem/types",
  "wasi:io/error",
  "wasi:io/poll",
  "wasi:io/streams",
  "wasi:random/random",
]);
