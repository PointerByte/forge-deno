import { wasiImports } from "./wasi.ts";

export const EXPECTED_COMPONENT_VERSION = "0.1.0";
export const EXPECTED_WIT_PACKAGE = "pointerbyte:goforge-poc@0.1.0";

export interface ComponentManifest {
  schemaVersion: number;
  componentVersion: string;
  witPackage: string;
  component: {
    path: string;
    sha256: string;
  };
  hostGlue: {
    path: string;
    sha256: string;
  };
  coreModules: Record<string, string>;
}

interface Operations {
  add(left: number, right: number): number;
  greet(name: string): string;
  reverseBytes(value: Uint8Array): Uint8Array;
  summarize(
    value: { left: number; right: number },
  ): { total: number; label: string };
  annotate(value: string): string;
}

interface Root {
  operations: Operations;
  "pointerbyte:goforge-poc/operations@0.1.0": Operations;
}

interface GeneratedHostModule {
  instantiate(
    getCoreModule: (
      name: string,
    ) => WebAssembly.Module | Promise<WebAssembly.Module>,
    imports: unknown,
  ): Root | Promise<Root>;
}

export class ComponentCompatibilityError extends Error {}
export class ComponentChecksumError extends Error {}
export class ComponentClosedError extends Error {}

export class GoforgeComponentHost {
  #root: Root | undefined;
  readonly #getAnnotationCalls: () => number;

  private constructor(root: Root, getAnnotationCalls: () => number) {
    this.#root = root;
    this.#getAnnotationCalls = getAnnotationCalls;
  }

  static async load(
    manifest: ComponentManifest,
    baseUrl: URL = new URL("./", import.meta.url),
  ): Promise<GoforgeComponentHost> {
    validateCompatibility(manifest);

    const componentUrl = new URL(manifest.component.path, baseUrl);
    await verifyFile(componentUrl, manifest.component.sha256);
    const glueUrl = new URL(manifest.hostGlue.path, baseUrl);
    await verifyFile(glueUrl, manifest.hostGlue.sha256);

    const compiled = new Map<string, WebAssembly.Module>();
    for (const [name, expectedHash] of Object.entries(manifest.coreModules)) {
      const url = new URL(`./generated/${name}`, baseUrl);
      const bytes = await readVerified(url, expectedHash);
      compiled.set(
        name,
        await WebAssembly.compile(Uint8Array.from(bytes).buffer),
      );
    }

    let annotationCalls = 0;
    const imports = {
      "pointerbyte:goforge-poc/host": {
        annotate(value: string): string {
          annotationCalls++;
          return `[host:${value}]`;
        },
      },
      ...wasiImports,
    };

    // jco 1.26.1's runtime removes interface versions in instantiation-mode
    // lookup keys, while its generated declaration retains them. The cast is
    // intentionally kept at this one documented compatibility seam.
    const generated = await import(glueUrl.href) as GeneratedHostModule;
    const root = await generated.instantiate(
      (name: string) => {
        const module = compiled.get(name);
        if (!module) {
          throw new ComponentCompatibilityError(
            `unmanifested core module: ${name}`,
          );
        }
        return module;
      },
      imports as never,
    );

    return new GoforgeComponentHost(root, () => annotationCalls);
  }

  get operations(): Root["operations"] {
    if (!this.#root) {
      throw new ComponentClosedError("component host is closed");
    }
    return this.#root.operations;
  }

  get annotationCalls(): number {
    return this.#getAnnotationCalls();
  }

  close(): void {
    this.#root = undefined;
  }
}

export async function loadManifest(
  url: URL = new URL("./manifest.json", import.meta.url),
): Promise<ComponentManifest> {
  return JSON.parse(await Deno.readTextFile(url)) as ComponentManifest;
}

function validateCompatibility(manifest: ComponentManifest): void {
  if (manifest.schemaVersion !== 1) {
    throw new ComponentCompatibilityError(
      `unsupported manifest schema ${manifest.schemaVersion}`,
    );
  }
  if (manifest.componentVersion !== EXPECTED_COMPONENT_VERSION) {
    throw new ComponentCompatibilityError(
      `component ${manifest.componentVersion} is incompatible with host ${EXPECTED_COMPONENT_VERSION}`,
    );
  }
  if (manifest.witPackage !== EXPECTED_WIT_PACKAGE) {
    throw new ComponentCompatibilityError(
      `WIT package ${manifest.witPackage} is incompatible with ${EXPECTED_WIT_PACKAGE}`,
    );
  }
}

async function verifyFile(url: URL, expectedHash: string): Promise<void> {
  await readVerified(url, expectedHash);
}

async function readVerified(
  url: URL,
  expectedHash: string,
): Promise<Uint8Array> {
  const bytes = await Deno.readFile(url);
  const actual = await sha256(bytes);
  if (actual !== expectedHash) {
    throw new ComponentChecksumError(
      `SHA-256 mismatch for ${url.pathname}: expected ${expectedHash}, got ${actual}`,
    );
  }
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
  );
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0"))
    .join("");
}
