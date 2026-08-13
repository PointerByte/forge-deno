/**
 * Least-authority WASI 0.2.0 imports for this research component.
 *
 * The guest receives clocks and CSPRNG, but no arguments, environment,
 * filesystem preopens, terminal, or stream access. Resource classes still
 * have to exist because TinyGo 0.41.1 includes wasi:cli/imports@0.2.0 in the
 * component type even though this guest does not call those capabilities.
 */

class ClosedInputStream {
  blockingRead(_length: bigint): Uint8Array {
    throw { tag: "closed" };
  }
}

class ClosedOutputStream {
  blockingWriteAndFlush(_contents: Uint8Array): void {
    throw { tag: "closed" };
  }

  blockingFlush(): void {
    throw { tag: "closed" };
  }
}

class DeniedDescriptor {
  syncData(): never {
    return denied();
  }
  read(_length: bigint, _offset: bigint): never {
    return denied();
  }
  write(_buffer: Uint8Array, _offset: bigint): never {
    return denied();
  }
  readDirectory(): never {
    return denied();
  }
  createDirectoryAt(_path: string): never {
    return denied();
  }
  stat(): never {
    return denied();
  }
  statAt(_pathFlags: unknown, _path: string): never {
    return denied();
  }
  linkAt(
    _oldPathFlags: unknown,
    _oldPath: string,
    _newDescriptor: DeniedDescriptor,
    _newPath: string,
  ): never {
    return denied();
  }
  openAt(
    _pathFlags: unknown,
    _path: string,
    _openFlags: unknown,
    _flags: unknown,
  ): never {
    return denied();
  }
  readlinkAt(_path: string): never {
    return denied();
  }
  removeDirectoryAt(_path: string): never {
    return denied();
  }
  renameAt(
    _oldPath: string,
    _newDescriptor: DeniedDescriptor,
    _newPath: string,
  ): never {
    return denied();
  }
  symlinkAt(_oldPath: string, _newPath: string): never {
    return denied();
  }
  unlinkFileAt(_path: string): never {
    return denied();
  }
}

class EmptyDirectoryEntryStream {
  readDirectoryEntry(): undefined {
    return undefined;
  }
}

class WasiError {}

function denied(): never {
  throw "not-permitted";
}

function randomBytes(length: bigint): Uint8Array {
  const numericLength = Number(length);
  if (!Number.isSafeInteger(numericLength) || numericLength < 0) {
    throw new RangeError(`invalid random byte length: ${length}`);
  }
  const result = new Uint8Array(numericLength);
  for (let offset = 0; offset < result.length; offset += 65_536) {
    crypto.getRandomValues(
      result.subarray(offset, Math.min(offset + 65_536, result.length)),
    );
  }
  return result;
}

export const wasiImports = {
  "wasi:cli/environment": {
    getArguments: (): string[] => [],
    getEnvironment: (): Array<[string, string]> => [],
    initialCwd: (): undefined => undefined,
  },
  "wasi:cli/stderr": { getStderr: () => new ClosedOutputStream() },
  "wasi:cli/stdin": { getStdin: () => new ClosedInputStream() },
  "wasi:cli/stdout": { getStdout: () => new ClosedOutputStream() },
  "wasi:clocks/monotonic-clock": {
    now: (): bigint => BigInt(Math.floor(performance.now() * 1_000_000)),
  },
  "wasi:clocks/wall-clock": {
    now: () => {
      const milliseconds = Date.now();
      return {
        seconds: BigInt(Math.floor(milliseconds / 1_000)),
        nanoseconds: (milliseconds % 1_000) * 1_000_000,
      };
    },
  },
  "wasi:filesystem/preopens": { getDirectories: (): never[] => [] },
  "wasi:filesystem/types": {
    Descriptor: DeniedDescriptor,
    DirectoryEntryStream: EmptyDirectoryEntryStream,
  },
  "wasi:io/error": { Error: WasiError },
  "wasi:io/streams": {
    InputStream: ClosedInputStream,
    OutputStream: ClosedOutputStream,
  },
  "wasi:random/random": {
    getRandomBytes: randomBytes,
    getRandomU64: (): bigint => {
      const bytes = randomBytes(8n);
      return new DataView(bytes.buffer).getBigUint64(0, true);
    },
  },
} as const;
