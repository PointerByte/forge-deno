// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared "test mode" flag.
 *
 * A simple process-wide flag that the jobs scheduler consults to suppress
 * background work during tests.
 *
 * @module
 */

let modeTest = false;

/** Returns true when shared packages are running in test mode. */
export function isModeTest(): boolean {
  return modeTest;
}

/** Enables test mode (mirrors `EnableModeTest`). */
export function enableModeTest(): void {
  modeTest = true;
}

/** Disables test mode (mirrors `DisableModeTest`). */
export function disableModeTest(): void {
  modeTest = false;
}

/**
 * Configures shared packages for test execution. Toggles the shared test-mode
 * flag consulted by the jobs scheduler.
 */
export function setModeTest(): void {
  enableModeTest();
}
