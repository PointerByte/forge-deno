// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `deno-openssl` — a small CLI for key-pair generation, self-signed certificates
 * and PEM handling, built on Web Crypto.
 *
 * Run with: `deno run -A cmd/deno-openssl/main.ts <command> [flags]`
 *
 * @module
 */

import { run } from "./code/app.ts";

if (import.meta.main) {
  Deno.exit(await run(Deno.args));
}
