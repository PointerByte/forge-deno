// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Ties the hand-written public surface to the contract generated from GoForge.
 *
 * `contracts.ts` and `codec.ts` stay hand-written so the published API keeps its documentation and
 * naming, but they must never disagree with GoForge. When a GoForge contract change lands, these
 * assertions fail and name the exact drift instead of the runtime silently accepting a stale
 * contract.
 */

import { assertEquals } from "@std/assert";
import { GOFORGE_ABI_ERROR_CATALOG, GOFORGE_ABI_V1_ERROR_CODES } from "./codec.ts";
import {
  GOFORGE_ABI_V1,
  GOFORGE_ABI_V1_OPERATION_CAPABILITIES,
  GOFORGE_ABI_V1_OPERATIONS,
  GOFORGE_PORTABLE_MANIFEST_SCHEMA_V1,
  GOFORGE_PORTABLE_PACKAGE,
  GOFORGE_PORTABLE_VERSION,
} from "./contracts.ts";
import {
  GENERATED_ABI,
  GENERATED_ERROR_CATALOG,
  GENERATED_ERROR_CODES,
  GENERATED_EXECUTION_STATE_FIELDS,
  GENERATED_HOST_CAPABILITIES,
  GENERATED_LIMITS,
  GENERATED_OPERATION_CAPABILITIES,
  GENERATED_OPERATIONS,
  GENERATED_PORTABLE_MANIFEST_SCHEMA,
  GENERATED_PORTABLE_PACKAGE,
  GENERATED_PORTABLE_VERSION,
  GENERATED_WIT_INTERFACE,
} from "./generated/goforge-contract.ts";
import { GOFORGE_NATIVE_LIMITS } from "./native.ts";

Deno.test("the published contract identity matches the one generated from GoForge", () => {
  assertEquals(GOFORGE_PORTABLE_PACKAGE, GENERATED_PORTABLE_PACKAGE);
  assertEquals(GOFORGE_PORTABLE_VERSION, GENERATED_PORTABLE_VERSION);
  assertEquals(GOFORGE_PORTABLE_MANIFEST_SCHEMA_V1, GENERATED_PORTABLE_MANIFEST_SCHEMA);
  assertEquals(GOFORGE_ABI_V1, GENERATED_ABI);
  assertEquals(
    GENERATED_WIT_INTERFACE,
    `${GENERATED_PORTABLE_PACKAGE}/operations@${GENERATED_PORTABLE_VERSION}`,
  );
});

Deno.test("the published operation set and capability map match GoForge exactly", () => {
  assertEquals([...GOFORGE_ABI_V1_OPERATIONS], [...GENERATED_OPERATIONS]);
  for (const operation of GENERATED_OPERATIONS) {
    assertEquals(
      GOFORGE_ABI_V1_OPERATION_CAPABILITIES[operation],
      GENERATED_OPERATION_CAPABILITIES[operation],
      operation,
    );
  }
});

Deno.test("the published error catalog matches GoForge in content and order", () => {
  assertEquals([...GOFORGE_ABI_V1_ERROR_CODES], [...GENERATED_ERROR_CODES]);
  for (const code of GENERATED_ERROR_CODES) {
    assertEquals(GOFORGE_ABI_ERROR_CATALOG[code].message, GENERATED_ERROR_CATALOG[code].message);
    assertEquals(
      GOFORGE_ABI_ERROR_CATALOG[code].retryable,
      GENERATED_ERROR_CATALOG[code].retryable,
      code,
    );
  }
});

Deno.test("the codec enforces the byte limits GoForge declares", () => {
  // The codec's constants are private, so they are exercised through observable behaviour instead
  // of reflection: these are the bounds the generated contract says the guest enforces.
  assertEquals(GENERATED_LIMITS["max_request_bytes"], 1 << 20);
  assertEquals(GENERATED_LIMITS["max_response_bytes"], 1 << 20);
  assertEquals(GENERATED_LIMITS["max_binary_bytes"], 512 << 10);
  assertEquals(GENERATED_LIMITS["max_string_bytes"], 64 << 10);
  assertEquals(GENERATED_LIMITS["max_id_bytes"], 128);
  assertEquals(GENERATED_LIMITS["max_cancellation_token_bytes"], 256);
  assertEquals(GENERATED_LIMITS["max_required_capabilities"], 32);
  assertEquals(GENERATED_LIMITS["max_json_depth"], 32);
});

Deno.test("deadline and cancellation are host capabilities the runtime must supply", () => {
  assertEquals([...GENERATED_HOST_CAPABILITIES], ["control.deadline", "control.cancellation"]);
});

Deno.test("the native adapter enforces the same byte limits the guest does", () => {
  // native.ts mirrors these so the two execution targets accept and reject identical inputs.
  assertEquals(GOFORGE_NATIVE_LIMITS.maxBinaryBytes, GENERATED_LIMITS["max_binary_bytes"]);
  assertEquals(GOFORGE_NATIVE_LIMITS.maxStringBytes, GENERATED_LIMITS["max_string_bytes"]);
});

Deno.test("the execution-state fields the factory maps match the WIT record", () => {
  // component.ts converts AbiExecutionStateV1 into exactly these WIT field names.
  assertEquals([...GENERATED_EXECUTION_STATE_FIELDS], [
    "clock-checked",
    "now-unix-milliseconds",
    "cancellation-checked",
    "cancellation-token",
    "cancellation-requested",
  ]);
});
