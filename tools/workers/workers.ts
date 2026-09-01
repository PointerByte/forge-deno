// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded worker loop.
 *
 * A bounded task pool: a FIFO queue with a configurable concurrency limit, so
 * at most `limit` tasks run at once and the rest wait.
 *
 * Dispatch has two modes, mirroring forge-go's `tools/workers`. The default
 * parallel mode starts up to `limit` tasks concurrently. Sequential mode
 * (`setParallelism(false)`) runs one task at a time whatever the limit is, and
 * only pulls the next task off the queue once the current one has settled — the
 * analogue of forge-go dispatching a task inline instead of spawning a
 * goroutine per task.
 *
 * @module
 */

/**
 * Concurrency applied until a caller configures one, and restored by
 * `resetWorkers()`.
 *
 * One execution slot per available CPU: `navigator.hardwareConcurrency` is the
 * Deno analogue of forge-go's `runtime.NumCPU()`.
 */
const DEFAULT_WORKER_LIMIT = Math.max(1, navigator.hardwareConcurrency);

/** A unit of work scheduled onto the pool. May be sync or async. */
export type Task = () => void | Promise<void>;

let limit = DEFAULT_WORKER_LIMIT;
let queue: Task[] = [];
let active = 0;
let running = false;
let parallel = true;

/** Enqueues a task to be executed by the worker loop. */
export function addTask(task: Task): void {
  queue.push(task);
  if (running) pump();
}

/**
 * Sets the maximum number of concurrently running tasks.
 *
 * The limit is process-wide state and reaches the loop that is already
 * running, exactly as forge-go's `SetWorkersLimit` does: raising it starts
 * queued tasks right away, lowering it takes effect as the tasks in flight
 * finish, since none of them is cancelled. A limit change never drops a queued
 * task.
 *
 * The value is applied verbatim: there is no fallback to a default, so a
 * non-positive limit leaves the loop without an execution slot and tasks stay
 * queued until a positive limit is configured.
 *
 * One difference remains with forge-go: the limit bounds its queue too, so a
 * full queue blocks the producer there. `addTask` is synchronous here and
 * cannot apply that backpressure, so the limit bounds concurrency only.
 */
export function setWorkersLimit(value: number): void {
  limit = value;
  if (running) pump();
}

/**
 * Selects the dispatch mode.
 *
 * Like the limit, the mode is process-wide state and reaches the loop that is
 * already running — as it does in forge-go, which reads its flag on every
 * dispatch rather than capturing it at `RunWorkers`.
 *
 * `true` (the default) starts up to the configured limit of tasks
 * concurrently. `false` serializes dispatch: one task at a time, in queue
 * order, and the next task never starts before the current one settles. The
 * limit is not consulted for the serialization — sequential mode runs a single
 * task even when the limit is far higher, which is what forge-go's
 * `SetParallelism` does.
 */
export function setParallelism(value: boolean): void {
  parallel = value;
  if (running) pump();
}

/** Starts the managed worker loop if one is not already running. */
export function runWorkers(): void {
  if (running) return;
  running = true;
  pump();
}

/** Stops the worker loop. In-flight tasks finish; queued tasks remain. */
export function stopWorkers(): void {
  running = false;
}

/** Stops the worker loop and starts it again. */
export function restartWorkers(): void {
  stopWorkers();
  runWorkers();
}

/**
 * Drains the pending queue and restores the default limit and dispatch mode.
 *
 * In-flight tasks are allowed to finish and continue to consume pool capacity
 * until they do. This keeps the concurrency bound intact if the loop is
 * started again before those tasks complete.
 */
export function resetWorkers(): void {
  stopWorkers();
  queue = [];
  limit = DEFAULT_WORKER_LIMIT;
  parallel = true;
}

/** Pulls tasks off the queue while capacity, mode and the running flag allow it. */
function pump(): void {
  // Sequential dispatch caps in-flight work at a single task whatever the
  // configured limit is; a non-positive limit still means no slot at all.
  const slots = parallel ? limit : Math.min(limit, 1);
  while (running && active < slots && queue.length > 0) {
    const task = queue.shift()!;
    active++;
    Promise.resolve()
      .then(task)
      .catch((err) => console.error("workers: task failed:", err))
      .finally(() => {
        active--;
        if (running) pump();
      });
  }
}
