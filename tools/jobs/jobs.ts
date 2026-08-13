// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fixed-interval and cron in-process job scheduling.
 *
 * Uses the event loop with `setInterval` plus per-job control flags. The API
 * is an instance-level {@link Jobs} class and package-level helpers backed by a
 * default instance, plus a global registry so {@link stopAllJobs} can halt
 * every instance.
 *
 * Durations are expressed in **milliseconds**.
 *
 * @module
 */

import { isModeTest } from "../utilities/mode.ts";

/**
 * Specifies when a cron job fires. `null`/`undefined` components mean "any"
 * (wildcard).
 */
export interface CronTrigger {
  /** Specific year, or any year when omitted. */
  year?: number;
  /** Month 1-12, or any month when omitted. */
  month?: number;
  /** Day of month 1-31, or any day when omitted. */
  day?: number;
  /** Hour 0-23. */
  hour: number;
  /** Minute 0-59. */
  minute: number;
  /** Second 0-59. */
  second: number;
}

/** Snapshot of a single job's runtime state. */
export interface JobStatus {
  /** Caller-supplied or generated job identifier. */
  id: string;
  /** Scheduler mode used by the job. */
  kind: "interval" | "cron";
  /** Whether future ticks are temporarily suppressed. */
  paused: boolean;
  /** Whether the job has been permanently stopped. */
  stopped: boolean;
  /** Whether the job callback is currently executing. */
  running: boolean;
}

/** Synchronous or asynchronous callback invoked for each scheduled tick. */
export type JobFn = () => void | Promise<void>;

interface JobControl {
  id: string;
  kind: "interval" | "cron";
  timerIntervalMs: number;
  paused: boolean;
  stopped: boolean;
  running: boolean;
  timer?: ReturnType<typeof setInterval>;
  /** Executes one tick honouring pause/stop and optional timeout. */
  tick: () => void;
}

const CRON_RESOLUTION_MS = 1000;
const restarters = new WeakMap<Jobs, () => void>();

/** Manages the lifecycle of a set of interval/cron jobs. */
export class Jobs {
  readonly #controls = new Map<string, JobControl>();
  #started = false;

  /** Creates an empty scheduler and registers it for global shutdown. */
  constructor() {
    registry.add(this);
    restarters.set(this, () => {
      this.#stopTimers();
      this.startJobs();
    });
  }

  /** Registers an interval job and returns its generated id. */
  job(fn: JobFn, intervalMs: number, timeoutMs?: number): string {
    const id = crypto.randomUUID();
    this.#registerInterval(id, fn, intervalMs, timeoutMs);
    return id;
  }

  /** Registers an interval job under a caller-supplied id. */
  jobWithID(id: string, fn: JobFn, intervalMs: number, timeoutMs?: number): void {
    if (this.#controls.has(id)) throw new Error(`jobs: duplicate job id: ${id}`);
    this.#registerInterval(id, fn, intervalMs, timeoutMs);
  }

  /** Registers a cron job and returns its generated id. */
  cronJob(fn: JobFn, trigger: CronTrigger, intervalMs = 0): string {
    const id = crypto.randomUUID();
    this.#registerCron(id, fn, trigger, intervalMs);
    return id;
  }

  /** Registers a cron job under a caller-supplied id. */
  cronJobWithID(id: string, fn: JobFn, trigger: CronTrigger, intervalMs = 0): void {
    if (this.#controls.has(id)) throw new Error(`jobs: duplicate job id: ${id}`);
    this.#registerCron(id, fn, trigger, intervalMs);
  }

  /** Starts every registered job. No-op in test mode. */
  startJobs(): void {
    if (this.#started || isModeTest()) return;
    this.#started = true;
    for (const control of this.#controls.values()) this.#arm(control);
  }

  /** Stops and clears a single job. */
  stopJob(id: string): void {
    const control = this.#controls.get(id);
    if (!control) return;
    control.stopped = true;
    this.#disarm(control);
    this.#controls.delete(id);
  }

  /** Pauses a job without discarding its definition. */
  pauseJob(id: string): void {
    const control = this.#controls.get(id);
    if (control) control.paused = true;
  }

  /** Resumes a previously paused job. */
  resumeJob(id: string): void {
    const control = this.#controls.get(id);
    if (control) control.paused = false;
  }

  /** Returns the status of every job on this instance. */
  checkStatus(): JobStatus[] {
    return [...this.#controls.values()].map((c) => ({
      id: c.id,
      kind: c.kind,
      paused: c.paused,
      stopped: c.stopped,
      running: c.running,
    }));
  }

  /** Stops every job and unregisters the instance from the global registry. */
  destroy(): void {
    this.#stopTimers();
    for (const control of [...this.#controls.values()]) this.stopJob(control.id);
    registry.delete(this);
  }

  // --- internals ----------------------------------------------------------

  #registerInterval(id: string, fn: JobFn, intervalMs: number, timeoutMs?: number): void {
    const control: JobControl = {
      id,
      kind: "interval",
      timerIntervalMs: intervalMs,
      paused: false,
      stopped: false,
      running: false,
      tick: () => this.#execute(control, fn, timeoutMs),
    };
    this.#controls.set(id, control);
    if (this.#started && !isModeTest()) this.#arm(control);
  }

  #registerCron(id: string, fn: JobFn, trigger: CronTrigger, intervalMs: number): void {
    let lastFired = 0;
    const control: JobControl = {
      id,
      kind: "cron",
      timerIntervalMs: CRON_RESOLUTION_MS,
      paused: false,
      stopped: false,
      running: false,
      tick: () => {
        const now = new Date();
        if (!matchesTrigger(now, trigger)) return;
        if (intervalMs > 0 && Date.now() - lastFired < intervalMs) return;
        lastFired = Date.now();
        this.#execute(control, fn);
      },
    };
    this.#controls.set(id, control);
    if (this.#started && !isModeTest()) this.#arm(control);
  }

  #arm(control: JobControl): void {
    if (control.timer !== undefined) return;
    control.timer = setInterval(control.tick, control.timerIntervalMs);
  }

  #disarm(control: JobControl): void {
    if (control.timer !== undefined) {
      clearInterval(control.timer);
      control.timer = undefined;
    }
  }

  #stopTimers(): void {
    for (const control of this.#controls.values()) this.#disarm(control);
    this.#started = false;
  }

  async #execute(control: JobControl, fn: JobFn, timeoutMs?: number): Promise<void> {
    if (control.paused || control.stopped || control.running) return;
    control.running = true;
    const execution = Promise.resolve().then(fn);
    try {
      if (timeoutMs && timeoutMs > 0) {
        await withTimeout(execution, timeoutMs);
      } else {
        await execution;
      }
    } catch (err) {
      console.error(`jobs: job ${control.id} failed:`, err);
    } finally {
      // A timeout only stops waiting; it cannot cancel arbitrary JavaScript.
      // Keep the running guard until the underlying work really settles so
      // later interval ticks cannot overlap it.
      await execution.catch(() => {});
      control.running = false;
    }
  }
}

/** Returns true when `date` satisfies every defined component of `trigger`. */
export function matchesTrigger(date: Date, trigger: CronTrigger): boolean {
  if (trigger.year !== undefined && date.getFullYear() !== trigger.year) return false;
  if (trigger.month !== undefined && date.getMonth() + 1 !== trigger.month) return false;
  if (trigger.day !== undefined && date.getDate() !== trigger.day) return false;
  return (
    date.getHours() === trigger.hour &&
    date.getMinutes() === trigger.minute &&
    date.getSeconds() === trigger.second
  );
}

function withTimeout(execution: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((_, reject) => {
    timer = setTimeout(() => reject(new Error("jobs: job timed out")), timeoutMs);
  });
  return Promise.race([execution, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

// --- Global registry + package-level API -----------------------------------

const registry = new Set<Jobs>();
const defaultJobs = new Jobs();

/** Registers an interval job on the default instance. */
export function job(fn: JobFn, intervalMs: number, timeoutMs?: number): string {
  return defaultJobs.job(fn, intervalMs, timeoutMs);
}

/** Registers an interval job under a fixed id on the default instance. */
export function jobWithID(id: string, fn: JobFn, intervalMs: number, timeoutMs?: number): void {
  defaultJobs.jobWithID(id, fn, intervalMs, timeoutMs);
}

/** Registers a cron job on the default instance. */
export function cronJob(fn: JobFn, trigger: CronTrigger, intervalMs = 0): string {
  return defaultJobs.cronJob(fn, trigger, intervalMs);
}

/** Registers a cron job under a fixed id on the default instance. */
export function cronJobWithID(
  id: string,
  fn: JobFn,
  trigger: CronTrigger,
  intervalMs = 0,
): void {
  defaultJobs.cronJobWithID(id, fn, trigger, intervalMs);
}

/** Starts the default instance's jobs. */
export function startJobs(): void {
  defaultJobs.startJobs();
}

/** Restarts the default instance without discarding registered definitions. */
export function restartJobs(): void {
  restarters.get(defaultJobs)!();
}

/** Pauses a job on the default instance. */
export function pauseJob(id: string): void {
  defaultJobs.pauseJob(id);
}

/** Resumes a job on the default instance. */
export function resumeJob(id: string): void {
  defaultJobs.resumeJob(id);
}

/** Stops a job on the default instance. */
export function stopJob(id: string): void {
  defaultJobs.stopJob(id);
}

/** Returns the status of every job across every registered instance. */
export function checkStatusJobs(): JobStatus[] {
  return [...registry].flatMap((instance) => instance.checkStatus());
}

/** Stops and clears every instance while retaining the empty package default. */
export function stopAllJobs(): void {
  for (const instance of [...registry]) instance.destroy();
  registry.add(defaultJobs);
}
