// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `qdeno` — scaffolds new DenoForge HTTP or gRPC services.
 *
 * Run with: `deno run -A cmd/qdeno/main.ts new http my-api`
 *
 * @module
 */

import { run } from "./code/app.ts";

if (import.meta.main) {
  Deno.exit(await run(Deno.args));
}
