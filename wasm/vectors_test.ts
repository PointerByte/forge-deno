// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { createAbiFailureResponse } from "./codec.ts";
import type {
  AbiErrorV1,
  AbiExecutionStateV1,
  AbiRequestV1,
  AbiSuccessResponseV1,
} from "./contracts.ts";
import { WasmGuestError } from "./errors.ts";
import { GoforgeWasmRuntime, type WasmComponentFactory } from "./runtime.ts";
import { createPortableManifestJson, createTestBundle } from "./test_support.ts";

interface SharedVector {
  name: string;
  request: AbiRequestV1;
  response: AbiSuccessResponseV1;
}

interface SharedVectorFile {
  schema: string;
  abi: string;
  vectors: SharedVector[];
}

/**
 * The vectors are generated and owned by GoForge. This repository keeps a byte-identical vendored
 * copy so parity is provable in a standalone checkout; `shared vectors match GoForge byte for byte`
 * below fails if the two ever drift while both repositories are present.
 */
const sharedVectorUrl = new URL("./testdata/vectors/v1.json", import.meta.url);
const goforgeVectorUrl = new URL(
  "../../forge-go-private/share/portable/testdata/vectors/v1.json",
  import.meta.url,
);

Deno.test("vendored shared vectors match the GoForge source byte for byte", async () => {
  let upstream: Uint8Array;
  try {
    upstream = await Deno.readFile(goforgeVectorUrl);
  } catch {
    // GoForge is a separate repository; drift can only be checked from the migration workspace.
    return;
  }
  assertEquals(await Deno.readFile(sharedVectorUrl), upstream);
});

Deno.test("runtime sends every shared Go vector through byte-equivalent canonical envelopes", async () => {
  const vectors = JSON.parse(await Deno.readTextFile(sharedVectorUrl)) as SharedVectorFile;
  assertEquals(vectors.schema, "goforge.test-vectors.v1");
  assertEquals(vectors.abi, "goforge.abi.v1");
  assertEquals(vectors.vectors.length, 8);

  const expected = new Map(vectors.vectors.map((vector) => [vector.request.id, vector]));
  const received: string[] = [];
  const factory: WasmComponentFactory = {
    create() {
      return {
        manifest: () => createPortableManifestJson(),
        dispatch(requestJson: string, _state: AbiExecutionStateV1): string {
          received.push(requestJson);
          const request = JSON.parse(requestJson) as AbiRequestV1;
          const vector = expected.get(request.id);
          if (!vector) throw new Error(`unexpected shared-vector request ${request.id}`);
          return JSON.stringify(vector.response);
        },
      };
    },
  };
  const bundle = await createTestBundle();
  const runtime = new GoforgeWasmRuntime({
    bundle: bundle.locator,
    compatibility: bundle.compatibility,
    readArtifact: bundle.readArtifact,
    factory,
  });

  for (const vector of vectors.vectors) {
    const result = await runtime.invoke(vector.request.operation, vector.request.payload, {
      requestId: vector.request.id,
    });
    assertEquals(result, vector.response.result, vector.name);
  }
  assertEquals(
    received,
    vectors.vectors.map((vector) => JSON.stringify(vector.request)),
  );
  await runtime.close();
});

Deno.test("runtime preserves canonical Go negative error vectors including field attribution", async () => {
  const definitions: Array<{
    id: string;
    operation: AbiRequestV1["operation"];
    code: "invalid_base64" | "invalid_key" | "authentication_failed";
    field: string;
  }> = [
    {
      id: "negative-base64",
      operation: "crypto.sha256",
      code: "invalid_base64",
      field: "payload.data",
    },
    {
      id: "negative-key",
      operation: "crypto.hmac-sha256",
      code: "invalid_key",
      field: "payload.key",
    },
    {
      id: "negative-auth",
      operation: "crypto.aes-gcm.decrypt",
      code: "authentication_failed",
      field: "payload.ciphertext",
    },
  ];
  const responses = new Map(
    definitions.map((definition) => [
      definition.id,
      createAbiFailureResponse(definition.id, {
        code: definition.code,
        field: definition.field,
      }),
    ]),
  );
  const factory: WasmComponentFactory = {
    create() {
      return {
        manifest: () => createPortableManifestJson(),
        dispatch(requestJson: string): string {
          const request = JSON.parse(requestJson) as AbiRequestV1;
          const response = responses.get(request.id);
          if (!response) throw new Error(`unexpected negative-vector request ${request.id}`);
          return JSON.stringify(response);
        },
      };
    },
  };
  const bundle = await createTestBundle();
  const runtime = new GoforgeWasmRuntime({
    bundle: bundle.locator,
    compatibility: bundle.compatibility,
    readArtifact: bundle.readArtifact,
    factory,
  });

  for (const definition of definitions) {
    const error = await assertRejects(() =>
      runtime.invoke(definition.operation, {}, { requestId: definition.id })
    );
    assertInstanceOf(error, WasmGuestError);
    const expected = responses.get(definition.id)!.error as AbiErrorV1;
    assertEquals(
      {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        field: error.field,
      },
      expected,
    );
  }
  await runtime.close();
});
