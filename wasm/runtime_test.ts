// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { NativeAdapterRegistry, recordParityQualification } from "./adapters.ts";
import { createAbiFailureResponse, createAbiSuccessResponse } from "./codec.ts";
import type { AbiExecutionStateV1, AbiRequestV1, WasmRuntimeEvent } from "./contracts.ts";
import {
  WasmAdapterError,
  WasmCancelledError,
  WasmClosedError,
  WasmCodecError,
  WasmCompatibilityError,
  WasmDeadlineExceededError,
  WasmGuestError,
  WasmIntegrityError,
  WasmInvocationError,
  WasmPoolError,
} from "./errors.ts";
import {
  GoforgeWasmRuntime,
  type GoforgeWasmRuntimeOptions,
  type WasmComponentFactory,
} from "./runtime.ts";
import {
  createPortableManifestJson,
  createTestBundle,
  deferred,
  type TestBundle,
} from "./test_support.ts";

type Handler = (
  request: AbiRequestV1,
  state: AbiExecutionStateV1,
  instanceId: number,
) => string | Promise<string>;

class TestFactory implements WasmComponentFactory {
  creates = 0;
  closes = 0;
  readonly #handler: Handler;

  constructor(handler: Handler = echoHandler) {
    this.#handler = handler;
  }

  create(_bundle: unknown, context: { instanceId: number }) {
    this.creates++;
    return {
      manifest: () => createPortableManifestJson(),
      dispatch: (json: string, state: AbiExecutionStateV1) =>
        this.#handler(JSON.parse(json) as AbiRequestV1, state, context.instanceId),
      close: () => {
        this.closes++;
      },
    };
  }
}

function echoHandler(request: AbiRequestV1): string {
  return JSON.stringify(createAbiSuccessResponse(request.id, request.payload));
}

function runtimeFor(
  bundle: TestBundle,
  factory: TestFactory,
  options: Partial<GoforgeWasmRuntimeOptions> = {},
): GoforgeWasmRuntime {
  return new GoforgeWasmRuntime({
    bundle: bundle.locator,
    compatibility: bundle.compatibility,
    readArtifact: bundle.readArtifact,
    factory,
    requestId: () => "request-test",
    ...options,
  });
}

Deno.test("runtime remains lazy and passes raw canonical JSON through a verified component", async () => {
  const bundle = await createTestBundle();
  const factory = new TestFactory();
  const runtime = runtimeFor(bundle, factory);

  assertEquals(runtime.health(), {
    state: "idle",
    verified: false,
    activeInstances: 0,
    totalInstances: 0,
    queuedCalls: 0,
    poolSize: 4,
  });
  assertEquals(bundle.reads, []);
  assertEquals(factory.creates, 0);

  const result = await runtime.invoke<{ data: string }>(
    "crypto.sha256",
    { data: "AQL/" },
  );
  assertEquals(result, { data: "AQL/" });
  assertEquals(bundle.reads.length, 4);
  assertEquals(factory.creates, 1);
  assertEquals(runtime.health().state, "ready");
  await runtime.close();
  assertEquals(factory.closes, 1);
});

Deno.test("preload shares verification without creating component instances", async () => {
  const bundle = await createTestBundle();
  const factory = new TestFactory();
  const runtime = runtimeFor(bundle, factory);

  const [left, right] = await Promise.all([runtime.preload(), runtime.preload()]);
  assertEquals(left.verified, true);
  assertEquals(right.verified, true);
  assertEquals(bundle.reads.filter((path) => path === "manifest.json").length, 1);
  assertEquals(factory.creates, 0);
  await runtime.close();
});

Deno.test("portable manifest drift is rejected before the first component dispatch", async () => {
  const bundle = await createTestBundle();
  let dispatches = 0;
  const factory: WasmComponentFactory = {
    create() {
      const manifest = JSON.parse(createPortableManifestJson());
      manifest.operations[0].capability = "crypto.sha256";
      return {
        manifest: () => JSON.stringify(manifest),
        dispatch() {
          dispatches++;
          return "";
        },
      };
    },
  };
  const runtime = new GoforgeWasmRuntime({
    bundle: bundle.locator,
    compatibility: bundle.compatibility,
    readArtifact: bundle.readArtifact,
    factory,
  });
  const error = await assertRejects(() => runtime.invoke("text.normalize", { value: "x" }));
  assertInstanceOf(error, WasmCompatibilityError);
  assertEquals(dispatches, 0);
  await runtime.close();
});

Deno.test("bounded pool schedules concurrent calls without exceeding its instance limit", async () => {
  const bundle = await createTestBundle();
  let active = 0;
  let maximum = 0;
  const factory = new TestFactory(async (request) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return JSON.stringify(createAbiSuccessResponse(request.id, request.id));
  });
  let ids = 0;
  const runtime = runtimeFor(bundle, factory, {
    poolSize: 2,
    requestId: () => `request-${++ids}`,
  });

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) => runtime.invoke("text.normalize", index)),
  );
  assertEquals(results.length, 8);
  assertEquals(maximum, 2);
  assertEquals(factory.creates, 2);
  assertEquals(runtime.health().activeInstances, 0);
  await runtime.close();
});

Deno.test("queued cancellation does not invoke or consume a component instance", async () => {
  const bundle = await createTestBundle();
  const entered = deferred<void>();
  const release = deferred<void>();
  let invocations = 0;
  const factory = new TestFactory(async (request) => {
    invocations++;
    entered.resolve();
    await release.promise;
    return JSON.stringify(createAbiSuccessResponse(request.id, null));
  });
  const runtime = runtimeFor(bundle, factory, { poolSize: 1 });
  const first = runtime.invoke("text.validate", null, { requestId: "request-first" });
  await entered.promise;
  const controller = new AbortController();
  const second = runtime.invoke("text.validate", null, {
    requestId: "request-second",
    signal: controller.signal,
  });
  controller.abort("secret caller reason");
  const error = await assertRejects(() => second);
  assertInstanceOf(error, WasmCancelledError);
  assertEquals(error.message.includes("secret"), false);
  assertEquals(invocations, 1);
  release.resolve();
  await first;
  await runtime.close();
});

Deno.test("already-aborted calls fail before manifest I/O or component execution", async () => {
  const bundle = await createTestBundle();
  const factory = new TestFactory();
  const runtime = runtimeFor(bundle, factory);
  const controller = new AbortController();
  controller.abort(new Error("not observable"));

  const error = await assertRejects(() =>
    runtime.invoke("text.normalize", null, {
      signal: controller.signal,
    })
  );
  assertInstanceOf(error, WasmCancelledError);
  assertEquals(bundle.reads, []);
  assertEquals(factory.creates, 0);
  await runtime.close();
});

Deno.test("deadline aborts cooperative work and discards the affected instance", async () => {
  const bundle = await createTestBundle();
  const factory = new TestFactory((_request, _state) =>
    new Promise<string>((_resolve, reject) => {
      // The generated dispatch seam is synchronous from the guest's perspective. Simulate an
      // unsettled generated promise; host cancellation still discards its lease.
      setTimeout(() => reject(new Error("late guest rejection")), 50);
    })
  );
  const runtime = runtimeFor(bundle, factory, { poolSize: 1 });

  const error = await assertRejects(() => runtime.invoke("text.validate", null, { timeoutMs: 5 }));
  assertInstanceOf(error, WasmDeadlineExceededError);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assertEquals(runtime.health().totalInstances, 0);
  assertEquals(factory.closes, 1);
  await runtime.close();
});

Deno.test("runtime maps canonical metadata to separately checked Go execution state", async () => {
  const bundle = await createTestBundle();
  let capturedRequest: AbiRequestV1 | undefined;
  let capturedState: AbiExecutionStateV1 | undefined;
  const factory = new TestFactory((request, state) => {
    capturedRequest = request;
    capturedState = state;
    return JSON.stringify(createAbiSuccessResponse(request.id, { digest: "" }));
  });
  const runtime = runtimeFor(bundle, factory, { now: () => 1_000 });

  await runtime.invoke("crypto.sha256", { data: "" }, {
    deadline: 2_000,
    cancellationToken: "cancel-1",
    requiredCapabilities: ["crypto.sha256", "control.deadline", "control.cancellation"],
  });
  assertEquals(capturedRequest?.metadata, {
    deadline_unix_ms: 2_000,
    cancellation_token: "cancel-1",
    required_capabilities: ["crypto.sha256", "control.deadline", "control.cancellation"],
  });
  assertEquals(capturedState, {
    clockChecked: true,
    nowUnixMilliseconds: 1_000,
    cancellationChecked: true,
    cancellationToken: "cancel-1",
    cancellationRequested: false,
  });
  await runtime.close();
});

Deno.test("deadline and cancellation guest failures are never retried", async () => {
  for (const code of ["deadline_exceeded", "cancellation_requested"] as const) {
    const bundle = await createTestBundle();
    let calls = 0;
    const sleeps: number[] = [];
    const factory = new TestFactory((request) => {
      calls++;
      return JSON.stringify(createAbiFailureResponse(request.id, { code }));
    });
    const runtime = runtimeFor(bundle, factory, {
      retryPolicy: {
        maxAttempts: 3,
        initialDelayMs: 7,
        maxDelayMs: 20,
        transientCodes: [code],
      },
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });

    const error = await assertRejects(() =>
      runtime.invoke("crypto.sha256", null, { allowRetry: true })
    );
    assertInstanceOf(error, WasmGuestError);
    assertEquals(calls, 1);
    assertEquals(sleeps, []);
    await runtime.close();
  }
});

Deno.test("unsafe and non-opted calls never retry a transient guest error", async () => {
  for (
    const [operation, allowRetry] of [
      ["crypto.aes-gcm.encrypt", true],
      ["crypto.sha256", false],
    ] as const
  ) {
    const bundle = await createTestBundle();
    let calls = 0;
    const factory = new TestFactory((request) => {
      calls++;
      return JSON.stringify(createAbiFailureResponse(request.id, {
        code: "deadline_exceeded",
      }));
    });
    const runtime = runtimeFor(bundle, factory);
    const error = await assertRejects(() => runtime.invoke(operation, null, { allowRetry }));
    assertInstanceOf(error, WasmGuestError);
    assertEquals(calls, 1);
    await runtime.close();
  }
});

Deno.test("native adapter routing is explicit, manifest-approved, and ABI-validated", async () => {
  const bundle = await createTestBundle();
  const factory = new TestFactory();
  let adapterCalls = 0;
  let adapterClosed = 0;
  const adapters = new NativeAdapterRegistry().register(recordParityQualification({
    name: "normalize-native",
    operations: ["text.normalize"],
    parityQualified: true,
    invoke(request) {
      adapterCalls++;
      return Promise.resolve(createAbiSuccessResponse(
        request.id,
        request.payload,
      ));
    },
    close() {
      adapterClosed++;
    },
  }));
  const runtime = runtimeFor(bundle, factory, { adapters });

  assertEquals(
    await runtime.invoke("text.normalize", "native", {
      target: { kind: "native", adapter: "normalize-native" },
    }),
    "native",
  );
  assertEquals(adapterCalls, 1);
  assertEquals(factory.creates, 0);
  await runtime.close();
  assertEquals(adapterClosed, 1);
});

Deno.test("component failure never falls back to a registered native adapter", async () => {
  const bundle = await createTestBundle();
  const factory = new TestFactory(() => {
    throw new Error("component trap");
  });
  let adapterCalls = 0;
  const adapters = new NativeAdapterRegistry().register(recordParityQualification({
    name: "normalize-native",
    operations: ["text.normalize"],
    parityQualified: true,
    invoke(request) {
      adapterCalls++;
      return Promise.resolve(createAbiSuccessResponse(request.id, "fallback"));
    },
  }));
  const runtime = runtimeFor(bundle, factory, { adapters });

  const error = await assertRejects(() => runtime.invoke("text.normalize", null));
  assertInstanceOf(error, WasmInvocationError);
  assertEquals(adapterCalls, 0);
  await runtime.close();
});

Deno.test("native adapters fail closed when unqualified or absent from the manifest allowlist", async () => {
  for (
    const [operation, name, qualified] of [
      ["crypto.hmac-sha256", "hash-native", false],
      ["text.normalize", "not-approved", true],
    ] as const
  ) {
    const bundle = await createTestBundle();
    const candidate = {
      name,
      operations: [operation],
      parityQualified: qualified,
      invoke(request: Readonly<AbiRequestV1>) {
        return Promise.resolve(createAbiSuccessResponse(request.id, "unsafe"));
      },
    };
    // The qualified case stands in for an adapter that really ran the vectors;
    // the unqualified case must stay unrecorded, which is the point of the test.
    const adapters = new NativeAdapterRegistry().register(
      qualified ? recordParityQualification(candidate) : candidate,
    );
    const runtime = runtimeFor(bundle, new TestFactory(), { adapters });
    const error = await assertRejects(() =>
      runtime.invoke(operation, null, {
        target: { kind: "native", adapter: name },
      })
    );
    assertInstanceOf(error, WasmAdapterError);
    await runtime.close();
  }
});

Deno.test("integrity and factory failures remain typed and execute no guest code", async () => {
  const tampered = await createTestBundle();
  tampered.files.set("generated/goforge.core.wasm", new Uint8Array([0]));
  const integrityFactory = new TestFactory();
  const integrityRuntime = runtimeFor(tampered, integrityFactory);
  const integrityError = await assertRejects(() => integrityRuntime.invoke("text.normalize", null));
  assertInstanceOf(integrityError, WasmIntegrityError);
  assertEquals(integrityFactory.creates, 0);
  await integrityRuntime.close();

  const valid = await createTestBundle();
  const failedFactory: WasmComponentFactory = {
    create() {
      throw new Error("factory detail");
    },
  };
  const factoryRuntime = new GoforgeWasmRuntime({
    bundle: valid.locator,
    compatibility: valid.compatibility,
    readArtifact: valid.readArtifact,
    factory: failedFactory,
  });
  const factoryError = await assertRejects(() => factoryRuntime.invoke("text.normalize", null));
  assertInstanceOf(factoryError, WasmPoolError);
  await factoryRuntime.close();
});

Deno.test("malformed component response discards its instance and remains a codec error", async () => {
  const bundle = await createTestBundle();
  const factory = new TestFactory((request) =>
    JSON.stringify({
      abi: "goforge.abi.v1",
      id: `${request.id}-wrong`,
      ok: true,
      result: null,
    })
  );
  const runtime = runtimeFor(bundle, factory, { poolSize: 1 });

  const error = await assertRejects(() => runtime.invoke("text.normalize", null));
  assertInstanceOf(error, WasmCodecError);
  assertEquals(runtime.health().totalInstances, 0);
  assertEquals(factory.closes, 1);
  await runtime.close();
});

Deno.test("observability events are redacted and observer failures are non-authoritative", async () => {
  const bundle = await createTestBundle();
  const events: WasmRuntimeEvent[] = [];
  const runtime = runtimeFor(bundle, new TestFactory(), {
    observer(event) {
      events.push(event as WasmRuntimeEvent);
      if (event.type === "call.start") throw new Error("telemetry unavailable");
    },
  });

  assertEquals(await runtime.invoke("text.normalize", { password: "do-not-log" }), {
    password: "do-not-log",
  });
  assert(events.some((event) => event.type === "load.success"));
  assert(events.some((event) => event.type === "call.success"));
  const serialized = JSON.stringify(events);
  assertEquals(serialized.includes("do-not-log"), false);
  assertEquals(serialized.includes("password"), false);
  await runtime.close();
});

Deno.test("close aborts active work, is idempotent, and rejects future calls", async () => {
  const bundle = await createTestBundle();
  const entered = deferred<void>();
  const factory = new TestFactory((request) => {
    entered.resolve();
    return new Promise<string>((resolve) => {
      setTimeout(() => resolve(JSON.stringify(createAbiSuccessResponse(request.id, null))), 20);
    });
  });
  const runtime = runtimeFor(bundle, factory);
  const call = runtime.invoke("text.validate", null);
  await entered.promise;
  const firstClose = runtime.close();
  const secondClose = runtime.close();
  assert(firstClose === secondClose);
  const callError = await assertRejects(() => call);
  assertInstanceOf(callError, WasmClosedError);
  await firstClose;
  assertEquals(runtime.health().state, "closed");
  const futureError = await assertRejects(() => runtime.invoke("text.normalize", null));
  assertInstanceOf(futureError, WasmClosedError);
});

Deno.test("close propagates component cleanup failures after reaching closed state", async () => {
  const bundle = await createTestBundle();
  const factory: WasmComponentFactory = {
    create() {
      return {
        manifest() {
          return createPortableManifestJson();
        },
        dispatch(json) {
          const request = JSON.parse(json) as AbiRequestV1;
          return JSON.stringify(createAbiSuccessResponse(request.id, null));
        },
        close() {
          throw new Error("instance cleanup failed");
        },
      };
    },
  };
  const runtime = new GoforgeWasmRuntime({
    bundle: bundle.locator,
    compatibility: bundle.compatibility,
    readArtifact: bundle.readArtifact,
    factory,
  });
  await runtime.invoke("text.normalize", null);

  const error = await assertRejects(() => runtime.close());
  assertInstanceOf(error, WasmClosedError);
  assertEquals(runtime.health().state, "closed");
});
