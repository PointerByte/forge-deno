// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `deno-openssl` argument parsing and command dispatch.
 *
 * A tiny, dependency-free CLI runner. {@link parseArgs} turns argv into a
 * command + positionals + flags; {@link run} dispatches to a command handler
 * and returns a process exit code. IO is injected via {@link CliIO} so the
 * commands stay unit-testable.
 *
 * @module
 */

import { commands } from "./commands.ts";

/** Parsed command line. */
export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Side-effect surface, injected so commands are testable. */
export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
  writeFile: (path: string, content: string) => Promise<void>;
}

/** Default IO bound to the console and the filesystem. */
export const defaultIO: CliIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  writeFile: (path, content) => Deno.writeTextFile(path, content),
};

/** Parses `["keypair", "--algorithm", "rsa", "--out=key"]` into a {@link ParsedArgs}. */
export function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
        flags[body] = rest[++i];
      } else {
        flags[body] = true;
      }
    } else {
      positionals.push(token);
    }
  }
  return { command, positionals, flags };
}

/** Runs the CLI and resolves with an exit code. */
export async function run(argv: string[], io: CliIO = defaultIO): Promise<number> {
  const parsed = parseArgs(argv);
  const handler = commands[parsed.command];
  if (!handler) {
    io.err(`deno-openssl: unknown command "${parsed.command}"`);
    commands.help(parsed, io);
    return 1;
  }
  try {
    return await handler(parsed, io);
  } catch (error) {
    io.err(`deno-openssl: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
