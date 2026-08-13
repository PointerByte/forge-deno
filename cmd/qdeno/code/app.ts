// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `qdeno` argument parsing and command dispatch.
 *
 * @module
 */

import { scaffold } from "./scaffold.ts";
import type { ServiceKind } from "./templates.ts";

/** Parsed command line. */
export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Injectable IO surface. */
export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Default console-backed IO. */
export const defaultIO: CliIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** Parses argv into a {@link ParsedArgs}. */
export function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) flags[body.slice(0, eq)] = body.slice(eq + 1);
      else if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) flags[body] = rest[++i];
      else flags[body] = true;
    } else {
      positionals.push(token);
    }
  }
  return { command, positionals, flags };
}

const HELP = `qdeno — DenoForge service scaffolder

Usage:
  qdeno new <http|grpc> <name> [--dir <path>] [--force]
  qdeno help

Examples:
  qdeno new http my-api
  qdeno new grpc my-svc --dir ./services/my-svc`;

/** Runs the CLI and resolves with an exit code. */
export async function run(argv: string[], io: CliIO = defaultIO): Promise<number> {
  const args = parseArgs(argv);

  if (args.command === "help" || args.flags.help) {
    io.out(HELP);
    return 0;
  }

  if (args.command !== "new") {
    io.err(`qdeno: unknown command "${args.command}"`);
    io.out(HELP);
    return 1;
  }

  const [kind, name] = args.positionals;
  if ((kind !== "http" && kind !== "grpc") || !name) {
    io.err("qdeno: usage: qdeno new <http|grpc> <name>");
    return 1;
  }

  try {
    const result = await scaffold({
      kind: kind as ServiceKind,
      name,
      dir: typeof args.flags.dir === "string" ? args.flags.dir : undefined,
      force: args.flags.force === true,
    });
    io.out(`Scaffolded ${kind} service "${name}" in ${result.dir}`);
    for (const file of result.files) io.out(`  + ${file}`);
    io.out(`\nNext:\n  cd ${result.dir}\n  deno task dev`);
    return 0;
  } catch (error) {
    io.err(`qdeno: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
