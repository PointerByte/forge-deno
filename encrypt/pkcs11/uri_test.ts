// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@std/assert";
import { Pkcs11Error } from "./errors.ts";
import {
  classFromType,
  formatKeyUri,
  isKeyUri,
  keyUriHexId,
  ObjectClass,
  parseKeyUri,
  typeFromClass,
  URI_SCHEME,
} from "./uri.ts";

Deno.test("isKeyUri only accepts the pkcs11 scheme", () => {
  assert(isKeyUri("pkcs11:object=key"));
  assert(isKeyUri("  pkcs11:object=key  "));
  assert(!isKeyUri("BASE64KEYMATERIAL"));
  assert(!isKeyUri("https://example.test/key"));
  assert(!isKeyUri(""));
});

Deno.test("parseKeyUri reads the attributes the provider acts on", () => {
  const uri = parseKeyUri("pkcs11:token=forge-hsm;object=jwt-signing;id=%01%02;type=private");
  assertEquals(uri.token, "forge-hsm");
  assertEquals(uri.object, "jwt-signing");
  assertEquals(uri.id, Uint8Array.from([0x01, 0x02]));
  assertEquals(uri.class, ObjectClass.PrivateKey);
});

Deno.test("parseKeyUri ignores vendor attributes it does not model", () => {
  const uri = parseKeyUri("pkcs11:model=SoftHSM;manufacturer=Acme;object=key;serial=1234");
  assertEquals(uri.object, "key");
  assertEquals(uri.token, undefined);
});

Deno.test("parseKeyUri requires object or id", () => {
  assertThrows(() => parseKeyUri("pkcs11:token=forge-hsm"), Pkcs11Error, "must set object or id");
  assertThrows(() => parseKeyUri("pkcs11:"), Pkcs11Error, "has no attributes");
});

Deno.test("parseKeyUri rejects malformed input", () => {
  assertThrows(() => parseKeyUri("not-a-uri"), Pkcs11Error, "is not a pkcs11 uri");
  assertThrows(() => parseKeyUri("pkcs11:object"), Pkcs11Error, "malformed attribute");
  assertThrows(() => parseKeyUri("pkcs11:object=a;id=%zz"), Pkcs11Error, "invalid escape");
  assertThrows(
    () => parseKeyUri("pkcs11:object=a;type=wrapped"),
    Pkcs11Error,
    "unsupported object",
  );
});

Deno.test("parseKeyUri refuses a uri carrying the pin", () => {
  for (const attribute of ["pin-value=1234", "pin-source=/run/pin"]) {
    assertThrows(
      () => parseKeyUri(`pkcs11:object=key?${attribute}`),
      Pkcs11Error,
      "must not carry",
    );
  }
});

Deno.test("parseKeyUri accepts query attributes that are not the pin", () => {
  const uri = parseKeyUri("pkcs11:object=key?module-name=softhsm2");
  assertEquals(uri.object, "key");
});

Deno.test("formatKeyUri round-trips binary ids", () => {
  const id = Uint8Array.from([0x00, 0x1f, 0x3b, 0xff, 0x25]);
  const formatted = formatKeyUri({
    token: "forge hsm",
    object: "key",
    id,
    class: ObjectClass.SecretKey,
  });
  assert(formatted.startsWith(URI_SCHEME));
  const reparsed = parseKeyUri(formatted);
  assertEquals(reparsed.id, id);
  assertEquals(reparsed.token, "forge hsm");
  assertEquals(reparsed.object, "key");
  assertEquals(reparsed.class, ObjectClass.SecretKey);
});

Deno.test("formatKeyUri fixes attribute order so references compare equal", () => {
  const uri = { object: "key", token: "t", class: ObjectClass.PrivateKey };
  assertEquals(formatKeyUri(uri), "pkcs11:token=t;object=key;type=private");
  assertEquals(formatKeyUri(uri), formatKeyUri({ ...uri }));
});

Deno.test("formatKeyUri omits attributes that were never set", () => {
  assertEquals(formatKeyUri({ object: "key" }), "pkcs11:object=key");
});

Deno.test("keyUriHexId renders CKA_ID as lowercase hexadecimal", () => {
  assertEquals(keyUriHexId({ id: Uint8Array.from([0x0a, 0xff]) }), "0aff");
  assertEquals(keyUriHexId({ object: "key" }), "");
});

Deno.test("object classes map both ways", () => {
  for (const name of ["private", "public", "secret-key", "cert", "data"]) {
    assertEquals(typeFromClass(classFromType(name)), name);
  }
  assertThrows(() => classFromType("unknown"), Pkcs11Error);
  assertThrows(() => typeFromClass(99 as ObjectClass), Pkcs11Error);
});

Deno.test("a utf-8 label survives the escape round trip", () => {
  const formatted = formatKeyUri({ object: "clé-signature" });
  assertEquals(parseKeyUri(formatted).object, "clé-signature");
});
