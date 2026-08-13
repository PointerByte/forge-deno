import assert from "node:assert/strict";

import {
  ComponentChecksumError,
  ComponentClosedError,
  ComponentCompatibilityError,
  type ComponentManifest,
  GoforgeComponentHost,
  loadManifest,
} from "./host.ts";

// El componente lo produce TinyGo en forge-go-private y vive bajo
// research/tinygo-wasip2/artifacts/, que esta gitignoreado: el arbol que copia
// el CI nunca lo contiene. Los casos que cargan el componente real se omiten
// cuando falta, igual que la suite diferencial de wasm/native_test.ts.
const componentAvailable = await (async (): Promise<boolean> => {
  try {
    const manifest = await loadManifest();
    await Deno.stat(
      new URL(manifest.component.path, new URL("./", import.meta.url)),
    );
    return true;
  } catch {
    return false;
  }
})();

Deno.test({
  name: "Deno invokes every canonical ABI shape and the host import",
  ignore: !componentAvailable,
  async fn() {
    const manifest = await loadManifest();
    const host = await GoforgeComponentHost.load(manifest);

    assert.equal(host.operations.add(20, 22), 42);
    assert.equal(host.operations.greet("Deno"), "hello, Deno");
    assert.deepEqual(
      host.operations.reverseBytes(new Uint8Array([0, 1, 2, 255])),
      new Uint8Array([255, 2, 1, 0]),
    );
    assert.deepEqual(
      host.operations.summarize({ left: 20, right: 22 }),
      { total: 42, label: "sum:42" },
    );
    assert.equal(host.operations.annotate("capability"), "[host:capability]");
    assert.equal(host.annotationCalls, 1);

    assert.throws(
      () => host.operations.summarize({ left: 0, right: 0 }),
      (error: unknown) => {
        const payload = (error as { payload?: unknown }).payload;
        assert.deepEqual(payload, {
          tag: "invalid-input",
          val: "both values must not be zero",
        });
        return true;
      },
    );
    assert.throws(
      () => host.operations.summarize({ left: 0xffff_ffff, right: 1 }),
      (error: unknown) => {
        assert.deepEqual((error as { payload?: unknown }).payload, {
          tag: "overflow",
        });
        return true;
      },
    );

    host.close();
    assert.throws(() => host.operations, ComponentClosedError);
    host.close();
  },
});

Deno.test({
  name: "concurrent startup and calls are isolated",
  ignore: !componentAvailable,
  async fn() {
    const manifest = await loadManifest();
    const hosts = await Promise.all(
      Array.from({ length: 4 }, () => GoforgeComponentHost.load(manifest)),
    );

    const results = await Promise.all(
      Array.from(
        { length: 128 },
        (_, index) =>
          Promise.resolve().then(() => hosts[index % hosts.length].operations.add(index, 1)),
      ),
    );
    assert.deepEqual(
      results,
      Array.from({ length: 128 }, (_, index) => index + 1),
    );

    for (const host of hosts) host.close();
    for (const host of hosts) {
      assert.throws(() => host.operations, ComponentClosedError);
    }
  },
});

Deno.test("incompatible component version is rejected before instantiation", async () => {
  const manifest = await loadManifest();
  const incompatible: ComponentManifest = {
    ...manifest,
    componentVersion: "2.0.0",
  };

  await assert.rejects(
    GoforgeComponentHost.load(incompatible),
    ComponentCompatibilityError,
  );
});

Deno.test({
  name: "component, glue, and core checksum mismatches are rejected",
  ignore: !componentAvailable,
  async fn() {
    const manifest = await loadManifest();
    const badComponent: ComponentManifest = {
      ...manifest,
      component: { ...manifest.component, sha256: "0".repeat(64) },
    };
    await assert.rejects(
      GoforgeComponentHost.load(badComponent),
      ComponentChecksumError,
    );

    const firstCore = Object.keys(manifest.coreModules)[0];
    const badCore: ComponentManifest = {
      ...manifest,
      coreModules: { ...manifest.coreModules, [firstCore]: "f".repeat(64) },
    };
    await assert.rejects(
      GoforgeComponentHost.load(badCore),
      ComponentChecksumError,
    );

    const badGlue: ComponentManifest = {
      ...manifest,
      hostGlue: { ...manifest.hostGlue, sha256: "a".repeat(64) },
    };
    await assert.rejects(
      GoforgeComponentHost.load(badGlue),
      ComponentChecksumError,
    );
  },
});
