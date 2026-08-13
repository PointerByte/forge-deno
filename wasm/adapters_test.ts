// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertInstanceOf, assertRejects, assertThrows } from "@std/assert";
import {
  NativeAdapterRegistry,
  type NativeWasmAdapter,
  recordParityQualification,
} from "./adapters.ts";
import { createAbiSuccessResponse } from "./codec.ts";
import { WasmAdapterError } from "./errors.ts";

function adapter(
  name: string,
  operations: readonly string[] = ["text.normalize"],
  parityQualified = true,
): NativeWasmAdapter {
  const built: NativeWasmAdapter = {
    name,
    operations,
    parityQualified,
    invoke(request) {
      return Promise.resolve(createAbiSuccessResponse(request.id, null));
    },
  };
  // Test adapters stand in for ones that really ran the vectors, so the
  // qualification has to be recorded the same way production records it.
  return parityQualified ? recordParityQualification(built) : built;
}

Deno.test("adapter registry lists deterministically and supports explicit unregister", () => {
  const registry = new NativeAdapterRegistry()
    .register(adapter("z-adapter"))
    .register(adapter("a-adapter"));
  assertEquals(registry.names(), ["a-adapter", "z-adapter"]);
  assertEquals(registry.unregister("a-adapter"), true);
  assertEquals(registry.unregister("missing"), false);
  assertEquals(registry.names(), ["z-adapter"]);
});

Deno.test("adapter registry rejects duplicate and malformed declarations", () => {
  const registry = new NativeAdapterRegistry().register(adapter("valid"));
  assertThrows(() => registry.register(adapter("valid")), WasmAdapterError);
  for (
    const invalid of [
      adapter("Invalid Name"),
      adapter("empty", []),
      adapter("duplicate", ["text.normalize", "text.normalize"]),
      { ...adapter("malformed"), parityQualified: "yes" } as unknown as NativeWasmAdapter,
    ]
  ) {
    assertThrows(() => new NativeAdapterRegistry().register(invalid), WasmAdapterError);
  }
});

Deno.test("adapter resolution independently enforces registration, manifest, operation, and parity", () => {
  const registry = new NativeAdapterRegistry()
    .register(adapter("eligible"))
    .register(adapter("wrong-operation", ["text.validate"]))
    .register(adapter("unqualified", ["text.normalize"], false));

  assertEquals(
    registry.resolve("eligible", "text.normalize", ["eligible"]).name,
    "eligible",
  );
  assertThrows(
    () => registry.resolve("missing", "text.normalize", ["missing"]),
    WasmAdapterError,
  );
  assertThrows(() => registry.resolve("eligible", "text.normalize", []), WasmAdapterError);
  assertThrows(
    () => registry.resolve("wrong-operation", "text.normalize", ["wrong-operation"]),
    WasmAdapterError,
  );
  assertThrows(
    () => registry.resolve("unqualified", "text.normalize", ["unqualified"]),
    WasmAdapterError,
  );
});

Deno.test("adapter registry closes once and rejects later mutation or resolution", async () => {
  let closes = 0;
  const value = adapter("closeable");
  value.close = () => {
    closes++;
  };
  const registry = new NativeAdapterRegistry().register(value);
  await registry.close();
  await registry.close();
  assertEquals(closes, 1);
  assertThrows(() => registry.register(adapter("later")), WasmAdapterError);
  assertThrows(() => registry.unregister("closeable"), WasmAdapterError);
  assertThrows(
    () => registry.resolve("closeable", "text.normalize", ["closeable"]),
    WasmAdapterError,
  );
});

Deno.test("adapter registry reports cleanup failures after attempting every close", async () => {
  let successfulClose = false;
  const failing = adapter("a-failing");
  failing.close = () => {
    throw new Error("close failure");
  };
  const successful = adapter("z-successful");
  successful.close = () => {
    successfulClose = true;
  };
  const registry = new NativeAdapterRegistry().register(failing).register(successful);

  const error = await assertRejects(() => registry.close());
  assertInstanceOf(error, WasmAdapterError);
  assertEquals(successfulClose, true);
});
