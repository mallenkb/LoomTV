/**
 * The slice of WinRT and COM that the Windows media session needs, reached
 * in-process through koffi.
 *
 * `SystemMediaTransportControls` for a non-UWP desktop app comes from
 * `ISystemMediaTransportControlsInterop::GetForWindow`, which requires the
 * application's real `HWND`. That rules out a separate process: only the
 * process owning LoomTV's window can register the session, and only the
 * registering process is attributed in the Windows media flyout. So this runs
 * beside the LibVLC bridge in `libvlcPlayback.ts`, with the same koffi
 * technique the project already uses for native window handles.
 *
 * Pointers and vtable slots are 8 bytes; LoomTV ships x64 on Windows.
 */

type KoffiLibrary = {
  func: (name: string, result: string, args: unknown[]) => (...callArgs: unknown[]) => unknown;
};

export type KoffiWinRtRuntime = {
  load: (path: string) => KoffiLibrary;
  proto: (definition: string) => unknown;
  pointer: (ref: unknown) => unknown;
  register: (callback: (...args: never[]) => unknown, type: unknown) => bigint;
  unregister: (callback: bigint) => void;
  call: (value: unknown, type: unknown, ...args: unknown[]) => unknown;
  decode: (value: unknown, ...rest: unknown[]) => unknown;
  encode: (ref: unknown, ...rest: unknown[]) => void;
  address: (value: unknown) => bigint;
};

/** A COM interface pointer, as koffi marshals it. */
export type ComPointer = bigint;

const POINTER_SIZE = 8;

export const S_OK = 0;
const E_NOINTERFACE = -2147467262; // 0x80004002
const E_POINTER = -2147467261; // 0x80004003
/** `RoInitialize` reporting that the apartment already exists in another mode. */
const RPC_E_CHANGED_MODE = -2147417850; // 0x80010106

const RO_INIT_SINGLETHREADED = 0;

const IID_IUNKNOWN = '00000000-0000-0000-c000-000000000046';

/**
 * Interfaces a delegate object must refuse.
 *
 * Refusing `IAgileObject` matters most: it keeps the handler apartment-bound,
 * so WinRT marshals the callback back to the single-threaded apartment that
 * created the session. That is the thread koffi registered the callbacks on,
 * and the only thread they may be invoked from.
 */
const DENIED_INTERFACE_IIDS = new Set([
  '00000003-0000-0000-c000-000000000046', // IMarshal
  'ecc8691b-c1db-4dc0-855e-65f6c551af49', // INoMarshal
  '94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90', // IAgileObject
  'af86e2e0-b12d-4c6a-9c5a-d7aa65101e90', // IInspectable
]);

/**
 * Pack a GUID string into the 16-byte layout COM expects.
 *
 * `Data1` is a little-endian 32-bit value, `Data2` and `Data3` are
 * little-endian 16-bit values, and `Data4` is a plain byte sequence.
 */
export function guidToBuffer(guid: string): Buffer {
  const hex = guid.replace(/[{}-]/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`Malformed GUID: ${guid}`);
  const bytes = Buffer.from(hex, 'hex');
  const packed = Buffer.alloc(16);
  packed.writeUInt32LE(bytes.readUInt32BE(0), 0);
  packed.writeUInt16LE(bytes.readUInt16BE(4), 4);
  packed.writeUInt16LE(bytes.readUInt16BE(6), 6);
  bytes.copy(packed, 8, 8, 16);
  return packed;
}

/** Read the 16-byte COM layout back as a canonical lowercase GUID string. */
export function guidFromBytes(packed: Buffer): string {
  const data1 = packed.readUInt32LE(0).toString(16).padStart(8, '0');
  const data2 = packed.readUInt16LE(4).toString(16).padStart(4, '0');
  const data3 = packed.readUInt16LE(6).toString(16).padStart(4, '0');
  const data4 = packed.subarray(8, 16).toString('hex');
  return `${data1}-${data2}-${data3}-${data4.slice(0, 4)}-${data4.slice(4)}`;
}

/** Whether a delegate object should accept a QueryInterface for this IID. */
export function acceptsDelegateInterface(iid: string): boolean {
  const normalized = iid.toLowerCase();
  if (normalized === IID_IUNKNOWN) return true;
  return !DENIED_INTERFACE_IIDS.has(normalized);
}

export type WinRtBridge = ReturnType<typeof createWinRtBridge>;

export function createWinRtBridge(koffi: KoffiWinRtRuntime) {
  const combase = koffi.load('combase.dll');

  const roInitialize = combase.func('RoInitialize', 'int', ['int']);
  const windowsCreateString = combase.func('WindowsCreateString', 'int', ['str16', 'uint32', 'void *']);
  const windowsDeleteString = combase.func('WindowsDeleteString', 'int', ['void *']);
  const roGetActivationFactory = combase.func('RoGetActivationFactory', 'int', ['void *', 'void *', 'void *']);
  const roActivateInstance = combase.func('RoActivateInstance', 'int', ['void *', 'void *']);

  /** Vtable shapes this module calls. Windows x64 has a single calling convention. */
  const protos = {
    self: koffi.pointer(koffi.proto('int ComSelf(void *self)')),
    onePointer: koffi.pointer(koffi.proto('int ComOnePointer(void *self, void *a)')),
    twoPointers: koffi.pointer(koffi.proto('int ComTwoPointers(void *self, void *a, void *b)')),
    threePointers: koffi.pointer(koffi.proto('int ComThreePointers(void *self, void *a, void *b, void *c)')),
    withBool: koffi.pointer(koffi.proto('int ComBool(void *self, uint8 value)')),
    withInt: koffi.pointer(koffi.proto('int ComInt(void *self, int value)')),
    withDouble: koffi.pointer(koffi.proto('int ComDouble(void *self, double value)')),
    withInt64: koffi.pointer(koffi.proto('int ComInt64(void *self, int64 value)')),
  };

  const toPointer = (value: unknown): ComPointer => {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return BigInt(value);
    return 0n;
  };

  const readPointerAt = (address: unknown, offset = 0): ComPointer =>
    toPointer(koffi.decode(address, offset, 'void *'));

  /** Resolve slot `index` of the object's vtable. */
  const vtableSlot = (object: ComPointer, index: number): ComPointer => {
    const vtable = readPointerAt(object);
    if (!vtable) throw new Error('COM object has no vtable.');
    const slot = readPointerAt(vtable, index * POINTER_SIZE);
    if (!slot) throw new Error(`COM vtable slot ${index} is null.`);
    return slot;
  };

  const check = (hr: number, what: string): number => {
    if (hr < 0) {
      throw new Error(`${what} failed with HRESULT 0x${(hr >>> 0).toString(16).padStart(8, '0')}`);
    }
    return hr;
  };

  const call = (
    object: ComPointer,
    index: number,
    proto: unknown,
    args: unknown[],
    what: string,
  ): number => check(koffi.call(vtableSlot(object, index), proto, object, ...args) as number, what);

  /** IUnknown::Release, slot 2. Never throws: it runs during teardown. */
  const release = (object: ComPointer | null): void => {
    if (!object) return;
    try {
      koffi.call(vtableSlot(object, 2), protos.self, object);
    } catch {
      // A failed release during teardown must not take the process down.
    }
  };

  /** IUnknown::QueryInterface, slot 0. */
  const queryInterface = (object: ComPointer, iid: string, what: string): ComPointer => {
    const out = Buffer.alloc(POINTER_SIZE);
    call(object, 0, protos.threePointers, [guidToBuffer(iid), out], what);
    const value = out.readBigUInt64LE(0);
    if (!value) throw new Error(`${what} returned a null interface.`);
    return value;
  };

  /** Read an interface out-parameter from a property getter. */
  const readInterface = (object: ComPointer, index: number, what: string): ComPointer => {
    const out = Buffer.alloc(POINTER_SIZE);
    call(object, index, protos.onePointer, [out], what);
    const value = out.readBigUInt64LE(0);
    if (!value) throw new Error(`${what} returned a null interface.`);
    return value;
  };

  /** Read an `int`-sized out-parameter, used for WinRT enums. */
  const readInt = (object: ComPointer, index: number, what: string): number => {
    const out = Buffer.alloc(4);
    call(object, index, protos.onePointer, [out], what);
    return out.readInt32LE(0);
  };

  /** Read a `double` out-parameter. */
  const readDouble = (object: ComPointer, index: number, what: string): number => {
    const out = Buffer.alloc(8);
    call(object, index, protos.onePointer, [out], what);
    return out.readDoubleLE(0);
  };

  /** Read a `TimeSpan` out-parameter, in 100-nanosecond units. */
  const readTimeSpan = (object: ComPointer, index: number, what: string): bigint => {
    const out = Buffer.alloc(8);
    call(object, index, protos.onePointer, [out], what);
    return out.readBigInt64LE(0);
  };

  const putBool = (object: ComPointer, index: number, value: boolean, what: string): void => {
    call(object, index, protos.withBool, [value ? 1 : 0], what);
  };

  const putInt = (object: ComPointer, index: number, value: number, what: string): void => {
    call(object, index, protos.withInt, [value], what);
  };

  const putDouble = (object: ComPointer, index: number, value: number, what: string): void => {
    call(object, index, protos.withDouble, [value], what);
  };

  /** Set a `TimeSpan` property. The struct is one 64-bit field, passed by value. */
  const putTimeSpan = (object: ComPointer, index: number, value: bigint, what: string): void => {
    call(object, index, protos.withInt64, [value], what);
  };

  const invokeVoid = (object: ComPointer, index: number, what: string): void => {
    call(object, index, protos.self, [], what);
  };

  const invokeWithPointer = (object: ComPointer, index: number, arg: unknown, what: string): void => {
    call(object, index, protos.onePointer, [arg], what);
  };

  /**
   * `ISystemMediaTransportControlsInterop::GetForWindow(HWND, REFIID, void **)`.
   *
   * It is the first method after IInspectable, so vtable slot 6. The window
   * handle is passed by value: Electron hands back the `HWND` inside a Buffer,
   * and it is the value in that buffer, not the buffer's own address, that
   * Windows needs.
   */
  const getForWindow = (
    interop: ComPointer,
    windowHandle: ComPointer,
    iid: string,
    out: Buffer,
  ): void => {
    call(interop, 6, protos.threePointers, [windowHandle, guidToBuffer(iid), out], 'GetForWindow');
  };

  /**
   * Register an event handler and return the token needed to remove it.
   *
   * WinRT `add_*` methods take the delegate and write back an `EventRegistrationToken`,
   * which is a single 64-bit value.
   */
  const addEventHandler = (
    object: ComPointer,
    index: number,
    handler: Buffer,
    what: string,
  ): bigint => {
    const token = Buffer.alloc(8);
    call(object, index, protos.twoPointers, [handler, token], what);
    return token.readBigInt64LE(0);
  };

  const removeEventHandler = (object: ComPointer, index: number, token: bigint, what: string): void => {
    try {
      call(object, index, protos.withInt64, [token], what);
    } catch {
      // Removal during teardown is best effort.
    }
  };

  /**
   * Run `body` with an HSTRING for `value`, deleting it afterwards.
   *
   * WinRT strings are reference counted separately from the JS string, so every
   * created HSTRING is deleted even when the call it fed threw.
   */
  const withHString = <T>(value: string, body: (hstring: ComPointer) => T): T => {
    const out = Buffer.alloc(POINTER_SIZE);
    check(windowsCreateString(value, value.length, out) as number, 'WindowsCreateString');
    const hstring = out.readBigUInt64LE(0);
    try {
      return body(hstring);
    } finally {
      windowsDeleteString(hstring);
    }
  };

  /** Set a WinRT string property from a JS string. */
  const putString = (object: ComPointer, index: number, value: string, what: string): void => {
    withHString(value, (hstring) => {
      call(object, index, protos.onePointer, [hstring], what);
    });
  };

  /** Initialize the apartment. An apartment Electron already created is fine. */
  const initializeApartment = (): void => {
    const hr = roInitialize(RO_INIT_SINGLETHREADED) as number;
    // S_FALSE means already initialized. RPC_E_CHANGED_MODE means Electron
    // already chose the apartment, which is the normal case on the main thread.
    if (hr < 0 && hr !== RPC_E_CHANGED_MODE) check(hr, 'RoInitialize');
  };

  const activationFactory = (runtimeClass: string, iid: string): ComPointer => withHString(
    runtimeClass,
    (hstring) => {
      const out = Buffer.alloc(POINTER_SIZE);
      check(
        roGetActivationFactory(hstring, guidToBuffer(iid), out) as number,
        `RoGetActivationFactory(${runtimeClass})`,
      );
      const value = out.readBigUInt64LE(0);
      if (!value) throw new Error(`RoGetActivationFactory(${runtimeClass}) returned null.`);
      return value;
    },
  );

  const activateInstance = (runtimeClass: string): ComPointer => withHString(runtimeClass, (hstring) => {
    const out = Buffer.alloc(POINTER_SIZE);
    check(roActivateInstance(hstring, out) as number, `RoActivateInstance(${runtimeClass})`);
    const value = out.readBigUInt64LE(0);
    if (!value) throw new Error(`RoActivateInstance(${runtimeClass}) returned null.`);
    return value;
  });

  /**
   * Build a COM object implementing `ITypedEventHandler`.
   *
   * The vtable is IUnknown's three slots followed by `Invoke`. Reference counts
   * live in JavaScript, and the buffers backing the object stay referenced for
   * as long as the handler is registered, so neither V8 nor koffi can free
   * memory WinRT still points at.
   */
  const createEventHandler = (onInvoke: (sender: ComPointer, args: ComPointer) => void) => {
    const queryInterfaceProto = koffi.pointer(
      koffi.proto('int HandlerQueryInterface(void *self, void *riid, void *ppv)'),
    );
    const refCountProto = koffi.pointer(koffi.proto('uint32 HandlerRefCount(void *self)'));
    const invokeProto = koffi.pointer(
      koffi.proto('int HandlerInvoke(void *self, void *sender, void *args)'),
    );

    const vtable = Buffer.alloc(POINTER_SIZE * 4);
    const object = Buffer.alloc(POINTER_SIZE);
    let refCount = 1;

    const queryInterfaceCallback = koffi.register(((_self: unknown, riid: unknown, ppv: unknown) => {
      if (!ppv) return E_POINTER;
      const raw = koffi.decode(riid, 0, 'uint8', 16) as ArrayLike<number>;
      const requested = guidFromBytes(Buffer.from(Array.from(raw)));
      if (!acceptsDelegateInterface(requested)) return E_NOINTERFACE;
      // Everything still accepted is the parameterized handler interface, whose
      // layout is exactly this object's vtable.
      koffi.encode(ppv, 0, 'void *', koffi.address(object));
      refCount += 1;
      return S_OK;
    }) as (...args: never[]) => unknown, queryInterfaceProto);

    const addRefCallback = koffi.register((() => {
      refCount += 1;
      return refCount;
    }) as (...args: never[]) => unknown, refCountProto);

    const releaseCallback = koffi.register((() => {
      refCount = Math.max(0, refCount - 1);
      return refCount;
    }) as (...args: never[]) => unknown, refCountProto);

    const invokeCallback = koffi.register(((_self: unknown, sender: unknown, args: unknown) => {
      try {
        onInvoke(toPointer(sender), toPointer(args));
      } catch {
        // Throwing here would unwind into WinRT, so the failure is dropped.
      }
      return S_OK;
    }) as (...args: never[]) => unknown, invokeProto);

    vtable.writeBigUInt64LE(queryInterfaceCallback, 0);
    vtable.writeBigUInt64LE(addRefCallback, POINTER_SIZE);
    vtable.writeBigUInt64LE(releaseCallback, POINTER_SIZE * 2);
    vtable.writeBigUInt64LE(invokeCallback, POINTER_SIZE * 3);
    object.writeBigUInt64LE(koffi.address(vtable), 0);

    return {
      /** Pass this where WinRT expects the handler interface pointer. */
      interfacePointer: object,
      dispose() {
        for (const callback of [
          queryInterfaceCallback,
          addRefCallback,
          releaseCallback,
          invokeCallback,
        ]) {
          try {
            koffi.unregister(callback);
          } catch {
            // Already unregistered.
          }
        }
      },
    };
  };

  return {
    initializeApartment,
    activationFactory,
    activateInstance,
    withHString,
    queryInterface,
    release,
    readInterface,
    readInt,
    readDouble,
    readTimeSpan,
    putBool,
    putInt,
    putDouble,
    putString,
    putTimeSpan,
    invokeVoid,
    invokeWithPointer,
    getForWindow,
    createEventHandler,
    addEventHandler,
    removeEventHandler,
  };
}
