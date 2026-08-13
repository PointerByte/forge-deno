// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@std/assert";
import { Jobs, matchesTrigger } from "./jobs/jobs.ts";
import {
  addTask,
  resetWorkers,
  restartWorkers,
  runWorkers,
  setWorkersLimit,
  stopWorkers,
} from "./workers/workers.ts";
import { disableModeTest, enableModeTest, isModeTest, setModeTest } from "./utilities/mode.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- jobs -------------------------------------------------------------------

Deno.test("matchesTrigger honours wildcards and exact fields", () => {
  const d = new Date(2026, 5, 29, 10, 30, 15); // month is 0-based: June
  assert(matchesTrigger(d, { hour: 10, minute: 30, second: 15 }));
  assert(matchesTrigger(d, { month: 6, day: 29, hour: 10, minute: 30, second: 15 }));
  assert(!matchesTrigger(d, { hour: 11, minute: 30, second: 15 }));
  assert(!matchesTrigger(d, { year: 2025, hour: 10, minute: 30, second: 15 }));
});

Deno.test("interval job runs, pauses, resumes and stops", async () => {
  const jobs = new Jobs();
  try {
    let count = 0;
    const id = jobs.job(() => {
      count++;
    }, 20);
    jobs.startJobs();
    await sleep(70);
    const afterStart = count;
    assert(afterStart >= 1, `expected ticks, got ${afterStart}`);

    jobs.pauseJob(id);
    const atPause = count;
    await sleep(50);
    assertEquals(count, atPause, "paused job should not tick");

    jobs.resumeJob(id);
    await sleep(50);
    assert(count > atPause, "resumed job should tick again");

    assertEquals(jobs.checkStatus()[0].id, id);
    jobs.stopJob(id);
    assertEquals(jobs.checkStatus().length, 0);
  } finally {
    jobs.destroy();
  }
});

Deno.test("jobWithID rejects duplicate ids", () => {
  const jobs = new Jobs();
  try {
    jobs.jobWithID("dup", () => {}, 1000);
    assertThrows(() => jobs.jobWithID("dup", () => {}, 1000));
  } finally {
    jobs.destroy();
  }
});

Deno.test("startJobs is a no-op in test mode", async () => {
  enableModeTest();
  const jobs = new Jobs();
  try {
    let count = 0;
    jobs.job(() => {
      count++;
    }, 10);
    jobs.startJobs();
    await sleep(40);
    assertEquals(count, 0);
  } finally {
    jobs.destroy();
    disableModeTest();
  }
});

// --- workers ----------------------------------------------------------------

Deno.test("workers run queued tasks", async () => {
  resetWorkers();
  try {
    const ran: number[] = [];
    runWorkers();
    for (let i = 0; i < 5; i++) {
      addTask(() => {
        ran.push(i);
      });
    }
    await sleep(20);
    assertEquals(ran.sort(), [0, 1, 2, 3, 4]);
  } finally {
    resetWorkers();
  }
});

Deno.test("worker concurrency respects the configured limit", async () => {
  resetWorkers();
  try {
    setWorkersLimit(2);
    let active = 0;
    let maxActive = 0;
    runWorkers();
    for (let i = 0; i < 6; i++) {
      addTask(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(15);
        active--;
      });
    }
    await sleep(120);
    assert(maxActive <= 2, `max concurrency ${maxActive} exceeded limit`);
  } finally {
    resetWorkers();
  }
});

Deno.test("a failing task does not stop the loop", async () => {
  resetWorkers();
  const original = console.error;
  console.error = () => {};
  try {
    let ok = false;
    runWorkers();
    addTask(() => {
      throw new Error("boom");
    });
    addTask(() => {
      ok = true;
    });
    await sleep(20);
    assert(ok);
  } finally {
    console.error = original;
    resetWorkers();
  }
});

Deno.test("restartWorkers keeps the loop usable", async () => {
  resetWorkers();
  try {
    runWorkers();
    restartWorkers();
    let ran = false;
    addTask(() => {
      ran = true;
    });
    await sleep(20);
    assert(ran);
  } finally {
    stopWorkers();
    resetWorkers();
  }
});

Deno.test("resetWorkers preserves in-flight concurrency accounting", async () => {
  resetWorkers();
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondFinished = Promise.withResolvers<void>();
  let observedActive = 0;
  let maxActive = 0;

  try {
    setWorkersLimit(1);
    runWorkers();
    addTask(async () => {
      observedActive++;
      maxActive = Math.max(maxActive, observedActive);
      firstStarted.resolve();
      await releaseFirst.promise;
      observedActive--;
    });
    await firstStarted.promise;

    resetWorkers();
    setWorkersLimit(1);
    runWorkers();
    addTask(() => {
      observedActive++;
      maxActive = Math.max(maxActive, observedActive);
      observedActive--;
      secondFinished.resolve();
    });

    await sleep(10);
    assertEquals(maxActive, 1);
    releaseFirst.resolve();
    await secondFinished.promise;
    assertEquals(maxActive, 1);
  } finally {
    releaseFirst.resolve();
    resetWorkers();
  }
});

Deno.test("setWorkersLimit falls back to default on non-positive input", async () => {
  resetWorkers();
  try {
    setWorkersLimit(-1); // -> default limit
    let ran = false;
    runWorkers();
    addTask(() => {
      ran = true;
    });
    await sleep(20);
    assert(ran);
  } finally {
    resetWorkers();
  }
});

Deno.test("tasks queued before runWorkers still execute", async () => {
  resetWorkers();
  try {
    let ran = false;
    addTask(() => {
      ran = true;
    });
    runWorkers();
    await sleep(20);
    assert(ran);
  } finally {
    resetWorkers();
  }
});

// --- mode -------------------------------------------------------------------

Deno.test("mode flag toggles", () => {
  assert(!isModeTest());
  setModeTest();
  assert(isModeTest());
  disableModeTest();
  assert(!isModeTest());
});
