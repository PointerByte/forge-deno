// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `Deno.dlopen`-backed implementation of {@link Pkcs11Module}.
 *
 * This is the Deno counterpart of forge-go's cgo binding: every Cryptoki
 * struct layout, every raw pointer, and the two-call size-then-fill convention
 * live here and nowhere else. forge-go gates the equivalent file behind the
 * `pkcs11` build tag so `CGO_ENABLED=0` builds keep working; the gate here is
 * the `--allow-ffi` permission, checked on first use, which turns into a
 * {@link Pkcs11UnavailableError} exactly where Go returns `ErrUnavailable`.
 *
 * ## Platform assumption
 *
 * `CK_ULONG` is taken to be 8 bytes little-endian, which is the LP64 layout
 * used by Linux and macOS. forge-go makes the same assumption in its attribute
 * encoding. Windows builds Cryptoki with a 4-byte `CK_ULONG` and packed
 * structs, so this binding refuses to load there rather than corrupting every
 * template it writes.
 *
 * @module
 */

import { type Attribute, ReturnValue, returnValueName } from "./cryptoki.ts";
import { Pkcs11TokenError, Pkcs11UnavailableError } from "./errors.ts";
import type {
  MechanismParams,
  ObjectHandle,
  Pkcs11Module,
  SessionHandle,
  SlotInfo,
} from "./interface.ts";

/** `CKF_SERIAL_SESSION | CKF_RW_SESSION`. */
const SESSION_FLAGS = 0x00000004n | 0x00000002n;
/** `CKF_OS_LOCKING_OK`. */
const OS_LOCKING_OK = 0x00000002;
/** `CKU_USER`. */
const USER_TYPE_USER = 1n;
/** `CKF_TOKEN_PRESENT` in `CK_SLOT_INFO.flags`. */
const SLOT_FLAG_TOKEN_PRESENT = 0x00000001n;
/** `CK_EFFECTIVELY_INFINITE` / `CK_UNAVAILABLE_INFORMATION`. */
const UNAVAILABLE_INFORMATION = 0xffffffffffffffffn;

const POINTER_SIZE = 8;
const ULONG_SIZE = 8;
/** `CK_ATTRIBUTE` is `{ type, pValue, ulValueLen }`. */
const ATTRIBUTE_SIZE = 24;
/** `CK_MECHANISM` is `{ mechanism, pParameter, ulParameterLen }`. */
const MECHANISM_SIZE = 24;
/** Batch size for `C_FindObjects`. */
const FIND_BATCH = 32;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Offsets of the functions this binding calls inside `CK_FUNCTION_LIST`,
 * counted in pointer slots after the leading `CK_VERSION` (which occupies a
 * full slot once padded).
 *
 * The list order is fixed by the specification, so an index is a stable ABI
 * fact rather than a guess. Going through the function list, instead of
 * resolving `C_*` symbols directly, is what makes the binding work with
 * modules that export only `C_GetFunctionList` — which is all the
 * specification requires.
 */
const FUNCTION_INDEX = {
  C_Initialize: 1,
  C_Finalize: 2,
  C_GetSlotList: 5,
  C_GetSlotInfo: 6,
  C_GetTokenInfo: 7,
  C_GetMechanismList: 8,
  C_OpenSession: 13,
  C_CloseSession: 14,
  C_Login: 19,
  C_Logout: 20,
  C_DestroyObject: 23,
  C_GetAttributeValue: 25,
  C_SetAttributeValue: 26,
  C_FindObjectsInit: 27,
  C_FindObjects: 28,
  C_FindObjectsFinal: 29,
  C_EncryptInit: 30,
  C_Encrypt: 31,
  C_DecryptInit: 34,
  C_Decrypt: 35,
  C_SignInit: 43,
  C_Sign: 44,
  C_VerifyInit: 49,
  C_Verify: 50,
  C_GenerateKey: 59,
  C_GenerateKeyPair: 60,
  C_DeriveKey: 63,
} as const;

type FunctionName = keyof typeof FUNCTION_INDEX;

const SIGNATURES: Record<FunctionName, Deno.ForeignFunction> = {
  C_Initialize: { parameters: ["pointer"], result: "u64" },
  C_Finalize: { parameters: ["pointer"], result: "u64" },
  C_GetSlotList: { parameters: ["u8", "pointer", "pointer"], result: "u64" },
  C_GetSlotInfo: { parameters: ["u64", "pointer"], result: "u64" },
  C_GetTokenInfo: { parameters: ["u64", "pointer"], result: "u64" },
  C_GetMechanismList: { parameters: ["u64", "pointer", "pointer"], result: "u64" },
  C_OpenSession: {
    parameters: ["u64", "u64", "pointer", "pointer", "pointer"],
    result: "u64",
  },
  C_CloseSession: { parameters: ["u64"], result: "u64" },
  C_Login: { parameters: ["u64", "u64", "pointer", "u64"], result: "u64" },
  C_Logout: { parameters: ["u64"], result: "u64" },
  C_DestroyObject: { parameters: ["u64", "u64"], result: "u64" },
  C_GetAttributeValue: { parameters: ["u64", "u64", "pointer", "u64"], result: "u64" },
  C_SetAttributeValue: { parameters: ["u64", "u64", "pointer", "u64"], result: "u64" },
  C_FindObjectsInit: { parameters: ["u64", "pointer", "u64"], result: "u64" },
  C_FindObjects: { parameters: ["u64", "pointer", "u64", "pointer"], result: "u64" },
  C_FindObjectsFinal: { parameters: ["u64"], result: "u64" },
  C_EncryptInit: { parameters: ["u64", "pointer", "u64"], result: "u64" },
  C_Encrypt: { parameters: ["u64", "pointer", "u64", "pointer", "pointer"], result: "u64" },
  C_DecryptInit: { parameters: ["u64", "pointer", "u64"], result: "u64" },
  C_Decrypt: { parameters: ["u64", "pointer", "u64", "pointer", "pointer"], result: "u64" },
  C_SignInit: { parameters: ["u64", "pointer", "u64"], result: "u64" },
  C_Sign: { parameters: ["u64", "pointer", "u64", "pointer", "pointer"], result: "u64" },
  C_VerifyInit: { parameters: ["u64", "pointer", "u64"], result: "u64" },
  C_Verify: { parameters: ["u64", "pointer", "u64", "pointer", "u64"], result: "u64" },
  C_GenerateKey: { parameters: ["u64", "pointer", "pointer", "u64", "pointer"], result: "u64" },
  C_GenerateKeyPair: {
    parameters: ["u64", "pointer", "pointer", "u64", "pointer", "u64", "pointer", "pointer"],
    result: "u64",
  },
  C_DeriveKey: {
    parameters: ["u64", "pointer", "u64", "pointer", "u64", "pointer"],
    result: "u64",
  },
};

/** Raises a {@link Pkcs11TokenError} unless `code` is `CKR_OK`. */
function check(fn: string, code: bigint): void {
  const value = Number(code);
  if (value === ReturnValue.Ok) return;
  throw new Pkcs11TokenError(fn, value, returnValueName(value));
}

/** True when `code` is `CKR_OK`. */
function ok(code: bigint): boolean {
  return Number(code) === ReturnValue.Ok;
}

/** Allocates a zeroed buffer and returns it with its pointer. */
function alloc(size: number): { bytes: Uint8Array; pointer: Deno.PointerValue } {
  const bytes = new Uint8Array(size);
  return { bytes, pointer: Deno.UnsafePointer.of(bytes) };
}

/** Writes a pointer value into `view` at `offset`. */
function writePointer(view: DataView, offset: number, pointer: Deno.PointerValue): void {
  view.setBigUint64(offset, Deno.UnsafePointer.value(pointer), true);
}

/** Reads a `CK_ULONG` at `offset`. */
function readUlong(view: DataView, offset: number): number {
  return Number(view.getBigUint64(offset, true));
}

/** Trims the space padding Cryptoki uses in its fixed-width text fields. */
function trimmedText(bytes: Uint8Array): string {
  return decoder.decode(bytes).replace(/\0/g, "").trimEnd();
}

/**
 * Serializes a mechanism parameter block into the C layout its structure
 * requires, returning the buffer plus every buffer it points at so the caller
 * can keep them alive for the duration of the call.
 */
function encodeParams(
  params: MechanismParams,
): { bytes: Uint8Array; retain: Uint8Array[] } {
  const retain: Uint8Array[] = [];
  const own = (value: Uint8Array): Uint8Array => {
    // A zero-length buffer has no stable address; give it one byte so the
    // pointer stays valid while ulLen stays zero.
    const copy = value.length > 0 ? Uint8Array.from(value) : new Uint8Array(1);
    retain.push(copy);
    return copy;
  };

  switch (params.kind) {
    case "gcm": {
      // CK_GCM_PARAMS { pIv, ulIvLen, ulIvBits, pAAD, ulAADLen, ulTagBits }
      const bytes = new Uint8Array(48);
      const view = new DataView(bytes.buffer);
      const iv = own(params.iv);
      const aad = own(params.aad);
      writePointer(view, 0, Deno.UnsafePointer.of(iv));
      view.setBigUint64(8, BigInt(params.iv.length), true);
      view.setBigUint64(16, BigInt(params.iv.length * 8), true);
      writePointer(view, 24, Deno.UnsafePointer.of(aad));
      view.setBigUint64(32, BigInt(params.aad.length), true);
      view.setBigUint64(40, BigInt(params.tagBits), true);
      return { bytes, retain };
    }
    case "oaep": {
      // CK_RSA_PKCS_OAEP_PARAMS { hashAlg, mgf, source, pSourceData, ulSourceDataLen }
      const bytes = new Uint8Array(40);
      const view = new DataView(bytes.buffer);
      view.setBigUint64(0, BigInt(params.hashAlg), true);
      view.setBigUint64(8, BigInt(params.mgf), true);
      view.setBigUint64(16, BigInt(params.source), true);
      view.setBigUint64(24, 0n, true);
      view.setBigUint64(32, 0n, true);
      return { bytes, retain };
    }
    case "pss": {
      // CK_RSA_PKCS_PSS_PARAMS { hashAlg, mgf, sLen }
      const bytes = new Uint8Array(24);
      const view = new DataView(bytes.buffer);
      view.setBigUint64(0, BigInt(params.hashAlg), true);
      view.setBigUint64(8, BigInt(params.mgf), true);
      view.setBigUint64(16, BigInt(params.saltLen), true);
      return { bytes, retain };
    }
    case "ecdh1": {
      // CK_ECDH1_DERIVE_PARAMS { kdf, ulSharedDataLen, pSharedData,
      //                          ulPublicDataLen, pPublicData }
      const bytes = new Uint8Array(40);
      const view = new DataView(bytes.buffer);
      const shared = own(params.sharedData);
      const publicData = own(params.publicData);
      view.setBigUint64(0, BigInt(params.kdf), true);
      view.setBigUint64(8, BigInt(params.sharedData.length), true);
      writePointer(
        view,
        16,
        params.sharedData.length > 0 ? Deno.UnsafePointer.of(shared) : null,
      );
      view.setBigUint64(24, BigInt(params.publicData.length), true);
      writePointer(view, 32, Deno.UnsafePointer.of(publicData));
      return { bytes, retain };
    }
    case "hkdf": {
      // CK_HKDF_PARAMS { bExtract, bExpand, prfHashMechanism, ulSaltType,
      //                  pSalt, ulSaltLen, hSaltKey, pInfo, ulInfoLen }
      const bytes = new Uint8Array(64);
      const view = new DataView(bytes.buffer);
      const info = own(params.info);
      view.setUint8(0, params.extract ? 1 : 0);
      view.setUint8(1, params.expand ? 1 : 0);
      view.setBigUint64(8, BigInt(params.prf), true);
      view.setBigUint64(16, BigInt(params.saltType), true);
      writePointer(view, 24, null);
      view.setBigUint64(32, 0n, true);
      view.setBigUint64(40, 0n, true);
      writePointer(view, 48, Deno.UnsafePointer.of(info));
      view.setBigUint64(56, BigInt(params.info.length), true);
      return { bytes, retain };
    }
    case "eddsa": {
      // CK_EDDSA_PARAMS { phFlag, ulContextDataLen, pContextData }
      const bytes = new Uint8Array(24);
      const view = new DataView(bytes.buffer);
      view.setUint8(0, params.phFlag ? 1 : 0);
      view.setBigUint64(8, 0n, true);
      writePointer(view, 16, null);
      return { bytes, retain };
    }
  }
}

/**
 * Builds a `CK_MECHANISM`, keeping the parameter buffers alive alongside it.
 */
function encodeMechanism(
  mechanism: number,
  params: MechanismParams | undefined,
): { bytes: Uint8Array; retain: Uint8Array[] } {
  const bytes = new Uint8Array(MECHANISM_SIZE);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, BigInt(mechanism), true);

  if (!params) {
    writePointer(view, 8, null);
    view.setBigUint64(16, 0n, true);
    return { bytes, retain: [] };
  }

  const encoded = encodeParams(params);
  writePointer(view, 8, Deno.UnsafePointer.of(encoded.bytes));
  view.setBigUint64(16, BigInt(encoded.bytes.length), true);
  return { bytes, retain: [encoded.bytes, ...encoded.retain] };
}

/**
 * Builds a `CK_ATTRIBUTE` array, keeping every value buffer alive alongside
 * it.
 */
function encodeTemplate(
  template: Attribute[],
): { bytes: Uint8Array; retain: Uint8Array[] } {
  const bytes = new Uint8Array(ATTRIBUTE_SIZE * Math.max(template.length, 1));
  const view = new DataView(bytes.buffer);
  const retain: Uint8Array[] = [];

  template.forEach((attribute, index) => {
    const offset = index * ATTRIBUTE_SIZE;
    const value = attribute.value.length > 0 ? Uint8Array.from(attribute.value) : new Uint8Array(1);
    retain.push(value);
    view.setBigUint64(offset, BigInt(attribute.type), true);
    writePointer(view, offset + 8, Deno.UnsafePointer.of(value));
    view.setBigUint64(offset + 16, BigInt(attribute.value.length), true);
  });
  return { bytes, retain };
}

/**
 * Runs the size-then-fill convention: `call` is invoked once with a null
 * output buffer to learn the length, then again with a buffer of that size.
 *
 * `elementSize` is what the reported count is counted in. Cryptoki mixes the
 * two conventions — `C_Encrypt` reports bytes, `C_GetMechanismList` reports
 * `CK_MECHANISM_TYPE` entries — and allocating bytes for a count of entries
 * overflows the buffer the module then writes into.
 */
function twoPhase(
  name: string,
  call: (out: Deno.PointerValue, length: Uint8Array) => bigint,
  elementSize = 1,
): Uint8Array {
  const length = alloc(ULONG_SIZE);
  const lengthView = new DataView(length.bytes.buffer);
  check(name, call(null, length.bytes));

  const out = alloc(Math.max(readUlong(lengthView, 0) * elementSize, 1));
  check(name, call(out.pointer, length.bytes));
  return out.bytes.slice(0, readUlong(lengthView, 0) * elementSize);
}

/**
 * Turns a non-zero address into a pointer object. The zero case is rejected by
 * the callers before they get here, so the assertion never fires in practice.
 */
function nonNull(address: bigint): NonNullable<Deno.PointerValue> {
  const pointer = Deno.UnsafePointer.create(address);
  if (pointer === null) throw new Pkcs11UnavailableError("null pointer in the function list");
  return pointer;
}

/** The dynamically loaded Cryptoki entry point. */
type Invoke = (...args: unknown[]) => bigint;

/**
 * Resolves `C_GetFunctionList`, calls it, and turns the returned
 * `CK_FUNCTION_LIST` into callable functions.
 */
function bindFunctionList(path: string): {
  call: Record<FunctionName, Invoke>;
  close: () => void;
} {
  if (Deno.build.os === "windows") {
    throw new Pkcs11UnavailableError(
      "Cryptoki on Windows uses a 4-byte CK_ULONG and packed structs, which this binding " +
        "does not encode",
    );
  }

  let library: Deno.DynamicLibrary<{
    C_GetFunctionList: { parameters: ["pointer"]; result: "u64" };
  }>;
  try {
    library = Deno.dlopen(path, {
      C_GetFunctionList: { parameters: ["pointer"], result: "u64" },
    });
  } catch (cause) {
    throw new Pkcs11UnavailableError(
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    );
  }

  const holder = alloc(POINTER_SIZE);
  check("C_GetFunctionList", library.symbols.C_GetFunctionList(holder.pointer) as bigint);

  const listAddress = new DataView(holder.bytes.buffer).getBigUint64(0, true);
  if (listAddress === 0n) {
    library.close();
    throw new Pkcs11UnavailableError("C_GetFunctionList returned a null function list");
  }
  const list = new Deno.UnsafePointerView(nonNull(listAddress));

  const call = {} as Record<FunctionName, Invoke>;
  for (const [name, index] of Object.entries(FUNCTION_INDEX) as [FunctionName, number][]) {
    const address = list.getBigUint64(index * POINTER_SIZE);
    if (address === 0n) {
      library.close();
      throw new Pkcs11UnavailableError(`the module does not implement ${name}`);
    }
    // The branded pointer type carries the signature it was created for; the
    // signature is chosen by name on the line below, so the brand is restated
    // rather than inferred.
    const fn = new Deno.UnsafeFnPointer(
      nonNull(address) as Deno.PointerObject<Deno.ForeignFunction>,
      SIGNATURES[name],
    );
    call[name] = ((...args: unknown[]) =>
      (fn.call as (...values: unknown[]) => bigint)(...args)) as Invoke;
  }

  return { call, close: () => library.close() };
}

/**
 * Loads a PKCS#11 library and returns the {@link Pkcs11Module} seam over it.
 *
 * Throws {@link Pkcs11UnavailableError} when the runtime has no FFI, when
 * `--allow-ffi` was not granted, or when the file cannot be loaded — the three
 * cases forge-go collapses into `ErrUnavailable`.
 */
export function loadModule(path: string): Pkcs11Module {
  if (typeof Deno.dlopen !== "function") {
    throw new Pkcs11UnavailableError("Deno.dlopen is not implemented by this runtime");
  }
  const { call, close } = bindFunctionList(path);
  return new FfiModule(call, close);
}

/** {@link Pkcs11Module} implemented over a bound `CK_FUNCTION_LIST`. */
class FfiModule implements Pkcs11Module {
  #call: Record<FunctionName, Invoke>;
  #close: () => void;

  /** Wraps an already-bound function list. */
  constructor(call: Record<FunctionName, Invoke>, close: () => void) {
    this.#call = call;
    this.#close = close;
  }

  /** Calls `C_Initialize` with OS locking, tolerating a second initialization. */
  initialize(): Promise<void> {
    // CK_C_INITIALIZE_ARGS { CreateMutex, DestroyMutex, LockMutex, UnlockMutex,
    //                        flags, pReserved }
    const args = alloc(48);
    new DataView(args.bytes.buffer).setBigUint64(32, BigInt(OS_LOCKING_OK), true);

    const code = this.#call.C_Initialize(args.pointer);
    if (!ok(code) && Number(code) !== ReturnValue.CryptokiAlreadyInitialized) {
      check("C_Initialize", code);
    }
    return Promise.resolve();
  }

  /** Calls `C_Finalize` and releases the library handle. */
  finalize(): Promise<void> {
    const code = this.#call.C_Finalize(null);
    this.#close();
    check("C_Finalize", code);
    return Promise.resolve();
  }

  /** Lists slots and the token in each, via `C_GetSlotList`. */
  slots(tokenPresent: boolean): Promise<SlotInfo[]> {
    const flag = tokenPresent ? 1 : 0;
    const count = alloc(ULONG_SIZE);
    check("C_GetSlotList", this.#call.C_GetSlotList(flag, null, count.pointer));

    const total = readUlong(new DataView(count.bytes.buffer), 0);
    if (total === 0) return Promise.resolve([]);

    const ids = alloc(total * ULONG_SIZE);
    check("C_GetSlotList", this.#call.C_GetSlotList(flag, ids.pointer, count.pointer));

    const idView = new DataView(ids.bytes.buffer);
    const resolved = readUlong(new DataView(count.bytes.buffer), 0);
    const out: SlotInfo[] = [];
    for (let index = 0; index < Math.min(total, resolved); index++) {
      out.push(this.#slotInfo(idView.getBigUint64(index * ULONG_SIZE, true)));
    }
    return Promise.resolve(out);
  }

  /** Reads `CK_SLOT_INFO` and `CK_TOKEN_INFO` for one slot. */
  #slotInfo(slot: bigint): SlotInfo {
    const info: SlotInfo = {
      id: Number(slot),
      tokenLabel: "",
      tokenPresent: false,
      maxSessions: 0,
    };

    const slotInfo = alloc(112);
    if (ok(this.#call.C_GetSlotInfo(slot, slotInfo.pointer))) {
      const flags = new DataView(slotInfo.bytes.buffer).getBigUint64(96, true);
      info.tokenPresent = (flags & SLOT_FLAG_TOKEN_PRESENT) !== 0n;
    }
    if (!info.tokenPresent) return info;

    // CK_TOKEN_INFO: label[32] manufacturerID[32] model[16] serialNumber[16]
    //                flags ulMaxSessionCount ...
    const tokenInfo = alloc(224);
    if (ok(this.#call.C_GetTokenInfo(slot, tokenInfo.pointer))) {
      info.tokenLabel = trimmedText(tokenInfo.bytes.subarray(0, 32));
      const maxSessions = new DataView(tokenInfo.bytes.buffer).getBigUint64(104, true);
      info.maxSessions = maxSessions === UNAVAILABLE_INFORMATION ? 0 : Number(maxSessions);
    }
    return info;
  }

  /** Lists the `CKM_` values a slot advertises. */
  mechanisms(slot: number): Promise<number[]> {
    const raw = twoPhase(
      "C_GetMechanismList",
      (out, length) =>
        this.#call.C_GetMechanismList(BigInt(slot), out, Deno.UnsafePointer.of(length)),
      ULONG_SIZE,
    );
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const out: number[] = [];
    for (let offset = 0; offset + ULONG_SIZE <= raw.byteLength; offset += ULONG_SIZE) {
      out.push(Number(view.getBigUint64(offset, true)));
    }
    return Promise.resolve(out);
  }

  /** Opens a serial read/write session. */
  openSession(slot: number): Promise<SessionHandle> {
    const handle = alloc(ULONG_SIZE);
    check(
      "C_OpenSession",
      this.#call.C_OpenSession(BigInt(slot), SESSION_FLAGS, null, null, handle.pointer),
    );
    return Promise.resolve(readUlong(new DataView(handle.bytes.buffer), 0));
  }

  /** Closes one session. */
  closeSession(session: SessionHandle): Promise<void> {
    check("C_CloseSession", this.#call.C_CloseSession(BigInt(session)));
    return Promise.resolve();
  }

  /** Logs the user in, tolerating an already-authenticated token. */
  login(session: SessionHandle, pin: string): Promise<void> {
    const encoded = encoder.encode(pin);
    const buffer = encoded.length > 0 ? encoded : new Uint8Array(1);
    try {
      const code = this.#call.C_Login(
        BigInt(session),
        USER_TYPE_USER,
        Deno.UnsafePointer.of(buffer),
        BigInt(encoded.length),
      );
      if (!ok(code) && Number(code) !== ReturnValue.UserAlreadyLoggedIn) {
        check("C_Login", code);
      }
      return Promise.resolve();
    } finally {
      // The PIN reached C memory; overwrite our copy as soon as C_Login
      // returns, the way the Go binding wipes its C buffer.
      buffer.fill(0);
    }
  }

  /** Logs the user out. */
  logout(session: SessionHandle): Promise<void> {
    check("C_Logout", this.#call.C_Logout(BigInt(session)));
    return Promise.resolve();
  }

  /** Runs a `C_FindObjectsInit`/`C_FindObjects`/`C_FindObjectsFinal` cycle. */
  findObjects(session: SessionHandle, template: Attribute[]): Promise<ObjectHandle[]> {
    const encoded = encodeTemplate(template);
    check(
      "C_FindObjectsInit",
      this.#call.C_FindObjectsInit(
        BigInt(session),
        Deno.UnsafePointer.of(encoded.bytes),
        BigInt(template.length),
      ),
    );

    const handles: ObjectHandle[] = [];
    try {
      const batch = alloc(FIND_BATCH * ULONG_SIZE);
      const count = alloc(ULONG_SIZE);
      const batchView = new DataView(batch.bytes.buffer);
      const countView = new DataView(count.bytes.buffer);

      for (;;) {
        check(
          "C_FindObjects",
          this.#call.C_FindObjects(
            BigInt(session),
            batch.pointer,
            BigInt(FIND_BATCH),
            count.pointer,
          ),
        );
        const found = readUlong(countView, 0);
        for (let index = 0; index < found; index++) {
          handles.push(Number(batchView.getBigUint64(index * ULONG_SIZE, true)));
        }
        if (found < FIND_BATCH) break;
      }
    } finally {
      this.#call.C_FindObjectsFinal(BigInt(session));
      // Keep the template alive until the search is over.
      encoded.retain.length;
    }
    return Promise.resolve(handles);
  }

  /**
   * Reads attributes with the size-then-fill convention, reporting attributes
   * the object does not carry as `present: false` instead of failing.
   */
  getAttributes(
    session: SessionHandle,
    object: ObjectHandle,
    types: number[],
  ): Promise<Attribute[]> {
    const sizes = new Uint8Array(ATTRIBUTE_SIZE * Math.max(types.length, 1));
    const sizeView = new DataView(sizes.buffer);
    types.forEach((type, index) => {
      const offset = index * ATTRIBUTE_SIZE;
      sizeView.setBigUint64(offset, BigInt(type), true);
      writePointer(sizeView, offset + 8, null);
      sizeView.setBigUint64(offset + 16, 0n, true);
    });

    // A single unreadable or absent attribute makes the whole call return
    // CKR_ATTRIBUTE_SENSITIVE / CKR_ATTRIBUTE_TYPE_INVALID while still filling
    // in the lengths of the ones it could read, so the result is used either
    // way and the per-attribute -1 length is what marks the failures.
    this.#call.C_GetAttributeValue(
      BigInt(session),
      BigInt(object),
      Deno.UnsafePointer.of(sizes),
      BigInt(types.length),
    );

    const values: Uint8Array[] = [];
    const out: Attribute[] = [];
    const fill = new Uint8Array(ATTRIBUTE_SIZE * Math.max(types.length, 1));
    const fillView = new DataView(fill.buffer);
    let wanted = 0;

    types.forEach((type, index) => {
      const offset = index * ATTRIBUTE_SIZE;
      const length = sizeView.getBigUint64(offset + 16, true);
      const unavailable = length === UNAVAILABLE_INFORMATION;
      const size = unavailable ? 0 : Number(length);
      const buffer = new Uint8Array(Math.max(size, 1));
      values.push(buffer);

      fillView.setBigUint64(offset, BigInt(type), true);
      if (unavailable) {
        writePointer(fillView, offset + 8, null);
        fillView.setBigUint64(offset + 16, UNAVAILABLE_INFORMATION, true);
        return;
      }
      wanted++;
      writePointer(fillView, offset + 8, Deno.UnsafePointer.of(buffer));
      fillView.setBigUint64(offset + 16, BigInt(size), true);
    });

    if (wanted > 0) {
      this.#call.C_GetAttributeValue(
        BigInt(session),
        BigInt(object),
        Deno.UnsafePointer.of(fill),
        BigInt(types.length),
      );
    }

    types.forEach((type, index) => {
      const offset = index * ATTRIBUTE_SIZE;
      const length = fillView.getBigUint64(offset + 16, true);
      if (length === UNAVAILABLE_INFORMATION) {
        out.push({ type, value: new Uint8Array(0), present: false });
        return;
      }
      out.push({ type, value: values[index].slice(0, Number(length)), present: true });
    });
    return Promise.resolve(out);
  }

  /** Writes attributes onto an existing object. */
  setAttributes(
    session: SessionHandle,
    object: ObjectHandle,
    template: Attribute[],
  ): Promise<void> {
    const encoded = encodeTemplate(template);
    check(
      "C_SetAttributeValue",
      this.#call.C_SetAttributeValue(
        BigInt(session),
        BigInt(object),
        Deno.UnsafePointer.of(encoded.bytes),
        BigInt(template.length),
      ),
    );
    return Promise.resolve();
  }

  /** Destroys an object. */
  destroyObject(session: SessionHandle, object: ObjectHandle): Promise<void> {
    check("C_DestroyObject", this.#call.C_DestroyObject(BigInt(session), BigInt(object)));
    return Promise.resolve();
  }

  /** Creates a secret key object. */
  generateKey(
    session: SessionHandle,
    mechanism: number,
    template: Attribute[],
  ): Promise<ObjectHandle> {
    const mech = encodeMechanism(mechanism, undefined);
    const encoded = encodeTemplate(template);
    const handle = alloc(ULONG_SIZE);
    check(
      "C_GenerateKey",
      this.#call.C_GenerateKey(
        BigInt(session),
        Deno.UnsafePointer.of(mech.bytes),
        Deno.UnsafePointer.of(encoded.bytes),
        BigInt(template.length),
        handle.pointer,
      ),
    );
    return Promise.resolve(readUlong(new DataView(handle.bytes.buffer), 0));
  }

  /** Creates a key pair, returning the public handle first. */
  generateKeyPair(
    session: SessionHandle,
    mechanism: number,
    publicTemplate: Attribute[],
    privateTemplate: Attribute[],
  ): Promise<[ObjectHandle, ObjectHandle]> {
    const mech = encodeMechanism(mechanism, undefined);
    const publicEncoded = encodeTemplate(publicTemplate);
    const privateEncoded = encodeTemplate(privateTemplate);
    const publicHandle = alloc(ULONG_SIZE);
    const privateHandle = alloc(ULONG_SIZE);
    check(
      "C_GenerateKeyPair",
      this.#call.C_GenerateKeyPair(
        BigInt(session),
        Deno.UnsafePointer.of(mech.bytes),
        Deno.UnsafePointer.of(publicEncoded.bytes),
        BigInt(publicTemplate.length),
        Deno.UnsafePointer.of(privateEncoded.bytes),
        BigInt(privateTemplate.length),
        publicHandle.pointer,
        privateHandle.pointer,
      ),
    );
    return Promise.resolve([
      readUlong(new DataView(publicHandle.bytes.buffer), 0),
      readUlong(new DataView(privateHandle.bytes.buffer), 0),
    ]);
  }

  /** Derives a key from a base key. */
  deriveKey(
    session: SessionHandle,
    mechanism: number,
    params: MechanismParams | undefined,
    base: ObjectHandle,
    template: Attribute[],
  ): Promise<ObjectHandle> {
    const mech = encodeMechanism(mechanism, params);
    const encoded = encodeTemplate(template);
    const handle = alloc(ULONG_SIZE);
    check(
      "C_DeriveKey",
      this.#call.C_DeriveKey(
        BigInt(session),
        Deno.UnsafePointer.of(mech.bytes),
        BigInt(base),
        Deno.UnsafePointer.of(encoded.bytes),
        BigInt(template.length),
        handle.pointer,
      ),
    );
    return Promise.resolve(readUlong(new DataView(handle.bytes.buffer), 0));
  }

  /** Single-part encryption. */
  encrypt(
    session: SessionHandle,
    mechanism: number,
    params: MechanismParams | undefined,
    key: ObjectHandle,
    plaintext: Uint8Array,
  ): Promise<Uint8Array> {
    const mech = encodeMechanism(mechanism, params);
    check(
      "C_EncryptInit",
      this.#call.C_EncryptInit(
        BigInt(session),
        Deno.UnsafePointer.of(mech.bytes),
        BigInt(key),
      ),
    );
    const input = plaintext.length > 0 ? Uint8Array.from(plaintext) : new Uint8Array(1);
    return Promise.resolve(twoPhase("C_Encrypt", (out, length) =>
      this.#call.C_Encrypt(
        BigInt(session),
        Deno.UnsafePointer.of(input),
        BigInt(plaintext.length),
        out,
        Deno.UnsafePointer.of(length),
      )));
  }

  /** Single-part decryption. */
  decrypt(
    session: SessionHandle,
    mechanism: number,
    params: MechanismParams | undefined,
    key: ObjectHandle,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array> {
    const mech = encodeMechanism(mechanism, params);
    check(
      "C_DecryptInit",
      this.#call.C_DecryptInit(
        BigInt(session),
        Deno.UnsafePointer.of(mech.bytes),
        BigInt(key),
      ),
    );
    const input = ciphertext.length > 0 ? Uint8Array.from(ciphertext) : new Uint8Array(1);
    return Promise.resolve(twoPhase("C_Decrypt", (out, length) =>
      this.#call.C_Decrypt(
        BigInt(session),
        Deno.UnsafePointer.of(input),
        BigInt(ciphertext.length),
        out,
        Deno.UnsafePointer.of(length),
      )));
  }

  /** Single-part signature. */
  sign(
    session: SessionHandle,
    mechanism: number,
    params: MechanismParams | undefined,
    key: ObjectHandle,
    message: Uint8Array,
  ): Promise<Uint8Array> {
    const mech = encodeMechanism(mechanism, params);
    check(
      "C_SignInit",
      this.#call.C_SignInit(BigInt(session), Deno.UnsafePointer.of(mech.bytes), BigInt(key)),
    );
    const input = message.length > 0 ? Uint8Array.from(message) : new Uint8Array(1);
    return Promise.resolve(twoPhase("C_Sign", (out, length) =>
      this.#call.C_Sign(
        BigInt(session),
        Deno.UnsafePointer.of(input),
        BigInt(message.length),
        out,
        Deno.UnsafePointer.of(length),
      )));
  }

  /** Single-part verification; an invalid signature raises `CKR_SIGNATURE_INVALID`. */
  verify(
    session: SessionHandle,
    mechanism: number,
    params: MechanismParams | undefined,
    key: ObjectHandle,
    message: Uint8Array,
    signature: Uint8Array,
  ): Promise<void> {
    const mech = encodeMechanism(mechanism, params);
    check(
      "C_VerifyInit",
      this.#call.C_VerifyInit(BigInt(session), Deno.UnsafePointer.of(mech.bytes), BigInt(key)),
    );
    const input = message.length > 0 ? Uint8Array.from(message) : new Uint8Array(1);
    const tag = signature.length > 0 ? Uint8Array.from(signature) : new Uint8Array(1);
    check(
      "C_Verify",
      this.#call.C_Verify(
        BigInt(session),
        Deno.UnsafePointer.of(input),
        BigInt(message.length),
        Deno.UnsafePointer.of(tag),
        BigInt(signature.length),
      ),
    );
    return Promise.resolve();
  }
}
