import type { MediaSessionAdapter } from './service.ts';
import type {
  MediaSessionCommand,
  MediaSessionCommandType,
  MediaSessionSnapshot,
} from '../../shared/mediaControlProtocol.ts';

/**
 * macOS system media session, built on the public MediaPlayer framework.
 *
 * `MPRemoteCommandCenter` receives the hardware media keys, AirPods gestures,
 * Bluetooth remotes, and every Control Center action. `MPNowPlayingInfoCenter`
 * publishes what the system displays. Neither needs Accessibility permission,
 * and neither is a private MediaRemote API or a `CGEventTap`.
 *
 * The bridge runs **in-process**, through koffi and the Objective-C runtime, the
 * same technique `libvlcPlayback.ts` already uses to host LibVLC's NSView.
 * Hosting matters: `MPNowPlayingInfoCenter` registers per process, so a
 * detached helper would be attributed to the helper rather than to LoomTV, and
 * Control Center would show the helper's name and icon. Running here avoids the
 * attribution problem outright, and needs no node-gyp, no per-architecture
 * prebuilds, and no rebuild on an Electron bump.
 */

type KoffiLibrary = {
  func: (name: string, result: string, args: unknown[]) => (...callArgs: unknown[]) => unknown;
  symbol: (name: string) => unknown;
};

type KoffiRuntime = {
  load: (path: string) => KoffiLibrary;
  proto: (definition: string) => unknown;
  pointer: (ref: unknown) => unknown;
  register: (callback: (...args: never[]) => unknown, type: unknown) => bigint;
  decode: (value: unknown, type: string) => unknown;
};

/** A pointer as koffi marshals it: a BigInt address, or null. */
type ObjcPointer = bigint | null;

export type MacOsMediaSessionAdapterOptions = {
  logWarning?: (message: string, error?: unknown) => void;
  /** Injected in tests so the bridge can be exercised without the framework. */
  loadRuntime?: () => KoffiRuntime;
};

const MEDIA_PLAYER_FRAMEWORK = '/System/Library/Frameworks/MediaPlayer.framework/MediaPlayer';
const FOUNDATION_FRAMEWORK = '/System/Library/Frameworks/Foundation.framework/Foundation';
const APPKIT_FRAMEWORK = '/System/Library/Frameworks/AppKit.framework/AppKit';

/** MPRemoteCommandHandlerStatus. */
const COMMAND_HANDLED = 0;
const COMMAND_NOT_ACTIONABLE = 110;

/** MPNowPlayingPlaybackState. */
const PLAYBACK_STATE_PLAYING = 1;
const PLAYBACK_STATE_PAUSED = 2;
const PLAYBACK_STATE_STOPPED = 3;

/** MPNowPlayingInfoMediaTypeVideo. */
const MEDIA_TYPE_VIDEO = 2;

type EventReader = {
  /** `-[MPChangePlaybackPositionCommandEvent positionTime]`. */
  positionTime: () => number;
  /** `-[MPSkipIntervalCommandEvent interval]`. */
  interval: () => number;
  /** `-[MPChangePlaybackRateCommandEvent playbackRate]`. */
  playbackRate: () => number;
};

/**
 * One MPRemoteCommandCenter command and how it maps to LoomTV's contract.
 *
 * Play, pause, and toggle are all registered discretely: AirPods send a toggle,
 * while many Bluetooth remotes send a discrete play or pause, and registering
 * only one of the three produces failures on hardware nobody can reproduce.
 */
type CommandBinding = {
  /** Property selector on MPRemoteCommandCenter. */
  command: string;
  /** Selector added to the dynamically created target class. */
  selector: string;
  /** Contract command this binding needs the player to support. */
  requires: MediaSessionCommandType;
  build: (snapshot: MediaSessionSnapshot, readEvent: EventReader) => MediaSessionCommand | null;
};

const COMMAND_BINDINGS: readonly CommandBinding[] = [
  {
    command: 'playCommand',
    selector: 'loomtvHandlePlay:',
    requires: 'play',
    build: () => ({ type: 'play' }),
  },
  {
    command: 'pauseCommand',
    selector: 'loomtvHandlePause:',
    requires: 'pause',
    build: () => ({ type: 'pause' }),
  },
  {
    command: 'togglePlayPauseCommand',
    selector: 'loomtvHandleToggle:',
    requires: 'toggle',
    build: () => ({ type: 'toggle' }),
  },
  {
    command: 'stopCommand',
    selector: 'loomtvHandleStop:',
    requires: 'stop',
    build: () => ({ type: 'stop' }),
  },
  {
    command: 'previousTrackCommand',
    selector: 'loomtvHandlePreviousItem:',
    requires: 'previousItem',
    build: () => ({ type: 'previousItem' }),
  },
  {
    command: 'nextTrackCommand',
    selector: 'loomtvHandleNextItem:',
    requires: 'nextItem',
    build: () => ({ type: 'nextItem' }),
  },
  {
    command: 'skipBackwardCommand',
    selector: 'loomtvHandleSkipBackward:',
    requires: 'seekRelative',
    build: (snapshot, readEvent) => {
      const interval = readEvent.interval();
      const offset = interval > 0 ? interval : snapshot.skipBackSeconds;
      return { type: 'seekRelative', offsetSeconds: -offset };
    },
  },
  {
    command: 'skipForwardCommand',
    selector: 'loomtvHandleSkipForward:',
    requires: 'seekRelative',
    build: (snapshot, readEvent) => {
      const interval = readEvent.interval();
      const offset = interval > 0 ? interval : snapshot.skipForwardSeconds;
      return { type: 'seekRelative', offsetSeconds: offset };
    },
  },
  {
    command: 'changePlaybackPositionCommand',
    selector: 'loomtvHandleChangePlaybackPosition:',
    requires: 'seekAbsolute',
    build: (_snapshot, readEvent) => {
      const positionSeconds = readEvent.positionTime();
      return Number.isFinite(positionSeconds) && positionSeconds >= 0
        ? { type: 'seekAbsolute', positionSeconds }
        : null;
    },
  },
  {
    command: 'changePlaybackRateCommand',
    selector: 'loomtvHandleChangePlaybackRate:',
    requires: 'setRate',
    build: (_snapshot, readEvent) => {
      const rate = readEvent.playbackRate();
      return Number.isFinite(rate) && rate > 0 ? { type: 'setRate', rate } : null;
    },
  },
];

/** Exported so tests can assert the capability mapping without macOS. */
export const MACOS_COMMAND_BINDINGS = COMMAND_BINDINGS;

/**
 * Which MediaPlayer commands the snapshot enables.
 *
 * Commands LoomTV cannot service are disabled rather than registered with a
 * no-op handler, so Control Center greys out a button instead of offering one
 * that does nothing.
 */
export function enabledMacOsCommands(snapshot: MediaSessionSnapshot): string[] {
  return COMMAND_BINDINGS
    .filter((binding) => snapshot.supportedCommands.includes(binding.requires))
    .map((binding) => binding.command);
}

function loadKoffi(): KoffiRuntime {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('koffi') as KoffiRuntime;
}

function asPointer(value: unknown): ObjcPointer {
  if (typeof value === 'bigint') return value === 0n ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return value === 0 ? null : BigInt(value);
  return null;
}

/**
 * The Objective-C runtime handles this adapter needs.
 *
 * Every `objc_msgSend` prototype is declared separately and non-variadically.
 * On arm64 the variadic calling convention differs from the normal one, so a
 * single "any signature" declaration would corrupt arguments.
 */
function createObjcRuntime(koffi: KoffiRuntime) {
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  // `objc_getClass` only resolves classes whose image is already loaded, so the
  // frameworks defining NSString, NSImage, and MPRemoteCommandCenter are pulled
  // in before any lookup.
  koffi.load(FOUNDATION_FRAMEWORK);
  koffi.load(APPKIT_FRAMEWORK);
  const mediaPlayer = koffi.load(MEDIA_PLAYER_FRAMEWORK);

  const objcGetClass = objc.func('objc_getClass', 'void *', ['str']);
  const selRegisterName = objc.func('sel_registerName', 'void *', ['str']);
  const allocateClassPair = objc.func('objc_allocateClassPair', 'void *', ['void *', 'str', 'size_t']);
  const registerClassPair = objc.func('objc_registerClassPair', 'void', ['void *']);
  const classAddMethod = objc.func('class_addMethod', 'bool', ['void *', 'void *', 'void *', 'str']);

  const sendPointer = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
  const sendPointerWithPointer = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'void *']);
  const sendPointerWithString = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'str']);
  const sendPointerWithDouble = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'double']);
  const sendPointerWithLong = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'long']);
  const sendVoid = objc.func('objc_msgSend', 'void', ['void *', 'void *']);
  const sendVoidWithPointer = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'void *']);
  const sendVoidWithBool = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'bool']);
  const sendVoidWithUnsignedLong = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'ulong']);
  const sendVoidWithTwoPointers = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'void *', 'void *']);
  const sendDouble = objc.func('objc_msgSend', 'double', ['void *', 'void *']);

  const selectorCache = new Map<string, ObjcPointer>();
  const classCache = new Map<string, ObjcPointer>();

  const sel = (name: string): ObjcPointer => {
    const cached = selectorCache.get(name);
    if (cached !== undefined) return cached;
    const value = asPointer(selRegisterName(name));
    selectorCache.set(name, value);
    return value;
  };

  const cls = (name: string): ObjcPointer => {
    const cached = classCache.get(name);
    if (cached !== undefined) return cached;
    const value = asPointer(objcGetClass(name));
    classCache.set(name, value);
    return value;
  };

  /** Read an `NSString * const` exported by MediaPlayer, or null when absent. */
  const constantString = (name: string): ObjcPointer => {
    try {
      const address = mediaPlayer.symbol(name);
      if (address === null || address === undefined) return null;
      return asPointer(koffi.decode(address, 'void *'));
    } catch {
      return null;
    }
  };

  const nsString = (value: string): ObjcPointer => {
    const stringClass = cls('NSString');
    if (!stringClass) return null;
    return asPointer(sendPointerWithString(stringClass, sel('stringWithUTF8String:'), value));
  };

  const nsNumberFromDouble = (value: number): ObjcPointer => {
    const numberClass = cls('NSNumber');
    if (!numberClass) return null;
    return asPointer(sendPointerWithDouble(numberClass, sel('numberWithDouble:'), value));
  };

  const nsNumberFromLong = (value: number): ObjcPointer => {
    const numberClass = cls('NSNumber');
    if (!numberClass) return null;
    return asPointer(sendPointerWithLong(numberClass, sel('numberWithLong:'), value));
  };

  return {
    koffi,
    allocateClassPair,
    registerClassPair,
    classAddMethod,
    sel,
    cls,
    constantString,
    nsString,
    nsNumberFromDouble,
    nsNumberFromLong,
    sendPointer,
    sendPointerWithPointer,
    sendVoid,
    sendVoidWithPointer,
    sendVoidWithBool,
    sendVoidWithUnsignedLong,
    sendVoidWithTwoPointers,
    sendDouble,
  };
}

type ObjcRuntime = ReturnType<typeof createObjcRuntime>;

/**
 * The dynamically created command target.
 *
 * `MPRemoteCommand` delivers through target/action, so LoomTV registers one
 * Objective-C class whose methods are koffi callbacks. It is created once per
 * process: `objc_allocateClassPair` refuses a name that already exists, and the
 * registered callbacks must stay alive for as long as commands can arrive.
 */
type CommandTarget = {
  instance: ObjcPointer;
  /** Retained so koffi never collects an installed IMP. */
  imps: bigint[];
};

let sharedRuntime: ObjcRuntime | null = null;
let sharedTarget: CommandTarget | null = null;
/** The live adapter's dispatcher, or null while the session is released. */
let activeDispatch: ((selector: string, event: ObjcPointer) => number) | null = null;

function commandTarget(runtime: ObjcRuntime): CommandTarget {
  if (sharedTarget) return sharedTarget;

  const nsObject = runtime.cls('NSObject');
  if (!nsObject) throw new Error('The Objective-C runtime did not resolve NSObject.');

  const targetClass = asPointer(runtime.allocateClassPair(nsObject, 'LoomTVMediaCommandTarget', 0));
  if (!targetClass) throw new Error('Could not create the LoomTV media command target class.');

  const proto = runtime.koffi.proto('long LoomTVCommandHandler(void *self, void *cmd, void *event)');
  const impType = runtime.koffi.pointer(proto);
  const imps: bigint[] = [];

  for (const binding of COMMAND_BINDINGS) {
    const imp = runtime.koffi.register(((_self: unknown, _cmd: unknown, event: unknown) => {
      const dispatch = activeDispatch;
      if (!dispatch) return COMMAND_NOT_ACTIONABLE;
      try {
        return dispatch(binding.selector, asPointer(event));
      } catch {
        // Throwing here would unwind into Objective-C, so failures are reported
        // to the system as a command that could not be actioned.
        return COMMAND_NOT_ACTIONABLE;
      }
    }) as (...args: never[]) => unknown, impType);
    imps.push(imp);

    // "q@:@" — returns NSInteger, takes (id self, SEL _cmd, id event).
    if (!runtime.classAddMethod(targetClass, runtime.sel(binding.selector), imp, 'q@:@')) {
      throw new Error(`Could not install the ${binding.selector} media command handler.`);
    }
  }

  runtime.registerClassPair(targetClass);
  const allocated = asPointer(runtime.sendPointer(targetClass, runtime.sel('alloc')));
  const instance = asPointer(runtime.sendPointer(allocated, runtime.sel('init')));
  if (!instance) throw new Error('Could not create the LoomTV media command target.');
  // The target outlives every claim/release cycle, so take a strong reference.
  runtime.sendPointer(instance, runtime.sel('retain'));

  sharedTarget = { instance, imps };
  return sharedTarget;
}

/** Reset process-wide Objective-C state. Exported for tests only. */
export function resetMacOsMediaSessionBridgeForTests(): void {
  sharedRuntime = null;
  sharedTarget = null;
  activeDispatch = null;
}

export function createMacOsMediaSessionAdapter(
  options: MacOsMediaSessionAdapterOptions = {},
): MediaSessionAdapter {
  const { logWarning } = options;
  const loadRuntime = options.loadRuntime ?? loadKoffi;

  let runtime: ObjcRuntime | null = null;
  let target: CommandTarget | null = null;
  let commandCenter: ObjcPointer = null;
  let infoCenter: ObjcPointer = null;
  let started = false;
  let lastSnapshot: MediaSessionSnapshot | null = null;
  let lastArtworkPath: string | null = null;
  let artworkObject: ObjcPointer = null;
  let artworkImage: ObjcPointer = null;
  const infoKeys = new Map<string, ObjcPointer>();

  const warn = (message: string, error?: unknown) => logWarning?.(message, error);

  const objcOrThrow = (): ObjcRuntime => {
    if (!runtime) throw new Error('The macOS media session bridge is not started.');
    return runtime;
  };

  const commandFor = (name: string): ObjcPointer => {
    const objc = objcOrThrow();
    if (!commandCenter) return null;
    return asPointer(objc.sendPointer(commandCenter, objc.sel(name)));
  };

  const withAutoreleasePool = <T>(body: () => T): T => {
    const objc = objcOrThrow();
    const poolClass = objc.cls('NSAutoreleasePool');
    const pool = poolClass
      ? asPointer(objc.sendPointer(
        asPointer(objc.sendPointer(poolClass, objc.sel('alloc'))),
        objc.sel('init'),
      ))
      : null;
    try {
      return body();
    } finally {
      if (pool) objc.sendVoid(pool, objc.sel('drain'));
    }
  };

  const setCommandEnabled = (command: ObjcPointer, enabled: boolean) => {
    const objc = objcOrThrow();
    if (!command) return;
    objc.sendVoidWithBool(command, objc.sel('setEnabled:'), enabled);
  };

  /**
   * Publish LoomTV's own skip intervals as preferred intervals.
   *
   * Control Center's expanded module prints the interval inside the skip
   * buttons, so it shows the number the user actually configured.
   */
  const applyPreferredIntervals = (snapshot: MediaSessionSnapshot) => {
    const objc = objcOrThrow();
    const arrayClass = objc.cls('NSArray');
    if (!arrayClass) return;

    const install = (commandName: string, seconds: number) => {
      const command = commandFor(commandName);
      const number = command ? objc.nsNumberFromDouble(seconds) : null;
      if (!command || !number) return;
      const intervals = asPointer(
        objc.sendPointerWithPointer(arrayClass, objc.sel('arrayWithObject:'), number),
      );
      if (intervals) objc.sendVoidWithPointer(command, objc.sel('setPreferredIntervals:'), intervals);
    };

    install('skipBackwardCommand', snapshot.skipBackSeconds);
    install('skipForwardCommand', snapshot.skipForwardSeconds);
  };

  const releaseArtwork = () => {
    const objc = objcOrThrow();
    const previousArtwork = artworkObject;
    const previousImage = artworkImage;
    artworkObject = null;
    artworkImage = null;
    lastArtworkPath = null;
    try {
      if (previousArtwork) objc.sendVoid(previousArtwork, objc.sel('release'));
    } finally {
      if (previousImage) objc.sendVoid(previousImage, objc.sel('release'));
    }
  };

  /**
   * Artwork is a file path LoomTV already has on disk, so this is one NSImage
   * load. No thumbnail generation, no network fetch, no metadata provider.
   */
  const artworkFor = (snapshot: MediaSessionSnapshot): ObjcPointer => {
    const objc = objcOrThrow();
    const filePath = snapshot.artworkPath || null;
    if (!filePath) {
      releaseArtwork();
      return null;
    }
    if (filePath === lastArtworkPath && artworkObject) return artworkObject;

    const imageClass = objc.cls('NSImage');
    const artworkClass = objc.cls('MPMediaItemArtwork');
    if (!imageClass || !artworkClass) return null;

    const pathString = objc.nsString(filePath);
    if (!pathString) return null;
    const allocatedImage = asPointer(objc.sendPointer(imageClass, objc.sel('alloc')));
    if (!allocatedImage) return null;
    const image = asPointer(
      objc.sendPointerWithPointer(allocatedImage, objc.sel('initWithContentsOfFile:'), pathString),
    );
    if (!image) return null;

    try {
      const allocatedArtwork = asPointer(objc.sendPointer(artworkClass, objc.sel('alloc')));
      const artwork = allocatedArtwork
        ? asPointer(objc.sendPointerWithPointer(allocatedArtwork, objc.sel('initWithImage:'), image))
        : null;
      if (!artwork) return null;

      // alloc/init already owns both objects. Keep the current pair warm and
      // release it when replaced or cleared, without an extra retain.
      releaseArtwork();
      lastArtworkPath = filePath;
      artworkObject = artwork;
      artworkImage = image;
      return artwork;
    } finally {
      if (artworkImage !== image) objc.sendVoid(image, objc.sel('release'));
    }
  };

  const infoKey = (name: string): ObjcPointer => {
    const objc = objcOrThrow();
    const cached = infoKeys.get(name);
    if (cached !== undefined) return cached;
    const value = objc.constantString(name);
    infoKeys.set(name, value);
    return value;
  };

  const publishNowPlaying = (snapshot: MediaSessionSnapshot) => {
    const objc = objcOrThrow();
    const dictionaryClass = objc.cls('NSMutableDictionary');
    if (!infoCenter || !dictionaryClass) return;

    const allocated = asPointer(objc.sendPointer(dictionaryClass, objc.sel('alloc')));
    const info = asPointer(objc.sendPointer(allocated, objc.sel('init')));
    if (!info) return;

    const put = (keyName: string, value: ObjcPointer) => {
      const key = infoKey(keyName);
      if (!key || !value) return;
      objc.sendVoidWithTwoPointers(info, objc.sel('setObject:forKey:'), value, key);
    };

    const episodeLine = snapshot.season && snapshot.episode
      ? `Season ${snapshot.season}, Episode ${snapshot.episode}`
      : snapshot.seriesTitle;

    put('MPMediaItemPropertyTitle', objc.nsString(snapshot.title));
    if (episodeLine) put('MPMediaItemPropertyArtist', objc.nsString(episodeLine));
    if (snapshot.seriesTitle) put('MPMediaItemPropertyAlbumTitle', objc.nsString(snapshot.seriesTitle));
    if (snapshot.durationSeconds > 0) {
      put('MPMediaItemPropertyPlaybackDuration', objc.nsNumberFromDouble(snapshot.durationSeconds));
    }
    put('MPNowPlayingInfoPropertyElapsedPlaybackTime', objc.nsNumberFromDouble(snapshot.positionSeconds));
    // A zero rate is how the system is told the session is paused but retained.
    put(
      'MPNowPlayingInfoPropertyPlaybackRate',
      objc.nsNumberFromDouble(snapshot.state === 'playing' ? snapshot.rate : 0),
    );
    put('MPNowPlayingInfoPropertyDefaultPlaybackRate', objc.nsNumberFromDouble(snapshot.rate));
    put('MPNowPlayingInfoPropertyMediaType', objc.nsNumberFromLong(MEDIA_TYPE_VIDEO));
    if (snapshot.queueCount > 0) {
      put('MPNowPlayingInfoPropertyPlaybackQueueCount', objc.nsNumberFromLong(snapshot.queueCount));
      put('MPNowPlayingInfoPropertyPlaybackQueueIndex', objc.nsNumberFromLong(snapshot.queueIndex));
    }
    put('MPMediaItemPropertyArtwork', artworkFor(snapshot));

    objc.sendVoidWithPointer(infoCenter, objc.sel('setNowPlayingInfo:'), info);
    objc.sendVoidWithUnsignedLong(
      infoCenter,
      objc.sel('setPlaybackState:'),
      snapshot.state === 'playing' ? PLAYBACK_STATE_PLAYING : PLAYBACK_STATE_PAUSED,
    );
    // `release` balances the `alloc`; the info center copied what it needs.
    objc.sendVoid(info, objc.sel('release'));
  };

  return {
    kind: 'macos-mediaplayer',

    start({ onCommand }) {
      if (started) return;
      if (process.platform !== 'darwin') {
        throw new Error('The MediaPlayer bridge only runs on macOS.');
      }

      if (!sharedRuntime) sharedRuntime = createObjcRuntime(loadRuntime());
      runtime = sharedRuntime;
      const objc = runtime;

      const centerClass = objc.cls('MPRemoteCommandCenter');
      const infoCenterClass = objc.cls('MPNowPlayingInfoCenter');
      if (!centerClass || !infoCenterClass) {
        throw new Error('MediaPlayer.framework did not provide the Now Playing classes.');
      }

      commandCenter = asPointer(objc.sendPointer(centerClass, objc.sel('sharedCommandCenter')));
      infoCenter = asPointer(objc.sendPointer(infoCenterClass, objc.sel('defaultCenter')));
      if (!commandCenter || !infoCenter) {
        throw new Error('MediaPlayer.framework did not provide a shared command center.');
      }

      target = commandTarget(objc);

      activeDispatch = (selector, event) => {
        const binding = COMMAND_BINDINGS.find((candidate) => candidate.selector === selector);
        const snapshot = lastSnapshot;
        if (!binding || !snapshot) return COMMAND_NOT_ACTIONABLE;
        if (!snapshot.supportedCommands.includes(binding.requires)) return COMMAND_NOT_ACTIONABLE;

        const readEvent: EventReader = {
          positionTime: () => (event ? Number(objc.sendDouble(event, objc.sel('positionTime'))) : Number.NaN),
          interval: () => (event ? Number(objc.sendDouble(event, objc.sel('interval'))) : 0),
          playbackRate: () => (event ? Number(objc.sendDouble(event, objc.sel('playbackRate'))) : Number.NaN),
        };

        const command = binding.build(snapshot, readEvent);
        if (!command) return COMMAND_NOT_ACTIONABLE;
        onCommand(command);
        return COMMAND_HANDLED;
      };

      for (const binding of COMMAND_BINDINGS) {
        const command = commandFor(binding.command);
        if (!command) {
          warn(`[media-session] macOS did not expose ${binding.command}.`);
          continue;
        }
        objc.sendVoidWithTwoPointers(
          command,
          objc.sel('addTarget:action:'),
          target.instance,
          objc.sel(binding.selector),
        );
        setCommandEnabled(command, false);
      }

      started = true;
    },

    publish(snapshot) {
      if (!started || !runtime) return;
      lastSnapshot = snapshot;
      withAutoreleasePool(() => {
        for (const binding of COMMAND_BINDINGS) {
          setCommandEnabled(
            commandFor(binding.command),
            snapshot.supportedCommands.includes(binding.requires),
          );
        }
        applyPreferredIntervals(snapshot);
        publishNowPlaying(snapshot);
      });
    },

    clear() {
      if (!runtime) {
        started = false;
        lastSnapshot = null;
        return;
      }
      const objc = runtime;
      try {
        withAutoreleasePool(() => {
          if (started) {
            for (const binding of COMMAND_BINDINGS) {
              const command = commandFor(binding.command);
              if (!command) continue;
              setCommandEnabled(command, false);
              if (target?.instance) {
                objc.sendVoidWithPointer(command, objc.sel('removeTarget:'), target.instance);
              }
            }
          }
          if (infoCenter) {
            objc.sendVoidWithPointer(infoCenter, objc.sel('setNowPlayingInfo:'), null);
            objc.sendVoidWithUnsignedLong(
              infoCenter,
              objc.sel('setPlaybackState:'),
              PLAYBACK_STATE_STOPPED,
            );
          }
        });
      } catch (error) {
        warn('[media-session] Releasing the macOS media session failed.', error);
      } finally {
        try {
          releaseArtwork();
        } catch (error) {
          warn('[media-session] Releasing Now Playing artwork failed.', error);
        }
        activeDispatch = null;
        started = false;
        lastSnapshot = null;
        lastArtworkPath = null;
        artworkObject = null;
        commandCenter = null;
        infoCenter = null;
        target = null;
        runtime = null;
      }
    },
  };
}
