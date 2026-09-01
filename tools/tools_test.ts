// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@std/assert";
import { Jobs, matchesTrigger } from "./jobs/jobs.ts";
import {
  addTask,
  resetWorkers,
  restartWorkers,
  runWorkers,
  setParallelism,
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

// The limit is applied as written: with no execution slot the loop keeps the
// task queued instead of falling back to a default concurrency.
Deno.test("setWorkersLimit applies a non-positive limit verbatim", async () => {
  resetWorkers();
  try {
    setWorkersLimit(0);
    let ran = false;
    runWorkers();
    addTask(() => {
      ran = true;
    });
    await sleep(20);
    assert(!ran, "a zero limit leaves the loop without an execution slot");

    setWorkersLimit(1);
    await sleep(20);
    assert(ran, "the queued task runs once a positive limit is configured");
  } finally {
    resetWorkers();
  }
});

// The limit is deliberately higher than the task count, so serialization can
// only come from the dispatch mode.
Deno.test("sequential dispatch runs one task at a time", async () => {
  resetWorkers();
  try {
    setWorkersLimit(4);
    setParallelism(false);
    let active = 0;
    let maxActive = 0;
    let completed = 0;
    runWorkers();
    for (let i = 0; i < 3; i++) {
      addTask(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(10);
        active--;
        completed++;
      });
    }
    await sleep(120);
    assertEquals(maxActive, 1);
    assertEquals(completed, 3);
  } finally {
    resetWorkers();
  }
});

Deno.test("setParallelism(true) resumes concurrency on a running loop", async () => {
  resetWorkers();
  const firstStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    setWorkersLimit(3);
    setParallelism(false);
    let active = 0;
    let maxActive = 0;
    runWorkers();
    for (let i = 0; i < 3; i++) {
      addTask(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        firstStarted.resolve();
        await release.promise;
        active--;
      });
    }

    await firstStarted.promise;
    assertEquals(maxActive, 1, "sequential dispatch holds the queue at one task");

    setParallelism(true);
    await sleep(10);
    assertEquals(maxActive, 3, "the queued tasks start as soon as the mode allows it");
  } finally {
    release.resolve();
    await sleep(10);
    resetWorkers();
  }
});

// Sequential counterpart of the queued-task contract: a stopped loop never
// pulls the task behind the one that was running inline.
Deno.test("stopWorkers leaves the sequential queue for the next run", async () => {
  resetWorkers();
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  try {
    setWorkersLimit(2);
    setParallelism(false);
    runWorkers();

    let secondRan = false;
    addTask(async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    });
    addTask(() => {
      secondRan = true;
    });

    await firstStarted.promise;
    stopWorkers();
    releaseFirst.resolve();
    await sleep(20);
    assert(!secondRan, "a stopped loop should not pull the next task");

    runWorkers();
    await sleep(20);
    assert(secondRan, "the queued task should run on the next start");
  } finally {
    releaseFirst.resolve();
    resetWorkers();
  }
});

// A limit change is a change of policy, not of queue: what was already accepted
// still runs. The forge-go dispatcher used to drop these, because changing the
// limit there rebuilt the queue.
Deno.test("lowering the limit keeps queued tasks", async () => {
  resetWorkers();
  try {
    setWorkersLimit(4);
    let completed = 0;
    for (let i = 0; i < 4; i++) {
      addTask(() => {
        completed++;
      });
    }

    setWorkersLimit(1);
    runWorkers();
    await sleep(30);
    assertEquals(completed, 4);
  } finally {
    resetWorkers();
  }
});

// A saturated loop must never hold the control functions hostage, or the pool
// becomes unrecoverable — the failure mode the forge-go port had while a
// producer waited for room.
Deno.test("a saturated loop still accepts control operations", async () => {
  resetWorkers();
  const release = Promise.withResolvers<void>();
  try {
    setWorkersLimit(1);
    runWorkers();
    let completed = 0;
    for (let i = 0; i < 6; i++) {
      addTask(async () => {
        await release.promise;
        completed++;
      });
    }
    await sleep(10);

    stopWorkers();
    setWorkersLimit(2);
    runWorkers();

    release.resolve();
    await sleep(30);
    assertEquals(completed, 6, "the queue did not drain after the control calls");
  } finally {
    release.resolve();
    resetWorkers();
  }
});

// The loop reads the limit on every pass rather than capturing it when it
// starts, so a limit raised mid-flight applies without a restart.
Deno.test("raising the limit reaches the running loop", async () => {
  resetWorkers();
  const release = Promise.withResolvers<void>();
  try {
    setWorkersLimit(1);
    runWorkers();
    let active = 0;
    let maxActive = 0;
    for (let i = 0; i < 4; i++) {
      addTask(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await release.promise;
        active--;
      });
    }

    await sleep(10);
    assertEquals(maxActive, 1, "the loop should hold at the configured limit");

    setWorkersLimit(4);
    await sleep(10);
    assertEquals(maxActive, 4, "raising the limit should reach the running loop");
  } finally {
    release.resolve();
    await sleep(10);
    resetWorkers();
  }
});

// A restart re-reads the limit but must not use it to overrun the tasks still
// in flight from the previous run.
Deno.test("restartWorkers keeps the limit across running tasks", async () => {
  resetWorkers();
  const firstStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    setWorkersLimit(1);
    runWorkers();

    let secondStarted = false;
    addTask(async () => {
      firstStarted.resolve();
      await release.promise;
    });
    await firstStarted.promise;
    addTask(() => {
      secondStarted = true;
    });

    restartWorkers();
    await sleep(10);
    assert(!secondStarted, "restart exceeded the limit while an earlier task was running");

    release.resolve();
    await sleep(10);
    assert(secondStarted, "the queued task did not run once the earlier one finished");
  } finally {
    release.resolve();
    resetWorkers();
  }
});

// forge-go checks that a second RunWorkers call does not replace the active run,
// because a duplicate goroutine would double the concurrency. There is no
// per-run dispatcher object here — the bound lives in the shared queue state, so
// a repeated start is inert by construction — but the invariant it protects,
// that no task is dispatched twice, is worth pinning.
Deno.test("every queued task is dispatched exactly once", async () => {
  resetWorkers();
  try {
    setWorkersLimit(2);
    const runs = new Array(6).fill(0);
    for (let i = 0; i < 6; i++) {
      addTask(async () => {
        runs[i]++;
        await sleep(5);
      });
    }

    runWorkers();
    runWorkers();
    runWorkers();

    await sleep(80);
    assertEquals(runs, [1, 1, 1, 1, 1, 1]);
  } finally {
    resetWorkers();
  }
});

Deno.test("workers support repeated start/stop cycles", async () => {
  resetWorkers();
  try {
    setWorkersLimit(2);
    for (let cycle = 0; cycle < 3; cycle++) {
      runWorkers();
      let ran = false;
      addTask(() => {
        ran = true;
      });
      await sleep(10);
      assert(ran, `task did not run in cycle ${cycle}`);
      stopWorkers();
    }
  } finally {
    resetWorkers();
  }
});

Deno.test("resetWorkers restores parallel dispatch", async () => {
  resetWorkers();
  try {
    setParallelism(false);
    resetWorkers();

    setWorkersLimit(2);
    let active = 0;
    let maxActive = 0;
    runWorkers();
    for (let i = 0; i < 4; i++) {
      addTask(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(15);
        active--;
      });
    }
    await sleep(120);
    assertEquals(maxActive, 2);
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
