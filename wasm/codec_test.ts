// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import {
  createAbiFailureResponse,
  createAbiRequest,
  createAbiSuccessResponse,
  decodeAbiBase64,
  decodeAbiValue,
  encodeAbiBase64,
  encodeAbiValue,
  GOFORGE_ABI_ERROR_CATALOG,
  GOFORGE_ABI_V1_ERROR_CODES,
  parseAbiResponse,
  serializeAbiRequest,
  validateAbiResponse,
} from "./codec.ts";
import { GOFORGE_ABI_V1 } from "./contracts.ts";
import { WasmCodecError } from "./errors.ts";

Deno.test("ABI codec keeps raw JSON and uses explicit canonical Base64 helpers", () => {
  const encoded = encodeAbiBase64(new Uint8Array([0, 127, 255]));
  assertEquals(encoded, "AH//");
  assertEquals(decodeAbiBase64(encoded), new Uint8Array([0, 127, 255]));

  const value = encodeAbiValue({ data: encoded, nested: [true, null, 3.25] });
  assertEquals(decodeAbiValue(value), { data: "AH//", nested: [true, null, 3.25] });
  assertThrows(() => encodeAbiValue({ data: new Uint8Array([1]) }), WasmCodecError);
  for (const invalid of ["aGVsbG8", "aGVs\nbG8=", "____", "aGVsbG8=="]) {
    assertThrows(() => decodeAbiBase64(invalid), WasmCodecError);
  }
});

Deno.test("ABI codec rejects cyclic, non-finite, unsupported, and excessively nested values", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  let nested: unknown = null;
  for (let index = 0; index < 34; index++) nested = [nested];
  for (const value of [cyclic, { value: Number.NaN }, new Date(), undefined, nested]) {
    assertThrows(() => encodeAbiValue(value), WasmCodecError);
  }
});

Deno.test("ABI request uses GoForge field names, order, metadata, and raw Base64 strings", () => {
  const request = createAbiRequest(
    "request-1",
    "crypto.sha256",
    { data: "AQ==" },
    {
      deadline_unix_ms: 99,
      cancellation_token: "cancel-1",
      required_capabilities: ["crypto.sha256", "control.deadline", "control.cancellation"],
    },
  );
  assertEquals(request.abi, GOFORGE_ABI_V1);
  assertEquals(request.id, "request-1");
  assertEquals(
    serializeAbiRequest(request),
    '{"abi":"goforge.abi.v1","id":"request-1","operation":"crypto.sha256","metadata":{"deadline_unix_ms":99,"cancellation_token":"cancel-1","required_capabilities":["crypto.sha256","control.deadline","control.cancellation"]},"payload":{"data":"AQ=="}}',
  );

  assertThrows(() => createAbiRequest("", "crypto.sha256", { data: "" }), WasmCodecError);
  assertThrows(() => createAbiRequest("bad\nid", "crypto.sha256", { data: "" }), WasmCodecError);
  assertThrows(() => createAbiRequest("ok", "security.hash", null), WasmCodecError);
  assertThrows(
    () => createAbiRequest("ok", "crypto.sha256", null, { deadline_unix_ms: 0 }),
    WasmCodecError,
  );
  assertThrows(
    () =>
      createAbiRequest("ok", "crypto.sha256", null, {
        required_capabilities: ["host.network"],
      }),
    WasmCodecError,
  );
});

Deno.test("ABI codec creates and validates canonical success and error envelopes", () => {
  const success = createAbiSuccessResponse("request-1", { digest: "AQ==" });
  const parsedSuccess = parseAbiResponse(JSON.stringify(success), "request-1");
  assert(parsedSuccess.ok);
  assertEquals(parsedSuccess.result, { digest: "AQ==" });

  const failure = createAbiFailureResponse("request-1", {
    code: "invalid_base64",
    field: "payload.data",
  });
  const parsedFailure = validateAbiResponse(failure, "request-1");
  assert(!parsedFailure.ok);
  assertEquals(parsedFailure.error, {
    code: "invalid_base64",
    message: "value is not canonical standard padded Base64",
    retryable: false,
    field: "payload.data",
  });
  assertThrows(
    () =>
      createAbiFailureResponse("request-1", {
        code: "deadline_exceeded",
        retryable: false,
      }),
    WasmCodecError,
  );
});

Deno.test("ABI response validation rejects legacy, ambiguous, or cross-request output", () => {
  const invalid: string[] = [
    "not json",
    '{"abi":"goforge.abi.v1","id":"request-2","ok":true,"result":null}',
    '{"abiVersion":"goforge.abi.v1","requestId":"request-1","ok":true,"result":null}',
    '{"abi":"goforge.abi.v2","id":"request-1","ok":true,"result":null}',
    '{"abi":"goforge.abi.v1","id":"request-1","ok":false,"error":{"code":"UNAVAILABLE","message":"x","retryable":false}}',
    '{"abi":"goforge.abi.v1","id":"request-1","ok":false,"error":{"code":"invalid_base64","message":"value is not canonical standard padded Base64","retryable":false,"details":{}}}',
    '{"abi":"goforge.abi.v1","id":"request-1","ok":true,"result":null,"extra":true}',
    '{"abi":"goforge.abi.v1","id":"request-1","id":"request-1","ok":true,"result":null}',
  ];
  for (const json of invalid) {
    const error = assertThrows(() => parseAbiResponse(json, "request-1"));
    assertInstanceOf(error, WasmCodecError);
  }
});

Deno.test("error catalog order matches the declared code sequence GoForge emits", () => {
  // assertPortableContractManifest compares the guest catalog position by position, so the object's
  // insertion order and GOFORGE_ABI_V1_ERROR_CODES must never drift apart.
  assertEquals(Object.keys(GOFORGE_ABI_ERROR_CATALOG), [...GOFORGE_ABI_V1_ERROR_CODES]);
  for (const code of GOFORGE_ABI_V1_ERROR_CODES) {
    const definition = GOFORGE_ABI_ERROR_CATALOG[code];
    assert(definition.message.length > 0, `${code} must carry a stable public message`);
    assertEquals(typeof definition.retryable, "boolean");
  }
  // deadline_exceeded is the only transient failure in ABI v1.
  assertEquals(
    GOFORGE_ABI_V1_ERROR_CODES.filter((code) => GOFORGE_ABI_ERROR_CATALOG[code].retryable),
    ["deadline_exceeded"],
  );
});
