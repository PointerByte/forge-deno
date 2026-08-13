// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@std/assert";
import {
  checkStatusJobs,
  cronJob,
  cronJobWithID,
  job,
  Jobs,
  jobWithID,
  pauseJob,
  restartJobs,
  resumeJob,
  startJobs,
  stopAllJobs,
  stopJob,
} from "./jobs.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("cron job fires when the trigger second matches", async () => {
  const jobs = new Jobs();
  try {
    const target = new Date(Date.now() + 2000);
    let fired = 0;
    jobs.cronJobWithID("cron", () => {
      fired++;
    }, {
      hour: target.getHours(),
      minute: target.getMinutes(),
      second: target.getSeconds(),
    });
    jobs.startJobs();
    await sleep(2600);
    assert(fired >= 1, `expected cron to fire, got ${fired}`);
  } finally {
    jobs.destroy();
  }
});

Deno.test("interval job timeout is reported without crashing", async () => {
  const jobs = new Jobs();
  const original = console.error;
  let logged = false;
  console.error = () => {
    logged = true;
  };
  try {
    jobs.job(
      async () => {
        await sleep(200);
      },
      30,
      10,
    ); // timeout (10ms) shorter than the work (200ms)
    jobs.startJobs();
    await sleep(120);
    assert(logged, "expected a timeout error to be logged");
  } finally {
    console.error = original;
    jobs.destroy();
  }
});

Deno.test("timed-out interval jobs never overlap unsettled work", async () => {
  const jobs = new Jobs();
  const original = console.error;
  let active = 0;
  let maxActive = 0;
  let timeouts = 0;
  console.error = () => {
    timeouts++;
  };

  try {
    jobs.job(
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(55);
        active--;
      },
      10,
      5,
    );
    jobs.startJobs();
    await sleep(135);
    assert(timeouts >= 1, "expected at least one timeout to be reported");
    assertEquals(maxActive, 1, "timed-out work must retain the running guard until it settles");
  } finally {
    jobs.destroy();
    await sleep(60);
    console.error = original;
  }
});

Deno.test("package-level job API drives the default instance", async () => {
  try {
    let n = 0;
    const id = job(() => {
      n++;
    }, 20);
    jobWithID("fixed", () => {}, 1000);
    cronJobWithID("c", () => {}, { hour: 0, minute: 0, second: 0 }, 1000);
    const autoCron = cronJob(() => {}, { hour: 0, minute: 0, second: 0 });
    startJobs();
    await sleep(60);
    assert(n >= 1);

    pauseJob(id);
    resumeJob(id);
    assert(checkStatusJobs().some((s) => s.id === id));

    stopJob("fixed");
    stopJob(autoCron);
    restartJobs();
  } finally {
    stopAllJobs();
  }
});

Deno.test("restartJobs preserves default job definitions and package tracking", async () => {
  stopAllJobs();
  let ticks = 0;
  jobWithID("restart-preserved", () => {
    ticks++;
  }, 15);

  try {
    startJobs();
    await sleep(50);
    assert(ticks >= 1, `expected a tick before restart, got ${ticks}`);

    restartJobs();
    assert(
      checkStatusJobs().some((status) => status.id === "restart-preserved"),
      "expected the restarted job definition to remain registered",
    );

    const ticksAtRestart = ticks;
    await sleep(50);
    assert(ticks > ticksAtRestart, "expected the preserved job to keep running after restart");

    stopJob("restart-preserved");
    assert(
      !checkStatusJobs().some((status) => status.id === "restart-preserved"),
      "expected package-level stopJob to remove the restarted job",
    );
  } finally {
    stopAllJobs();
  }
});

Deno.test("restartJobs preserves cadence for a default job registered after startup", async () => {
  stopAllJobs();
  let ticks = 0;

  try {
    startJobs();
    jobWithID("registered-after-start", () => {
      ticks++;
    }, 80);
    restartJobs();

    await sleep(20);
    assertEquals(ticks, 0, "expected restart to retain the configured interval");
    await sleep(80);
    assert(ticks >= 1, "expected the restarted late registration to run");
  } finally {
    stopAllJobs();
  }
});

Deno.test("default instance remains globally tracked after stopAllJobs", async () => {
  stopAllJobs();
  let ticks = 0;
  jobWithID("registered-after-stop-all", () => {
    ticks++;
  }, 15);

  try {
    assert(
      checkStatusJobs().some((status) => status.id === "registered-after-stop-all"),
      "expected status to include a default job registered after stopAllJobs",
    );

    startJobs();
    await sleep(50);
    assert(ticks >= 1, `expected the new default job to run, got ${ticks}`);

    stopAllJobs();
    const ticksAtStop = ticks;
    await sleep(50);
    assertEquals(ticks, ticksAtStop, "expected stopAllJobs to stop the default job");
    assertEquals(checkStatusJobs(), []);
  } finally {
    stopAllJobs();
  }
});

Deno.test("destroy stops jobs and clears status", () => {
  const jobs = new Jobs();
  jobs.jobWithID("a", () => {}, 1000);
  assertEquals(jobs.checkStatus().length, 1);
  jobs.destroy();
  assertEquals(jobs.checkStatus().length, 0);
});
