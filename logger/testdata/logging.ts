// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Logger } from "../builder/builder.ts";

export function writeWrappedLog(log: Logger): void {
  log.info("wrapped");
}
