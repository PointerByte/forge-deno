// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tools example: bounded worker loop + interval job.
 * Run with: `deno run examples/tools.ts`
 */

import { addTask, job, runWorkers, startJobs, stopAllJobs, stopWorkers } from "../tools/mod.ts";

// --- Workers ---
runWorkers();
for (let i = 0; i < 5; i++) {
  addTask(() => console.log(`worker task ${i} ran`));
}

// --- Interval job ---
let ticks = 0;
const id = job(() => {
  ticks++;
  console.log(`interval job tick ${ticks}`);
}, 200);

// Stop everything after ~700ms.
setTimeout(() => {
  console.log(`stopping job ${id} after ${ticks} ticks`);
  stopAllJobs();
  stopWorkers();
}, 700);

startJobs();
