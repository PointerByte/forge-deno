// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { NativeAdapterRegistry, type NativeWasmAdapter } from "./adapters.ts";
import {
  createAbiRequest,
  parseAbiResponse,
  serializeAbiRequest,
  validateAbiResponse,
} from "./codec.ts";
import type {
  AbiExecutionStateV1,
  AbiRequestMetadataV1,
  AbiResponseV1,
  GoforgeAbiOperationV1,
  VerifiedWasmBundle,
  WasmBundleLocator,
  WasmCallOptions,
  WasmCompatibility,
  WasmRetryPolicy,
  WasmRuntimeEvent,
  WasmRuntimeHealth,
  WasmRuntimeObserver,
  WasmRuntimeState,
} from "./contracts.ts";
import {
  WasmAdapterError,
  WasmCancelledError,
  WasmClosedError,
  WasmCompatibilityError,
  WasmDeadlineExceededError,
  WasmGuestError,
  WasmInvocationError,
  WasmPoolError,
  WasmRuntimeError,
} from "./errors.ts";
import {
  assertPortableContractManifest,
  verifyWasmBundle,
  type WasmArtifactReader,
} from "./manifest.ts";

const defaultRetryPolicy: WasmRetryPolicy = {
  maxAttempts: 2,
  initialDelayMs: 25,
  maxDelayMs: 250,
  transientCodes: [],
};

/** Metadata passed to the injected component instance factory. */
export interface WasmComponentFactoryContext {
  /** Stable monotonic instance number scoped to one runtime. */
  instanceId: number;
  /** Runtime-shutdown signal. */
  signal: AbortSignal;
}

/** A generated component host instance hidden behind the stable JSON ABI. */
export interface WasmComponentInstance {
  /** Returns the canonical manifest exported by GoForge portable. */
  manifest(): string | Promise<string>;
  /** Dispatches one request with separately checked host execution state. */
  dispatch(requestJson: string, state: AbiExecutionStateV1): string | Promise<string>;
  /** Releases resources held by the generated instance. */
  close?(): void | Promise<void>;
}

/** Injected seam that turns verified bundle bytes into isolated host instances. */
export interface WasmComponentFactory {
  /** Creates one instance after every bundle artifact has passed validation. */
  create(
    bundle: Readonly<VerifiedWasmBundle>,
    context: WasmComponentFactoryContext,
  ): WasmComponentInstance | Promise<WasmComponentInstance>;
}

/** Construction options for {@link GoforgeWasmRuntime}. */
export interface GoforgeWasmRuntimeOptions {
  /** Trusted manifest location and digest. */
  bundle: WasmBundleLocator;
  /** Exact host/component/WIT compatibility contract. */
  compatibility: WasmCompatibility;
  /** Reader scoped to the approved package artifact directory. */
  readArtifact: WasmArtifactReader;
  /** Factory for reviewed generated glue; no research path is imported by the runtime. */
  factory: WasmComponentFactory;
  /** Maximum simultaneously initialized component instances; defaults to four. */
  poolSize?: number;
  /** Default relative call timeout; omitted means no relative timeout. */
  defaultTimeoutMs?: number;
  /** Bounded exponential policy used only by explicitly safe calls. */
  retryPolicy?: Partial<WasmRetryPolicy>;
  /** Registry for explicit native routes. */
  adapters?: NativeAdapterRegistry;
  /** Redacted lifecycle event receiver. */
  observer?: WasmRuntimeObserver;
  /** Deterministic clock seam, primarily for testing. */
  now?: () => number;
  /** Deterministic request-ID seam, primarily for testing. */
  requestId?: () => string;
  /** Deterministic sleep seam, primarily for testing. */
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Lazy, integrity-checked GoForge component runtime with bounded isolated instances.
 *
 * Importing or constructing the class performs no I/O. The first `invoke` or `preload` shares one
 * verification promise. Component failures never select a native adapter automatically.
 */
export class GoforgeWasmRuntime {
  readonly #options: GoforgeWasmRuntimeOptions;
  readonly #poolSize: number;
  readonly #retry: WasmRetryPolicy;
  readonly #adapters: NativeAdapterRegistry;
  readonly #shutdown = new AbortController();
  readonly #now: () => number;
  readonly #requestId: () => string;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  #state: WasmRuntimeState = "idle";
  #lastErrorCode: string | undefined;
  #loadPromise: Promise<VerifiedWasmBundle> | undefined;
  #pool: InstancePool | undefined;
  #closePromise: Promise<void> | undefined;
  #activeCalls = 0;
  #activeWaiters: Array<() => void> = [];
  readonly #background = new Set<Promise<unknown>>();

  /** Creates a side-effect-free lazy runtime. */
  constructor(options: GoforgeWasmRuntimeOptions) {
    this.#options = options;
    this.#poolSize = requireInteger(options.poolSize ?? 4, "poolSize", 1, 64);
    if (options.defaultTimeoutMs !== undefined) {
      requireFinite(options.defaultTimeoutMs, "defaultTimeoutMs", 0);
    }
    this.#retry = normalizeRetryPolicy(options.retryPolicy);
    this.#adapters = options.adapters ?? new NativeAdapterRegistry();
    this.#now = options.now ?? Date.now;
    this.#requestId = options.requestId ?? (() => crypto.randomUUID());
    this.#sleep = options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  /** Returns a non-blocking, payload-free health snapshot without forcing lazy loading. */
  health(): WasmRuntimeHealth {
    const stats = this.#pool?.stats() ?? { active: 0, total: 0, queued: 0 };
    const result: WasmRuntimeHealth = {
      state: this.#state,
      verified: this.#pool !== undefined,
      activeInstances: stats.active,
      totalInstances: stats.total,
      queuedCalls: stats.queued,
      poolSize: this.#poolSize,
    };
    if (this.#lastErrorCode !== undefined) result.lastErrorCode = this.#lastErrorCode;
    return result;
  }

  /** Verifies the entire bundle eagerly without creating a component instance. */
  async preload(signal?: AbortSignal): Promise<WasmRuntimeHealth> {
    this.#assertOpen();
    const scope = createAbortScope(signal, this.#shutdown.signal, undefined, this.#now());
    try {
      await raceWithSignal(this.#ensureLoaded(), scope.signal);
      return this.health();
    } finally {
      scope.dispose();
    }
  }

  /**
   * Invokes one manifest-declared operation through the component or an explicit native adapter.
   *
   * Payloads and results are raw canonical JSON. Operation-specific binary fields use padded Base64
   * strings and explicit codec helpers; the runtime never invents generic byte wrappers.
   */
  async invoke<Result = unknown>(
    operation: string,
    payload: unknown,
    options: WasmCallOptions = {},
  ): Promise<Result> {
    this.#assertOpen();
    this.#activeCalls++;
    const startedAt = this.#now();
    const requestId = options.requestId ?? this.#requestId();
    const deadline = resolveDeadline(options, this.#options.defaultTimeoutMs, startedAt);
    const scope = createAbortScope(options.signal, this.#shutdown.signal, deadline, startedAt);
    const target = options.target ?? { kind: "component" as const };
    try {
      throwIfAborted(scope.signal);
      const bundle = await raceWithSignal(this.#ensureLoaded(), scope.signal);
      const contract = bundle.manifest.operations[operation as GoforgeAbiOperationV1];
      if (!contract) {
        throw new WasmCompatibilityError(
          `operation ${JSON.stringify(operation)} is not declared by the verified manifest`,
        );
      }
      const metadata = requestMetadata(options, deadline);
      const request = createAbiRequest(requestId, operation, payload, metadata);
      const targetName = target.kind === "component" ? "component" : `native:${target.adapter}`;
      const maxAttempts = options.allowRetry && contract.retrySafe ? this.#retry.maxAttempts : 1;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const attemptStartedAt = this.#now();
        this.#emit({
          type: "call.start",
          timestamp: attemptStartedAt,
          requestId,
          operation,
          target: targetName,
          attempt,
        });
        try {
          const response = target.kind === "component"
            ? await this.#invokeComponent(
              requestId,
              serializeAbiRequest(request),
              executionState(metadata, this.#now(), scope.signal),
              scope.signal,
            )
            : await this.#invokeAdapter(
              target.adapter,
              contract.nativeAdapters ?? [],
              request,
              attempt,
              deadline,
              scope.signal,
            );
          if (!response.ok) {
            throw new WasmGuestError(response.error.code, response.error.message, {
              retryable: response.error.retryable,
              field: response.error.field,
            });
          }
          this.#state = "ready";
          this.#lastErrorCode = undefined;
          this.#emit({
            type: "call.success",
            timestamp: this.#now(),
            requestId,
            operation,
            target: targetName,
            attempt,
            durationMs: Math.max(0, this.#now() - attemptStartedAt),
          });
          return response.result as Result;
        } catch (cause) {
          const error = normalizeCallError(cause, target.kind, scope.signal);
          this.#lastErrorCode = error.code;
          const canRetry = attempt < maxAttempts && this.#isSafeTransient(error);
          this.#emit({
            type: "call.failure",
            timestamp: this.#now(),
            requestId,
            operation,
            target: targetName,
            attempt,
            durationMs: Math.max(0, this.#now() - attemptStartedAt),
            errorCode: error.code,
          });
          if (!canRetry) throw error;
          const delay = Math.min(
            this.#retry.maxDelayMs,
            this.#retry.initialDelayMs * 2 ** (attempt - 1),
          );
          this.#emit({
            type: "call.retry",
            timestamp: this.#now(),
            requestId,
            operation,
            target: targetName,
            attempt: attempt + 1,
          });
          await raceWithSignal(this.#sleep(delay), scope.signal);
        }
      }
      throw new WasmInvocationError("component retry loop ended unexpectedly");
    } finally {
      scope.dispose();
      this.#activeCalls--;
      if (this.#activeCalls === 0) {
        for (const resolve of this.#activeWaiters.splice(0)) resolve();
      }
    }
  }

  /** Cancels active work, drains settled instances, closes adapters, and rejects future calls. */
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#state = "closing";
    this.#shutdown.abort(new WasmClosedError());
    this.#emit({ type: "runtime.close", timestamp: this.#now() });
    this.#closePromise = (async () => {
      if (this.#activeCalls > 0) {
        await new Promise<void>((resolve) => this.#activeWaiters.push(resolve));
      }
      if (this.#loadPromise) await this.#loadPromise.catch(() => undefined);
      await Promise.allSettled([...this.#background]);
      const failures: unknown[] = [];
      try {
        await this.#pool?.close();
      } catch (cause) {
        failures.push(cause);
      }
      try {
        await this.#adapters.close();
      } catch (cause) {
        failures.push(cause);
      }
      this.#state = "closed";
      if (failures.length > 0) {
        throw new WasmClosedError("the runtime closed with resource cleanup failures", {
          cause: new AggregateError(failures),
        });
      }
    })();
    return this.#closePromise;
  }

  #assertOpen(): void {
    if (this.#state === "closing" || this.#state === "closed") throw new WasmClosedError();
  }

  #ensureLoaded(): Promise<VerifiedWasmBundle> {
    if (this.#loadPromise) return this.#loadPromise;
    this.#assertOpen();
    this.#state = "loading";
    const startedAt = this.#now();
    this.#emit({ type: "load.start", timestamp: startedAt });
    this.#loadPromise = verifyWasmBundle(
      this.#options.bundle,
      this.#options.compatibility,
      this.#options.readArtifact,
    ).then((bundle) => {
      if (this.#shutdown.signal.aborted) throw new WasmClosedError();
      this.#pool = new InstancePool(
        this.#poolSize,
        async (instanceId) => {
          let instance: WasmComponentInstance | undefined;
          try {
            instance = await this.#options.factory.create(bundle, {
              instanceId,
              signal: this.#shutdown.signal,
            });
            if (
              !instance || typeof instance.manifest !== "function" ||
              typeof instance.dispatch !== "function"
            ) {
              throw new TypeError("component factory returned an invalid instance");
            }
            const portableManifest = await instance.manifest();
            assertPortableContractManifest(portableManifest, bundle.manifest);
            return instance;
          } catch (cause) {
            try {
              await instance?.close?.();
            } catch (cleanupCause) {
              throw new WasmPoolError("invalid component instance also failed to close", {
                cause: new AggregateError([cause, cleanupCause]),
              });
            }
            if (cause instanceof WasmRuntimeError) throw cause;
            throw new WasmPoolError("component instance creation failed", { cause });
          }
        },
      );
      this.#state = "ready";
      this.#emit({
        type: "load.success",
        timestamp: this.#now(),
        durationMs: Math.max(0, this.#now() - startedAt),
      });
      return bundle;
    }).catch((cause) => {
      const error = normalizeLoadError(cause);
      if (this.#state !== "closing" && this.#state !== "closed") this.#state = "degraded";
      this.#lastErrorCode = error.code;
      this.#emit({
        type: "load.failure",
        timestamp: this.#now(),
        durationMs: Math.max(0, this.#now() - startedAt),
        errorCode: error.code,
      });
      throw error;
    });
    return this.#loadPromise;
  }

  async #invokeComponent(
    requestId: string,
    requestJson: string,
    state: AbiExecutionStateV1,
    signal: AbortSignal,
  ): Promise<AbiResponseV1> {
    const pool = this.#pool;
    if (!pool) throw new WasmPoolError("component instance pool is not initialized");
    if (pool.stats().active >= pool.stats().total && pool.stats().total >= this.#poolSize) {
      this.#emit({ type: "call.queued", timestamp: this.#now(), requestId });
    }
    const lease = await pool.acquire(signal);
    let raw: Promise<string>;
    try {
      throwIfAborted(signal);
      raw = Promise.resolve(lease.instance.dispatch(requestJson, state));
    } catch (cause) {
      await lease.release(true);
      throw new WasmInvocationError("component invocation failed", { cause });
    }
    const settled = raw.then(
      async (responseJson) => {
        const aborted = signal.aborted;
        if (aborted) {
          await lease.release(true);
          throw abortReason(signal);
        }
        let response: AbiResponseV1;
        try {
          response = parseAbiResponse(responseJson, requestId);
        } catch (cause) {
          await lease.release(true);
          throw cause;
        }
        await lease.release(false);
        if (aborted) throw abortReason(signal);
        return response;
      },
      async (cause) => {
        await lease.release(true);
        if (signal.aborted) throw abortReason(signal);
        throw new WasmInvocationError("component invocation failed", { cause });
      },
    );
    this.#trackBackground(settled);
    return await raceWithSignal(settled, signal);
  }

  async #invokeAdapter(
    adapterName: string,
    allowlist: readonly string[],
    request: ReturnType<typeof createAbiRequest>,
    attempt: number,
    deadlineUnixMs: number | undefined,
    signal: AbortSignal,
  ): Promise<AbiResponseV1> {
    let adapter: NativeWasmAdapter;
    try {
      adapter = this.#adapters.resolve(adapterName, request.operation, allowlist);
    } catch (cause) {
      if (cause instanceof WasmAdapterError) throw cause;
      throw new WasmAdapterError("native adapter selection failed", { cause });
    }
    const execution = Promise.resolve().then(() =>
      adapter.invoke(request, { signal, attempt, deadlineUnixMs })
    );
    this.#trackBackground(execution);
    let response: AbiResponseV1;
    try {
      response = await raceWithSignal(execution, signal);
    } catch (cause) {
      if (signal.aborted) throw abortReason(signal);
      if (cause instanceof WasmRuntimeError) throw cause;
      throw new WasmAdapterError("native adapter invocation failed", { cause });
    }
    return validateAbiResponse(response, request.id);
  }

  #isSafeTransient(error: WasmRuntimeError): boolean {
    return error instanceof WasmGuestError &&
      error.code !== "deadline_exceeded" && error.code !== "cancellation_requested" &&
      error.retryable &&
      this.#retry.transientCodes.includes(error.code);
  }

  #trackBackground<T>(promise: Promise<T>): void {
    this.#background.add(promise);
    promise.then(
      () => this.#background.delete(promise),
      () => this.#background.delete(promise),
    );
  }

  #emit(event: WasmRuntimeEvent): void {
    if (!this.#options.observer) return;
    try {
      this.#options.observer(Object.freeze({ ...event }));
    } catch {
      // Observability is deliberately non-authoritative and cannot affect execution.
    }
  }
}

interface PoolEntry {
  id: number;
  instance: WasmComponentInstance;
  busy: boolean;
}

interface PoolWaiter {
  signal: AbortSignal;
  resolve: (lease: InstanceLease) => void;
  reject: (cause: unknown) => void;
  dispose: () => void;
}

class InstanceLease {
  readonly instance: WasmComponentInstance;
  readonly #pool: InstancePool;
  readonly #entry: PoolEntry;
  #released = false;

  constructor(pool: InstancePool, entry: PoolEntry) {
    this.#pool = pool;
    this.#entry = entry;
    this.instance = entry.instance;
  }

  async release(discard: boolean): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    await this.#pool.release(this.#entry, discard);
  }
}

class InstancePool {
  readonly #max: number;
  readonly #create: (instanceId: number) => Promise<WasmComponentInstance>;
  readonly #entries = new Set<PoolEntry>();
  readonly #waiters: PoolWaiter[] = [];
  #creating = 0;
  #nextId = 1;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #resolveClose: (() => void) | undefined;
  #rejectClose: ((cause: unknown) => void) | undefined;
  readonly #closeFailures: unknown[] = [];
  #finalizing = false;

  constructor(max: number, create: (instanceId: number) => Promise<WasmComponentInstance>) {
    this.#max = max;
    this.#create = create;
  }

  stats(): { active: number; total: number; queued: number } {
    return {
      active: [...this.#entries].filter((entry) => entry.busy).length,
      total: this.#entries.size,
      queued: this.#waiters.length,
    };
  }

  acquire(signal: AbortSignal): Promise<InstanceLease> {
    if (this.#closed) return Promise.reject(new WasmClosedError());
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        waiter.dispose();
        reject(abortReason(signal));
        this.#pump();
      };
      const waiter: PoolWaiter = {
        signal,
        resolve,
        reject,
        dispose: () => signal.removeEventListener("abort", onAbort),
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
      this.#pump();
    });
  }

  async release(entry: PoolEntry, discard: boolean): Promise<void> {
    if (!this.#entries.has(entry)) return;
    if (discard || this.#closed) {
      this.#entries.delete(entry);
      try {
        await entry.instance.close?.();
      } catch (cause) {
        if (this.#closed) this.#closeFailures.push(cause);
        throw cause;
      } finally {
        this.#pump();
        this.#maybeFinishClose();
      }
      return;
    }
    entry.busy = false;
    this.#pump();
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.dispose();
      waiter.reject(new WasmClosedError());
    }
    this.#closePromise = new Promise((resolve, reject) => {
      this.#resolveClose = resolve;
      this.#rejectClose = reject;
    });
    this.#maybeFinishClose();
    return this.#closePromise;
  }

  #pump(): void {
    if (this.#closed) {
      this.#maybeFinishClose();
      return;
    }
    while (this.#waiters.length > 0) {
      const entry = [...this.#entries].find((candidate) => !candidate.busy);
      if (entry) {
        const waiter = this.#waiters.shift()!;
        if (waiter.signal.aborted) {
          waiter.dispose();
          waiter.reject(abortReason(waiter.signal));
          continue;
        }
        entry.busy = true;
        waiter.dispose();
        waiter.resolve(new InstanceLease(this, entry));
        continue;
      }
      if (this.#creating >= this.#waiters.length) return;
      if (this.#entries.size + this.#creating >= this.#max) return;
      this.#startCreate();
    }
  }

  #startCreate(): void {
    const instanceId = this.#nextId++;
    this.#creating++;
    this.#create(instanceId).then(
      async (instance) => {
        this.#creating--;
        if (this.#closed) {
          try {
            await instance.close?.();
          } catch (cause) {
            this.#closeFailures.push(cause);
          } finally {
            this.#maybeFinishClose();
          }
          return;
        }
        this.#entries.add({ id: instanceId, instance, busy: false });
        this.#pump();
      },
      (cause) => {
        this.#creating--;
        const waiter = this.#waiters.shift();
        if (waiter) {
          waiter.dispose();
          waiter.reject(
            cause instanceof WasmRuntimeError
              ? cause
              : new WasmPoolError("component instance creation failed", { cause }),
          );
        }
        this.#pump();
        this.#maybeFinishClose();
      },
    );
  }

  #maybeFinishClose(): void {
    if (!this.#closed || this.#finalizing || this.#creating > 0) return;
    if ([...this.#entries].some((entry) => entry.busy)) return;
    this.#finalizing = true;
    const entries = [...this.#entries];
    this.#entries.clear();
    Promise.allSettled(
      entries.map((entry) => Promise.resolve().then(() => entry.instance.close?.())),
    ).then(
      (results) => {
        const failures = this.#closeFailures.concat(
          results
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .map((result) => result.reason),
        );
        if (failures.length > 0) {
          this.#rejectClose?.(
            new WasmClosedError("one or more component instances failed to close", {
              cause: new AggregateError(failures),
            }),
          );
        } else {
          this.#resolveClose?.();
        }
      },
    );
  }
}

interface AbortScope {
  signal: AbortSignal;
  dispose(): void;
}

function createAbortScope(
  caller: AbortSignal | undefined,
  shutdown: AbortSignal,
  deadlineUnixMs: number | undefined,
  now: number,
): AbortScope {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  const forward = (signal: AbortSignal, error: WasmRuntimeError) => {
    if (signal.aborted) {
      if (!controller.signal.aborted) controller.abort(error);
      return;
    }
    const listener = () => {
      if (!controller.signal.aborted) controller.abort(error);
    };
    signal.addEventListener("abort", listener, { once: true });
    cleanups.push(() => signal.removeEventListener("abort", listener));
  };
  if (caller) forward(caller, new WasmCancelledError());
  forward(shutdown, new WasmClosedError());
  if (!controller.signal.aborted && deadlineUnixMs !== undefined) {
    if (deadlineUnixMs <= now) {
      controller.abort(new WasmDeadlineExceededError());
    } else {
      const timer = setTimeout(() => {
        if (!controller.signal.aborted) controller.abort(new WasmDeadlineExceededError());
      }, deadlineUnixMs - now);
      cleanups.push(() => clearTimeout(timer));
    }
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}

function resolveDeadline(
  options: WasmCallOptions,
  defaultTimeoutMs: number | undefined,
  now: number,
): number | undefined {
  const relative = options.timeoutMs ?? defaultTimeoutMs;
  let deadline: number | undefined;
  if (relative !== undefined) {
    requireFinite(relative, "timeoutMs", 0);
    deadline = Math.floor(now + relative);
  }
  if (options.deadline !== undefined) {
    const explicit = options.deadline instanceof Date
      ? options.deadline.getTime()
      : options.deadline;
    requireFinite(explicit, "deadline", 0);
    const normalized = Math.floor(explicit);
    deadline = deadline === undefined ? normalized : Math.min(deadline, normalized);
  }
  return deadline;
}

function requestMetadata(
  options: WasmCallOptions,
  deadlineUnixMs: number | undefined,
): AbiRequestMetadataV1 | undefined {
  const metadata: AbiRequestMetadataV1 = {};
  if (deadlineUnixMs !== undefined) metadata.deadline_unix_ms = deadlineUnixMs;
  if (options.cancellationToken !== undefined) {
    metadata.cancellation_token = options.cancellationToken;
  }
  if (options.requiredCapabilities !== undefined) {
    metadata.required_capabilities = [...options.requiredCapabilities];
  }
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

function executionState(
  metadata: AbiRequestMetadataV1 | undefined,
  nowUnixMilliseconds: number,
  signal: AbortSignal,
): AbiExecutionStateV1 {
  const cancellationToken = metadata?.cancellation_token ?? "";
  return {
    clockChecked: metadata?.deadline_unix_ms !== undefined,
    nowUnixMilliseconds: Math.floor(nowUnixMilliseconds),
    cancellationChecked: cancellationToken !== "",
    cancellationToken,
    cancellationRequested: cancellationToken !== "" && signal.aborted,
  };
}

function normalizeRetryPolicy(value: Partial<WasmRetryPolicy> | undefined): WasmRetryPolicy {
  const result: WasmRetryPolicy = {
    maxAttempts: value?.maxAttempts ?? defaultRetryPolicy.maxAttempts,
    initialDelayMs: value?.initialDelayMs ?? defaultRetryPolicy.initialDelayMs,
    maxDelayMs: value?.maxDelayMs ?? defaultRetryPolicy.maxDelayMs,
    transientCodes: value?.transientCodes ?? defaultRetryPolicy.transientCodes,
  };
  requireInteger(result.maxAttempts, "retryPolicy.maxAttempts", 1, 10);
  requireFinite(result.initialDelayMs, "retryPolicy.initialDelayMs", 0);
  requireFinite(result.maxDelayMs, "retryPolicy.maxDelayMs", result.initialDelayMs);
  if (result.transientCodes.some((code) => !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(code))) {
    throw new TypeError("retryPolicy.transientCodes must contain lowercase snake_case error codes");
  }
  return { ...result, transientCodes: [...new Set(result.transientCodes)] };
}

function normalizeLoadError(cause: unknown): WasmRuntimeError {
  if (cause instanceof WasmRuntimeError) return cause;
  return new WasmInvocationError("component bundle verification failed", { cause });
}

function normalizeCallError(
  cause: unknown,
  target: "component" | "native",
  signal: AbortSignal,
): WasmRuntimeError {
  if (signal.aborted) return abortReason(signal);
  if (cause instanceof WasmRuntimeError) return cause;
  return target === "native"
    ? new WasmAdapterError("native adapter invocation failed", { cause })
    : new WasmInvocationError("component invocation failed", { cause });
}

function abortReason(signal: AbortSignal): WasmRuntimeError {
  return signal.reason instanceof WasmRuntimeError ? signal.reason : new WasmCancelledError();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (cause) => {
        cleanup();
        reject(cause);
      },
    );
  });
}

function requireInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function requireFinite(value: number, name: string, minimum: number): void {
  if (!Number.isFinite(value) || value < minimum) {
    throw new RangeError(`${name} must be a finite number greater than or equal to ${minimum}`);
  }
}
