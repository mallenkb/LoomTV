import type { MediaSessionAdapter } from './service.ts';
import type { MediaSessionCommand, MediaSessionSnapshot } from '../../shared/mediaControlProtocol.ts';
import { createDbusBridge, DBUS_TYPE, type DbusLibrary, type DbusPointer, type KoffiDbusRuntime } from './dbus.ts';

/**
 * Linux system media session: an MPRIS 2 player on the session bus.
 *
 * MPRIS is what GNOME's media widget, KDE's media applet, `playerctl`, and the
 * desktop's own media-key handling all talk to. LoomTV owns
 * `org.mpris.MediaPlayer2.loomtv` and answers method calls on
 * `/org/mpris/MediaPlayer2`.
 *
 * Position is deliberately absent from `PropertiesChanged`: the MPRIS
 * specification excludes it, and clients interpolate it from `Rate` and the
 * last `Seeked` signal. Seeks emit `Seeked` instead.
 */

const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const ROOT_INTERFACE = 'org.mpris.MediaPlayer2';
const PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';
const PROPERTIES_INTERFACE = 'org.freedesktop.DBus.Properties';
const INTROSPECTABLE_INTERFACE = 'org.freedesktop.DBus.Introspectable';
const BUS_NAME = 'org.mpris.MediaPlayer2.loomtv';

/** MPRIS reports position in microseconds. */
const MICROSECONDS_PER_SECOND = 1_000_000;

export function secondsToMicroseconds(seconds: number): bigint {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0n;
  return BigInt(Math.round(seconds * MICROSECONDS_PER_SECOND));
}

export function microsecondsToSeconds(microseconds: bigint): number {
  return Number(microseconds) / MICROSECONDS_PER_SECOND;
}

export function mprisPlaybackStatus(snapshot: MediaSessionSnapshot): string {
  if (snapshot.state === 'playing') return 'Playing';
  if (snapshot.state === 'paused') return 'Paused';
  return 'Stopped';
}

/**
 * Map an MPRIS method to LoomTV's contract.
 *
 * Exported so the routing is testable on any host. `Seek` carries a relative
 * offset in microseconds and `SetPosition` an absolute one, which is exactly
 * the split between the two seek commands.
 */
export function commandForMprisMethod(
  member: string,
  args: readonly unknown[],
): MediaSessionCommand | null {
  switch (member) {
    case 'Play': return { type: 'play' };
    case 'Pause': return { type: 'pause' };
    case 'PlayPause': return { type: 'toggle' };
    case 'Stop': return { type: 'stop' };
    case 'Next': return { type: 'nextItem' };
    case 'Previous': return { type: 'previousItem' };
    case 'Seek': {
      const offset = args[0];
      if (typeof offset !== 'bigint') return null;
      const offsetSeconds = microsecondsToSeconds(offset);
      return offsetSeconds === 0 ? null : { type: 'seekRelative', offsetSeconds };
    }
    case 'SetPosition': {
      const position = args[1];
      if (typeof position !== 'bigint') return null;
      return { type: 'seekAbsolute', positionSeconds: microsecondsToSeconds(position) };
    }
    default:
      return null;
  }
}

/** The MPRIS capability flags a snapshot turns on. Exported for tests. */
export function mprisCapabilities(snapshot: MediaSessionSnapshot) {
  const supports = (type: MediaSessionCommand['type']) => snapshot.supportedCommands.includes(type);
  return {
    canGoNext: supports('nextItem'),
    canGoPrevious: supports('previousItem'),
    canPlay: supports('play'),
    canPause: supports('pause'),
    canSeek: supports('seekAbsolute'),
    canControl: true,
  };
}

/**
 * `mpris:trackid` must be a valid object path, and it must change when the item
 * changes so clients drop stale metadata.
 */
export function trackIdForSession(sessionId: string): string {
  const suffix = Buffer.from(sessionId, 'utf8').toString('hex').slice(0, 40) || '0';
  return `/org/mpris/MediaPlayer2/loomtv/track/${suffix}`;
}

const INTROSPECTION_XML = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="org.freedesktop.DBus.Introspectable">
    <method name="Introspect"><arg name="xml_data" type="s" direction="out"/></method>
  </interface>
  <interface name="org.freedesktop.DBus.Properties">
    <method name="Get">
      <arg name="interface_name" type="s" direction="in"/>
      <arg name="property_name" type="s" direction="in"/>
      <arg name="value" type="v" direction="out"/>
    </method>
    <method name="GetAll">
      <arg name="interface_name" type="s" direction="in"/>
      <arg name="properties" type="a{sv}" direction="out"/>
    </method>
    <method name="Set">
      <arg name="interface_name" type="s" direction="in"/>
      <arg name="property_name" type="s" direction="in"/>
      <arg name="value" type="v" direction="in"/>
    </method>
    <signal name="PropertiesChanged">
      <arg name="interface_name" type="s"/>
      <arg name="changed_properties" type="a{sv}"/>
      <arg name="invalidated_properties" type="as"/>
    </signal>
  </interface>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="SupportedUriSchemes" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Play"/>
    <method name="Seek"><arg name="Offset" type="x" direction="in"/></method>
    <method name="SetPosition">
      <arg name="TrackId" type="o" direction="in"/>
      <arg name="Position" type="x" direction="in"/>
    </method>
    <method name="OpenUri"><arg name="Uri" type="s" direction="in"/></method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Rate" type="d" access="readwrite"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/>
    <property name="MinimumRate" type="d" access="read"/>
    <property name="MaximumRate" type="d" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
    <signal name="Seeked"><arg name="Position" type="x"/></signal>
  </interface>
</node>`;

export type LinuxMprisAdapterOptions = {
  logWarning?: (message: string, error?: unknown) => void;
  /** Injected in tests so the adapter can be built without libdbus. */
  loadRuntime?: () => KoffiDbusRuntime;
};

function loadKoffi(): KoffiDbusRuntime {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('koffi') as KoffiDbusRuntime;
}

export function createLinuxMprisAdapter(options: LinuxMprisAdapterOptions = {}): MediaSessionAdapter {
  const { logWarning } = options;
  const loadRuntime = options.loadRuntime ?? loadKoffi;

  let bridge: DbusLibrary | null = null;
  let connection: DbusPointer = 0n;
  let filter: ReturnType<DbusLibrary['registerFilter']> | null = null;
  let pump: NodeJS.Timeout | null = null;
  let snapshot: MediaSessionSnapshot | null = null;
  let ownedName = '';

  const warn = (message: string, error?: unknown) => logWarning?.(message, error);

  /** Player properties, as name/signature/appender triples. */
  const playerProperties = (dbus: DbusLibrary, current: MediaSessionSnapshot) => {
    const capabilities = mprisCapabilities(current);
    const bool = (value: boolean) => (iter: Buffer) => dbus.appendBoolean(iter, value);
    const double = (value: number) => (iter: Buffer) => dbus.appendDouble(iter, value);
    return [
      {
        name: 'PlaybackStatus',
        signature: 's',
        append: (iter: Buffer) => dbus.appendString(iter, DBUS_TYPE.string, mprisPlaybackStatus(current)),
      },
      { name: 'Rate', signature: 'd', append: double(current.rate) },
      { name: 'MinimumRate', signature: 'd', append: double(0.25) },
      { name: 'MaximumRate', signature: 'd', append: double(3) },
      { name: 'Metadata', signature: 'a{sv}', append: (iter: Buffer) => appendMetadata(dbus, iter, current) },
      { name: 'CanGoNext', signature: 'b', append: bool(capabilities.canGoNext) },
      { name: 'CanGoPrevious', signature: 'b', append: bool(capabilities.canGoPrevious) },
      { name: 'CanPlay', signature: 'b', append: bool(capabilities.canPlay) },
      { name: 'CanPause', signature: 'b', append: bool(capabilities.canPause) },
      { name: 'CanSeek', signature: 'b', append: bool(capabilities.canSeek) },
      { name: 'CanControl', signature: 'b', append: bool(capabilities.canControl) },
    ];
  };

  const rootProperties = (dbus: DbusLibrary) => {
    const bool = (value: boolean) => (iter: Buffer) => dbus.appendBoolean(iter, value);
    const text = (value: string) => (iter: Buffer) => dbus.appendString(iter, DBUS_TYPE.string, value);
    const emptyList = () => (iter: Buffer) => dbus.appendArray(iter, 's', () => undefined);
    return [
      { name: 'CanQuit', signature: 'b', append: bool(false) },
      { name: 'CanRaise', signature: 'b', append: bool(false) },
      { name: 'HasTrackList', signature: 'b', append: bool(false) },
      { name: 'Identity', signature: 's', append: text('LoomTV') },
      { name: 'DesktopEntry', signature: 's', append: text('loomtv') },
      { name: 'SupportedUriSchemes', signature: 'as', append: emptyList() },
      { name: 'SupportedMimeTypes', signature: 'as', append: emptyList() },
    ];
  };

  function appendMetadata(
    dbus: DbusLibrary,
    iter: Buffer,
    current: MediaSessionSnapshot,
  ): void {
    dbus.appendArray(iter, '{sv}', (array) => {
      dbus.appendDictEntry(array, 'mpris:trackid', 'o', (value) => {
        dbus.appendString(value, DBUS_TYPE.objectPath, trackIdForSession(current.sessionId));
      });
      if (current.durationSeconds > 0) {
        dbus.appendDictEntry(array, 'mpris:length', 'x', (value) => {
          dbus.appendInt64(value, secondsToMicroseconds(current.durationSeconds));
        });
      }
      dbus.appendDictEntry(array, 'xesam:title', 's', (value) => {
        dbus.appendString(value, DBUS_TYPE.string, current.title);
      });
      if (current.seriesTitle) {
        dbus.appendDictEntry(array, 'xesam:album', 's', (value) => {
          dbus.appendString(value, DBUS_TYPE.string, current.seriesTitle as string);
        });
        dbus.appendDictEntry(array, 'xesam:artist', 'as', (value) => {
          dbus.appendArray(value, 's', (list) => {
            dbus.appendString(list, DBUS_TYPE.string, current.seriesTitle as string);
          });
        });
      }
      if (current.episode) {
        dbus.appendDictEntry(array, 'xesam:trackNumber', 'x', (value) => {
          dbus.appendInt64(value, BigInt(current.episode as number));
        });
      }
      if (current.artworkPath) {
        dbus.appendDictEntry(array, 'mpris:artUrl', 's', (value) => {
          dbus.appendString(value, DBUS_TYPE.string, `file://${current.artworkPath}`);
        });
      }
    });
  }

  const sendAndUnref = (message: DbusPointer): void => {
    const dbus = bridge;
    if (!dbus || !message) return;
    try {
      dbus.fn.connectionSend(connection, message, null);
      dbus.fn.flush(connection);
    } finally {
      dbus.fn.messageUnref(message);
    }
  };

  const replyEmpty = (message: DbusPointer): void => {
    const dbus = bridge;
    if (!dbus) return;
    sendAndUnref(dbus.toPointer(dbus.fn.newMethodReturn(message)));
  };

  const replyError = (message: DbusPointer, name: string, text: string): void => {
    const dbus = bridge;
    if (!dbus) return;
    sendAndUnref(dbus.toPointer(dbus.fn.newError(message, name, text)));
  };

  /** Emit `PropertiesChanged` for the player interface, never including Position. */
  const emitPropertiesChanged = (current: MediaSessionSnapshot): void => {
    const dbus = bridge;
    if (!dbus) return;
    const signal = dbus.toPointer(
      dbus.fn.newSignal(OBJECT_PATH, PROPERTIES_INTERFACE, 'PropertiesChanged'),
    );
    if (!signal) return;

    const iter = dbus.scratch();
    dbus.fn.iterInitAppend(signal, iter);
    dbus.appendString(iter, DBUS_TYPE.string, PLAYER_INTERFACE);
    dbus.appendArray(iter, '{sv}', (array) => {
      for (const property of playerProperties(dbus, current)) {
        dbus.appendDictEntry(array, property.name, property.signature, property.append);
      }
    });
    dbus.appendArray(iter, 's', () => undefined);
    sendAndUnref(signal);
  };

  const emitSeeked = (positionSeconds: number): void => {
    const dbus = bridge;
    if (!dbus) return;
    const signal = dbus.toPointer(dbus.fn.newSignal(OBJECT_PATH, PLAYER_INTERFACE, 'Seeked'));
    if (!signal) return;
    const iter = dbus.scratch();
    dbus.fn.iterInitAppend(signal, iter);
    dbus.appendInt64(iter, secondsToMicroseconds(positionSeconds));
    sendAndUnref(signal);
  };

  const handleProperties = (message: DbusPointer, member: string, args: unknown[]): boolean => {
    const dbus = bridge;
    const current = snapshot;
    if (!dbus || !current) return false;
    const interfaceName = String(args[0] ?? '');
    const properties = interfaceName === PLAYER_INTERFACE
      ? playerProperties(dbus, current)
      : interfaceName === ROOT_INTERFACE
        ? rootProperties(dbus)
        : null;

    if (member === 'Get') {
      const name = String(args[1] ?? '');
      // Position is read on demand and never announced, per the specification.
      if (interfaceName === PLAYER_INTERFACE && name === 'Position') {
        const reply = dbus.toPointer(dbus.fn.newMethodReturn(message));
        const iter = dbus.scratch();
        dbus.fn.iterInitAppend(reply, iter);
        dbus.appendVariant(iter, 'x', (value) => {
          dbus.appendInt64(value, secondsToMicroseconds(current.positionSeconds));
        });
        sendAndUnref(reply);
        return true;
      }
      const property = properties?.find((candidate) => candidate.name === name);
      if (!property) {
        replyError(message, 'org.freedesktop.DBus.Error.UnknownProperty', `Unknown property ${name}`);
        return true;
      }
      const reply = dbus.toPointer(dbus.fn.newMethodReturn(message));
      const iter = dbus.scratch();
      dbus.fn.iterInitAppend(reply, iter);
      dbus.appendVariant(iter, property.signature, property.append);
      sendAndUnref(reply);
      return true;
    }

    if (member === 'GetAll') {
      if (!properties) {
        replyError(message, 'org.freedesktop.DBus.Error.UnknownInterface', `Unknown interface ${interfaceName}`);
        return true;
      }
      const reply = dbus.toPointer(dbus.fn.newMethodReturn(message));
      const iter = dbus.scratch();
      dbus.fn.iterInitAppend(reply, iter);
      dbus.appendArray(iter, '{sv}', (array) => {
        for (const property of properties) {
          dbus.appendDictEntry(array, property.name, property.signature, property.append);
        }
        if (interfaceName === PLAYER_INTERFACE) {
          dbus.appendDictEntry(array, 'Position', 'x', (value) => {
            dbus.appendInt64(value, secondsToMicroseconds(current.positionSeconds));
          });
        }
      });
      sendAndUnref(reply);
      return true;
    }

    return false;
  };

  return {
    kind: 'linux-mpris',

    start({ onCommand }) {
      if (connection) return;
      if (process.platform !== 'linux') {
        throw new Error('The MPRIS bridge only runs on Linux.');
      }

      const dbus = createDbusBridge(loadRuntime());
      bridge = dbus;

      const error = dbus.scratch();
      dbus.fn.errorInit(error);
      connection = dbus.toPointer(dbus.fn.busGet(dbus.constants.DBUS_BUS_SESSION, error));
      if (!connection || dbus.fn.errorIsSet(error)) {
        dbus.fn.errorFree(error);
        bridge = null;
        connection = 0n;
        throw new Error('No D-Bus session bus is available.');
      }
      // Losing the bus must not terminate LoomTV; playback continues without
      // system media controls.
      dbus.fn.setExitOnDisconnect(connection, 0);

      // A second LoomTV window gets a unique name rather than stealing the first
      // one's, which keeps each session addressable.
      const candidates = [BUS_NAME, `${BUS_NAME}.instance${process.pid}`];
      for (const candidate of candidates) {
        dbus.fn.errorInit(error);
        const result = dbus.fn.requestName(
          connection,
          candidate,
          dbus.constants.DBUS_NAME_FLAG_DO_NOT_QUEUE,
          error,
        ) as number;
        if (result === dbus.constants.DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER) {
          ownedName = candidate;
          break;
        }
      }
      dbus.fn.errorFree(error);
      if (!ownedName) {
        dbus.fn.unref(connection);
        connection = 0n;
        bridge = null;
        throw new Error('Could not own an MPRIS bus name on the session bus.');
      }

      filter = dbus.registerFilter((_connection, message) => {
        const notHandled = dbus.constants.DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
        if (dbus.fn.messageGetType(message) !== dbus.constants.DBUS_MESSAGE_TYPE_METHOD_CALL) {
          return notHandled;
        }
        if (String(dbus.fn.messageGetPath(message) ?? '') !== OBJECT_PATH) return notHandled;

        const interfaceName = String(dbus.fn.messageGetInterface(message) ?? '');
        const member = String(dbus.fn.messageGetMember(message) ?? '');
        const args = dbus.readArguments(message);

        if (interfaceName === INTROSPECTABLE_INTERFACE && member === 'Introspect') {
          const reply = dbus.toPointer(dbus.fn.newMethodReturn(message));
          const iter = dbus.scratch();
          dbus.fn.iterInitAppend(reply, iter);
          dbus.appendString(iter, DBUS_TYPE.string, INTROSPECTION_XML);
          sendAndUnref(reply);
          return dbus.constants.DBUS_HANDLER_RESULT_HANDLED;
        }

        if (interfaceName === PROPERTIES_INTERFACE) {
          if (member === 'Set') {
            const property = String(args[1] ?? '');
            const value = args[2];
            if (property === 'Rate' && typeof value === 'number' && value > 0) {
              onCommand({ type: 'setRate', rate: value });
            }
            replyEmpty(message);
            return dbus.constants.DBUS_HANDLER_RESULT_HANDLED;
          }
          if (handleProperties(message, member, args)) {
            return dbus.constants.DBUS_HANDLER_RESULT_HANDLED;
          }
          return notHandled;
        }

        if (interfaceName === ROOT_INTERFACE) {
          // LoomTV declares CanQuit and CanRaise false, so both are accepted
          // and ignored rather than acting on the player window.
          if (member === 'Raise' || member === 'Quit') {
            replyEmpty(message);
            return dbus.constants.DBUS_HANDLER_RESULT_HANDLED;
          }
          return notHandled;
        }

        if (interfaceName === PLAYER_INTERFACE) {
          // OpenUri would mean loading different media, which a media command
          // must never do. It is refused rather than silently ignored.
          if (member === 'OpenUri') {
            replyError(message, 'org.freedesktop.DBus.Error.NotSupported', 'LoomTV does not open URIs.');
            return dbus.constants.DBUS_HANDLER_RESULT_HANDLED;
          }
          const command = commandForMprisMethod(member, args);
          if (!command) return notHandled;
          const current = snapshot;
          if (current && current.supportedCommands.includes(command.type)) onCommand(command);
          replyEmpty(message);
          return dbus.constants.DBUS_HANDLER_RESULT_HANDLED;
        }

        return notHandled;
      });

      if (!dbus.fn.addFilter(connection, filter.callback, null, null)) {
        filter.dispose();
        filter = null;
        dbus.fn.unref(connection);
        connection = 0n;
        bridge = null;
        throw new Error('Could not attach the MPRIS message filter.');
      }

      // libdbus has no event loop of its own. Dispatching on a short interval
      // keeps incoming method calls flowing; it publishes nothing on its own,
      // so it is not the periodic position tick the contract forbids.
      pump = setInterval(() => {
        try {
          dbus.fn.readWriteDispatch(connection, 0);
        } catch (pumpError) {
          warn('[media-session] MPRIS dispatch failed.', pumpError);
        }
      }, 100);
      pump.unref?.();
    },

    publish(next) {
      if (!bridge || !connection) return;
      const previous = snapshot;
      snapshot = next;
      try {
        emitPropertiesChanged(next);
        const seeked = previous
          && previous.sessionId === next.sessionId
          && Math.abs(previous.positionSeconds - next.positionSeconds) > 1;
        if (seeked) emitSeeked(next.positionSeconds);
      } catch (error) {
        warn('[media-session] Publishing MPRIS state failed.', error);
      }
    },

    clear() {
      const dbus = bridge;
      if (pump) clearInterval(pump);
      pump = null;

      if (dbus && connection) {
        try {
          if (snapshot) {
            emitPropertiesChanged({ ...snapshot, state: 'stopped', supportedCommands: [] });
          }
          if (filter) dbus.fn.removeFilter(connection, filter.callback, null);
          if (ownedName) {
            const error = dbus.scratch();
            dbus.fn.errorInit(error);
            dbus.fn.releaseName(connection, ownedName, error);
            dbus.fn.errorFree(error);
          }
          dbus.fn.flush(connection);
          dbus.fn.unref(connection);
        } catch (error) {
          warn('[media-session] Releasing the MPRIS session failed.', error);
        }
      }

      filter?.dispose();
      filter = null;
      ownedName = '';
      connection = 0n;
      bridge = null;
      snapshot = null;
    },
  };
}
