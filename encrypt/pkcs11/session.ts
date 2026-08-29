// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Library, slot and session lifecycle.
 *
 * `C_Initialize` may run only once per library per process, and PKCS#11 login
 * state is per-token rather than per-session, so both are owned here and
 * shared by every provider pointing at the same file. Sessions are handed out
 * exclusively: `C_FindObjectsInit`/`C_FindObjects`/`C_FindObjectsFinal` and
 * `C_SignInit`/`C_Sign` are stateful pairs on one session and cannot
 * interleave — which, in a runtime where every FFI call is awaited, is a real
 * hazard rather than a theoretical one.
 *
 * @module
 */

import { mechanismName } from "./cryptoki.ts";
import { Pkcs11Error, Pkcs11UnsupportedMechanismError } from "./errors.ts";
import { loadModule } from "./ffi.ts";
import type { Pkcs11Module, SessionHandle } from "./interface.ts";
import type { ResolvedOptions } from "./config.ts";

/** One loaded PKCS#11 library, shared by every provider that names it. */
interface ModuleEntry {
  module: Pkcs11Module;
  /**
   * Resolved tokens, keyed by the selector that found them and holding the
   * in-flight promise rather than the value. Concurrent first calls would
   * otherwise each build their own {@link SlotState}, and with it their own
   * session pool, which quietly defeats the session bound.
   */
  slots: Map<string, Promise<SlotState>>;
}

const registry = new Map<string, Promise<ModuleEntry>>();

/**
 * Canonicalises a library path for registry lookup, so
 * `/usr/lib64/softhsm/libsofthsm.so` and its symlink target collapse onto one
 * entry instead of initializing the library twice.
 *
 * A path that cannot be resolved — including one this process may not read —
 * is used as given, so a missing file still produces a load error rather than
 * a confusing path error.
 */
function canonicalPath(path: string): string {
  try {
    return Deno.realPathSync(path);
  } catch {
    return path;
  }
}

/**
 * Returns the shared entry for `path`, loading and initializing the library on
 * first use.
 */
function acquireModule(options: ResolvedOptions): Promise<ModuleEntry> {
  if (options.module) {
    // An injected module is owned by its caller, never registered, and never
    // shared: two tests injecting two fakes must not collide.
    return injectedEntry(options.module);
  }

  const key = canonicalPath(options.modulePath);
  const existing = registry.get(key);
  if (existing) return existing;

  const entry = (async (): Promise<ModuleEntry> => {
    const module = loadModule(key);
    await module.initialize();
    return { module, slots: new Map() };
  })();
  registry.set(key, entry);
  // A library that fails to load must not poison the registry: the next call
  // should try again rather than replay the failure forever.
  entry.catch(() => registry.delete(key));
  return entry;
}

const injected = new WeakMap<Pkcs11Module, Promise<ModuleEntry>>();

/** Wraps an injected module in an entry, initializing it once. */
function injectedEntry(module: Pkcs11Module): Promise<ModuleEntry> {
  const existing = injected.get(module);
  if (existing) return existing;
  const entry = (async (): Promise<ModuleEntry> => {
    await module.initialize();
    return { module, slots: new Map() };
  })();
  injected.set(module, entry);
  entry.catch(() => injected.delete(module));
  return entry;
}

/**
 * Releases every session this process holds on `path` and forgets the entry.
 *
 * It deliberately does not call `C_Finalize` by default: two providers may
 * share the library through paths `realPath` could not collapse, and
 * finalizing under a live user is far worse than leaving the library
 * initialized for the life of the process.
 */
export async function releaseModule(path: string, finalize = false): Promise<void> {
  const key = canonicalPath(path);
  const entry = registry.get(key);
  if (!entry) return;
  registry.delete(key);

  const resolved = await entry.catch(() => undefined);
  if (!resolved) return;

  for (const pending of resolved.slots.values()) {
    const slot = await pending.catch(() => undefined);
    if (!slot) continue;
    await slot.pool.drain(resolved.module);
    // Closing every session on a slot makes the token drop the login, so the
    // cached flag has to go with them or the next session would skip
    // C_Login and fail with CKR_USER_NOT_LOGGED_IN.
    slot.resetLogin();
  }
  if (finalize) await resolved.module.finalize();
}

/** Per-token state: the advertised mechanism set, the session pool, login. */
export class SlotState {
  /** The `CK_SLOT_ID` this state describes. */
  readonly id: number;
  /** The session pool bound to this slot. */
  readonly pool: SessionPool;
  #mechanisms: Set<number>;
  #loggedIn = false;
  #login?: Promise<void>;

  /** Binds cached token state to a slot. */
  constructor(id: number, mechanisms: number[], maxSessions: number) {
    this.id = id;
    this.#mechanisms = new Set(mechanisms);
    this.pool = new SessionPool(id, maxSessions);
  }

  /** Reports whether the token advertised `mechanism` in `C_GetMechanismList`. */
  supports(mechanism: number): boolean {
    return this.#mechanisms.has(mechanism);
  }

  /**
   * Throws a descriptive error when the token cannot perform `mechanism`. It
   * never downgrades the operation to software: a caller asking for a
   * hardware-backed operation has to be told when the hardware cannot do it.
   */
  requireMechanism(mechanism: number): void {
    if (!this.supports(mechanism)) {
      throw new Pkcs11UnsupportedMechanismError(mechanismName(mechanism));
    }
  }

  /**
   * Authenticates once per token. PKCS#11 login state is per-slot and shared
   * across the application's sessions, so repeating it is both unnecessary
   * and, on some tokens, an error.
   */
  login(
    module: Pkcs11Module,
    session: SessionHandle,
    pin: NonNullable<ResolvedOptions["pin"]>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#loggedIn) return Promise.resolve();
    if (this.#login) return this.#login;

    const attempt = (async () => {
      let secret: string;
      try {
        secret = await pin(signal);
      } catch (cause) {
        throw new Pkcs11Error("pkcs11: obtain pin", { cause });
      }
      await module.login(session, secret);
      this.#loggedIn = true;
    })();

    this.#login = attempt;
    attempt.catch(() => {}).finally(() => {
      this.#login = undefined;
    });
    return attempt;
  }

  /**
   * Clears the login flag after the token dropped the session, so a network
   * HSM that restarts is re-authenticated instead of failing forever.
   */
  resetLogin(): void {
    this.#loggedIn = false;
  }
}

/**
 * Hands out exclusive sessions, opening one when none is idle and bounding how
 * many exist at once.
 */
export class SessionPool {
  #slot: number;
  #size: number;
  #open = 0;
  #idle: SessionHandle[] = [];
  #waiters: Array<(value: void) => void> = [];

  /** Creates a pool of at most `size` sessions on `slot`. */
  constructor(slot: number, size: number) {
    this.#slot = slot;
    this.#size = Math.max(size, 1);
  }

  /**
   * Takes a session, opening one if none is idle.
   *
   * This is the only place cancellation is honoured: a PKCS#11 call already in
   * flight cannot be interrupted, so a signal gates entry rather than aborting
   * work.
   */
  async acquire(module: Pkcs11Module, signal?: AbortSignal): Promise<SessionHandle> {
    signal?.throwIfAborted();
    for (;;) {
      const idle = this.#idle.pop();
      if (idle !== undefined) return idle;

      // Claiming the slot happens in the same synchronous step as the check,
      // which is what keeps the bound real: several callers reaching acquire
      // before any of them awaits must not all see spare capacity.
      if (this.#open < this.#size) {
        this.#open++;
        try {
          return await module.openSession(this.#slot);
        } catch (error) {
          this.#open--;
          this.#wake();
          throw error;
        }
      }
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
      signal?.throwIfAborted();
    }
  }

  /**
   * Returns a session to the pool, or closes it when the operation failed in a
   * way that leaves the session unusable.
   */
  async release(module: Pkcs11Module, session: SessionHandle, failure?: unknown): Promise<void> {
    if (failure !== undefined && sessionIsDead(failure)) {
      this.#open--;
      try {
        await module.closeSession(session);
      } catch {
        // The session is already gone; nothing left to close.
      }
      this.#wake();
      return;
    }
    this.#idle.push(session);
    this.#wake();
  }

  /** Closes every idle session. */
  async drain(module: Pkcs11Module): Promise<void> {
    const sessions = this.#idle.splice(0);
    this.#open -= sessions.length;
    for (const session of sessions) {
      try {
        await module.closeSession(session);
      } catch {
        // Draining is best-effort: a token that already dropped the session
        // has nothing left to close.
      }
    }
    this.#wake();
  }

  /** Lets one waiter retry now that capacity may exist. */
  #wake(): void {
    this.#waiters.shift()?.();
  }
}

/**
 * Reports whether a failure means the session is gone, in which case it must
 * be closed rather than returned to the pool.
 */
export function sessionIsDead(failure: unknown): boolean {
  const ckr = (failure as { ckr?: string } | undefined)?.ckr;
  return ckr === "CKR_SESSION_CLOSED" || ckr === "CKR_SESSION_HANDLE_INVALID" ||
    ckr === "CKR_DEVICE_REMOVED" || ckr === "CKR_CRYPTOKI_NOT_INITIALIZED";
}

/** What a token operation receives: the module, the slot state, a session. */
export type TokenOperation<T> = (
  module: Pkcs11Module,
  slot: SlotState,
  session: SessionHandle,
) => Promise<T>;

/**
 * Resolves the configured token, acquires an exclusive session, logs in once
 * and runs `operation`.
 */
export async function withSession<T>(
  options: ResolvedOptions,
  signal: AbortSignal | undefined,
  operation: TokenOperation<T>,
): Promise<T> {
  signal?.throwIfAborted();

  const entry = await acquireModule(options);
  const slot = await resolveSlot(entry, options);
  const session = await slot.pool.acquire(entry.module, signal);

  try {
    await slot.login(entry.module, session, options.pin!, signal);
    const result = await operation(entry.module, slot, session);
    await slot.pool.release(entry.module, session);
    return result;
  } catch (failure) {
    await slot.pool.release(entry.module, session, failure);
    if (sessionIsDead(failure)) slot.resetLogin();
    throw failure;
  }
}

/** Resolves the configured token to a cached {@link SlotState}. */
function resolveSlot(entry: ModuleEntry, options: ResolvedOptions): Promise<SlotState> {
  const key = options.tokenLabel !== "" ? `label:${options.tokenLabel}` : `slot:${options.slotId}`;

  const cached = entry.slots.get(key);
  if (cached) return cached;

  const pending = (async () => {
    const slots = await entry.module.slots(true);
    const match = options.tokenLabel !== ""
      ? slots.find((slot) => slot.tokenLabel === options.tokenLabel)
      : slots.find((slot) => slot.id === options.slotId);

    if (!match) {
      throw new Pkcs11Error(
        options.tokenLabel !== ""
          ? `pkcs11: no token with label ${JSON.stringify(options.tokenLabel)}`
          : `pkcs11: no token in slot ${options.slotId}`,
      );
    }

    const mechanisms = await entry.module.mechanisms(match.id);
    // The token's own session ceiling wins when it is lower than the
    // configured one: exceeding it fails with CKR_SESSION_COUNT on the call,
    // not at configuration time.
    const bound = match.maxSessions > 0
      ? Math.min(options.maxSessions, match.maxSessions)
      : options.maxSessions;
    return new SlotState(match.id, mechanisms, bound);
  })();

  entry.slots.set(key, pending);
  // A token that was absent must not stay cached as absent.
  pending.catch(() => entry.slots.delete(key));
  return pending;
}
