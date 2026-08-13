// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Scaffolding logic: turns a {@link templateFiles} map into files on disk via
 * an injectable writer (so it is unit-testable without touching the real FS).
 *
 * @module
 */

import { type ServiceKind, templateFiles } from "./templates.ts";

/** Filesystem seam used by {@link scaffold}. */
export interface Filesystem {
  mkdir: (path: string) => Promise<void>;
  writeFile: (path: string, content: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
}

/** Default {@link Filesystem} backed by Deno. */
export const denoFs: Filesystem = {
  mkdir: (path) => Deno.mkdir(path, { recursive: true }),
  writeFile: (path, content) => Deno.writeTextFile(path, content),
  async exists(path) {
    try {
      await Deno.stat(path);
      return true;
    } catch {
      return false;
    }
  },
};

/** Result of a scaffold run. */
export interface ScaffoldResult {
  dir: string;
  files: string[];
}

/** Options for {@link scaffold}. */
export interface ScaffoldOptions {
  kind: ServiceKind;
  name: string;
  /** Target directory (defaults to `./<name>`). */
  dir?: string;
  /** Overwrite even if the directory already exists. */
  force?: boolean;
}

function join(dir: string, file: string): string {
  return `${dir.replace(/\/+$/, "")}/${file}`;
}

/** Generates a project and returns the directory and written files. */
export async function scaffold(
  options: ScaffoldOptions,
  fs: Filesystem = denoFs,
): Promise<ScaffoldResult> {
  if (!/^[a-zA-Z][\w-]*$/.test(options.name)) {
    throw new Error(`qdeno: invalid project name "${options.name}"`);
  }
  const dir = options.dir ?? `./${options.name}`;
  if (!options.force && (await fs.exists(dir))) {
    throw new Error(`qdeno: target "${dir}" already exists (use --force to overwrite)`);
  }

  await fs.mkdir(dir);
  const files = templateFiles(options.kind, options.name);
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    await fs.writeFile(path, content);
    written.push(path);
  }
  return { dir, files: written };
}
