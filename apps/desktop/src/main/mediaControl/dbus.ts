/**
 * The slice of libdbus-1 that the MPRIS service needs, reached in-process
 * through koffi.
 *
 * MPRIS is a D-Bus service: LoomTV has to own the well-known name
 * `org.mpris.MediaPlayer2.loomtv` on the session bus and answer method calls
 * addressed to it. That is a connection LoomTV's own process must hold, which
 * is why this runs beside the LibVLC bridge rather than in a helper.
 *
 * libdbus-1 is present on every Linux desktop that has a session bus at all,
 * and it is the same library the session bus itself is built around, so there
 * is no new runtime dependency to ship.
 */

type KoffiLibrary = {
  func: (name: string, result: string, args: unknown[]) => (...callArgs: unknown[]) => unknown;
};

export type KoffiDbusRuntime = {
  load: (path: string) => KoffiLibrary;
  proto: (definition: string) => unknown;
  pointer: (ref: unknown) => unknown;
  register: (callback: (...args: never[]) => unknown, type: unknown) => bigint;
  unregister: (callback: bigint) => void;
  decode: (value: unknown, ...rest: unknown[]) => unknown;
  address: (value: unknown) => bigint;
};

/** D-Bus type codes, as single-byte ASCII values. */
export const DBUS_TYPE = {
  invalid: 0,
  byte: 121, // 'y'
  boolean: 98, // 'b'
  int32: 105, // 'i'
  uint32: 117, // 'u'
  int64: 120, // 'x'
  double: 100, // 'd'
  string: 115, // 's'
  objectPath: 111, // 'o'
  array: 97, // 'a'
  variant: 118, // 'v'
  dictEntry: 101, // 'e'
} as const;

const DBUS_BUS_SESSION = 0;
const DBUS_MESSAGE_TYPE_METHOD_CALL = 1;
const DBUS_HANDLER_RESULT_HANDLED = 0;
const DBUS_HANDLER_RESULT_NOT_YET_HANDLED = 1;
const DBUS_NAME_FLAG_DO_NOT_QUEUE = 4;
const DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER = 1;

/**
 * `DBusError` and `DBusMessageIter` are opaque to callers, and libdbus only
 * ever receives a pointer to them. Both are comfortably under this size, so a
 * fixed scratch buffer avoids depending on the exact struct layout.
 */
const OPAQUE_STRUCT_BYTES = 256;

export type DbusPointer = bigint;

export type DbusLibrary = ReturnType<typeof createDbusBridge>;

/** Shared-object names to try, newest ABI first. */
export const LIBDBUS_CANDIDATES = ['libdbus-1.so.3', 'libdbus-1.so'] as const;

export function createDbusBridge(koffi: KoffiDbusRuntime) {
  let library: KoffiLibrary | null = null;
  const failures: string[] = [];
  for (const candidate of LIBDBUS_CANDIDATES) {
    try {
      library = koffi.load(candidate);
      break;
    } catch (error) {
      failures.push(`${candidate}: ${String(error)}`);
    }
  }
  if (!library) throw new Error(`libdbus-1 is not available. ${failures.join(' | ')}`);
  const dbus = library;

  const fn = {
    errorInit: dbus.func('dbus_error_init', 'void', ['void *']),
    errorIsSet: dbus.func('dbus_error_is_set', 'int', ['void *']),
    errorFree: dbus.func('dbus_error_free', 'void', ['void *']),
    busGet: dbus.func('dbus_bus_get', 'void *', ['int', 'void *']),
    setExitOnDisconnect: dbus.func('dbus_connection_set_exit_on_disconnect', 'void', ['void *', 'int']),
    requestName: dbus.func('dbus_bus_request_name', 'int', ['void *', 'str', 'uint32', 'void *']),
    releaseName: dbus.func('dbus_bus_release_name', 'int', ['void *', 'str', 'void *']),
    addFilter: dbus.func('dbus_connection_add_filter', 'int', ['void *', 'void *', 'void *', 'void *']),
    removeFilter: dbus.func('dbus_connection_remove_filter', 'void', ['void *', 'void *', 'void *']),
    readWriteDispatch: dbus.func('dbus_connection_read_write_dispatch', 'int', ['void *', 'int']),
    getUnixFd: dbus.func('dbus_connection_get_unix_fd', 'int', ['void *', 'void *']),
    flush: dbus.func('dbus_connection_flush', 'void', ['void *']),
    unref: dbus.func('dbus_connection_unref', 'void', ['void *']),
    messageGetType: dbus.func('dbus_message_get_type', 'int', ['void *']),
    messageGetInterface: dbus.func('dbus_message_get_interface', 'str', ['void *']),
    messageGetMember: dbus.func('dbus_message_get_member', 'str', ['void *']),
    messageGetPath: dbus.func('dbus_message_get_path', 'str', ['void *']),
    newMethodReturn: dbus.func('dbus_message_new_method_return', 'void *', ['void *']),
    newError: dbus.func('dbus_message_new_error', 'void *', ['void *', 'str', 'str']),
    newSignal: dbus.func('dbus_message_new_signal', 'void *', ['str', 'str', 'str']),
    messageUnref: dbus.func('dbus_message_unref', 'void', ['void *']),
    connectionSend: dbus.func('dbus_connection_send', 'int', ['void *', 'void *', 'void *']),
    iterInit: dbus.func('dbus_message_iter_init', 'int', ['void *', 'void *']),
    iterNext: dbus.func('dbus_message_iter_next', 'int', ['void *']),
    iterGetArgType: dbus.func('dbus_message_iter_get_arg_type', 'int', ['void *']),
    iterGetBasic: dbus.func('dbus_message_iter_get_basic', 'void', ['void *', 'void *']),
    iterRecurse: dbus.func('dbus_message_iter_recurse', 'void', ['void *', 'void *']),
    iterInitAppend: dbus.func('dbus_message_iter_init_append', 'void', ['void *', 'void *']),
    iterAppendBasic: dbus.func('dbus_message_iter_append_basic', 'int', ['void *', 'int', 'void *']),
    iterOpenContainer: dbus.func('dbus_message_iter_open_container', 'int', ['void *', 'int', 'str', 'void *']),
    iterCloseContainer: dbus.func('dbus_message_iter_close_container', 'int', ['void *', 'void *']),
  };

  const scratch = () => Buffer.alloc(OPAQUE_STRUCT_BYTES);

  const toPointer = (value: unknown): DbusPointer => {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return BigInt(value);
    return 0n;
  };

  /**
   * Hold a NUL-terminated copy of `value` and return a pointer-to-pointer.
   *
   * `dbus_message_iter_append_basic` takes the address of the value, so a
   * string argument is the address of a `const char *`. libdbus copies the
   * bytes during the call, and the returned object keeps both buffers alive
   * until then.
   */
  const stringArgument = (value: string) => {
    const bytes = Buffer.from(`${value}\0`, 'utf8');
    const holder = Buffer.alloc(8);
    holder.writeBigUInt64LE(koffi.address(bytes), 0);
    // `bytes` is referenced by the returned object so it cannot be collected
    // while libdbus still holds its address.
    return { holder, bytes };
  };

  const appendBasic = (iter: Buffer, type: number, value: Buffer): void => {
    if (!fn.iterAppendBasic(iter, type, value)) {
      throw new Error('Out of memory while building a D-Bus message.');
    }
  };

  const appendString = (iter: Buffer, type: number, value: string): void => {
    const argument = stringArgument(value);
    appendBasic(iter, type, argument.holder);
    // Keep the byte buffer referenced until after the call returns.
    void argument.bytes;
  };

  const appendBoolean = (iter: Buffer, value: boolean): void => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value ? 1 : 0, 0);
    appendBasic(iter, DBUS_TYPE.boolean, buffer);
  };

  const appendInt64 = (iter: Buffer, value: bigint): void => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64LE(value, 0);
    appendBasic(iter, DBUS_TYPE.int64, buffer);
  };

  const appendDouble = (iter: Buffer, value: number): void => {
    const buffer = Buffer.alloc(8);
    buffer.writeDoubleLE(value, 0);
    appendBasic(iter, DBUS_TYPE.double, buffer);
  };

  const openContainer = (
    iter: Buffer,
    type: number,
    signature: string | null,
    body: (sub: Buffer) => void,
  ): void => {
    const sub = scratch();
    if (!fn.iterOpenContainer(iter, type, signature, sub)) {
      throw new Error('Out of memory while opening a D-Bus container.');
    }
    try {
      body(sub);
    } finally {
      fn.iterCloseContainer(iter, sub);
    }
  };

  /** Append `v` holding one value of `signature`. */
  const appendVariant = (
    iter: Buffer,
    signature: string,
    body: (sub: Buffer) => void,
  ): void => openContainer(iter, DBUS_TYPE.variant, signature, body);

  /** Append one `{sv}` entry into an open `a{sv}` array. */
  const appendDictEntry = (
    arrayIter: Buffer,
    key: string,
    signature: string,
    body: (sub: Buffer) => void,
  ): void => openContainer(arrayIter, DBUS_TYPE.dictEntry, null, (entry) => {
    appendString(entry, DBUS_TYPE.string, key);
    appendVariant(entry, signature, body);
  });

  const appendArray = (
    iter: Buffer,
    signature: string,
    body: (sub: Buffer) => void,
  ): void => openContainer(iter, DBUS_TYPE.array, signature, body);

  /** Read the arguments of a method call as plain JavaScript values. */
  const readArguments = (message: DbusPointer): unknown[] => {
    const iter = scratch();
    if (!fn.iterInit(message, iter)) return [];
    const values: unknown[] = [];

    for (;;) {
      const type = fn.iterGetArgType(iter) as number;
      if (type === DBUS_TYPE.invalid) break;
      values.push(readValue(iter, type));
      if (!fn.iterNext(iter)) break;
    }
    return values;
  };

  function readValue(iter: Buffer, type: number): unknown {
    if (type === DBUS_TYPE.string || type === DBUS_TYPE.objectPath) {
      const out = Buffer.alloc(8);
      fn.iterGetBasic(iter, out);
      const address = out.readBigUInt64LE(0);
      return address ? String(koffi.decode(address, 'str')) : '';
    }
    if (type === DBUS_TYPE.int64) {
      const out = Buffer.alloc(8);
      fn.iterGetBasic(iter, out);
      return out.readBigInt64LE(0);
    }
    if (type === DBUS_TYPE.double) {
      const out = Buffer.alloc(8);
      fn.iterGetBasic(iter, out);
      return out.readDoubleLE(0);
    }
    if (type === DBUS_TYPE.boolean) {
      const out = Buffer.alloc(4);
      fn.iterGetBasic(iter, out);
      return out.readUInt32LE(0) !== 0;
    }
    if (type === DBUS_TYPE.int32 || type === DBUS_TYPE.uint32) {
      const out = Buffer.alloc(4);
      fn.iterGetBasic(iter, out);
      return type === DBUS_TYPE.int32 ? out.readInt32LE(0) : out.readUInt32LE(0);
    }
    if (type === DBUS_TYPE.variant) {
      const sub = scratch();
      fn.iterRecurse(iter, sub);
      return readValue(sub, fn.iterGetArgType(sub) as number);
    }
    return null;
  }

  return {
    constants: {
      DBUS_BUS_SESSION,
      DBUS_MESSAGE_TYPE_METHOD_CALL,
      DBUS_HANDLER_RESULT_HANDLED,
      DBUS_HANDLER_RESULT_NOT_YET_HANDLED,
      DBUS_NAME_FLAG_DO_NOT_QUEUE,
      DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER,
    },
    fn,
    scratch,
    toPointer,
    appendString,
    appendBoolean,
    appendInt64,
    appendDouble,
    appendVariant,
    appendDictEntry,
    appendArray,
    readArguments,
    registerFilter(handler: (connection: DbusPointer, message: DbusPointer) => number) {
      const proto = koffi.pointer(
        koffi.proto('int DbusFilter(void *connection, void *message, void *data)'),
      );
      const callback = koffi.register(((connection: unknown, message: unknown) => {
        try {
          return handler(toPointer(connection), toPointer(message));
        } catch {
          // Throwing here would unwind into libdbus.
          return DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
        }
      }) as (...args: never[]) => unknown, proto);
      return {
        callback,
        dispose: () => {
          try {
            koffi.unregister(callback);
          } catch {
            // Already unregistered.
          }
        },
      };
    },
  };
}
