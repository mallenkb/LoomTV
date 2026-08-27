import type { MediaSessionAdapter } from './service.ts';
import type { MediaSessionCommand, MediaSessionSnapshot } from '../../shared/mediaControlProtocol.ts';
import { createWinRtBridge, type ComPointer, type KoffiWinRtRuntime, type WinRtBridge } from './winrt.ts';

/**
 * Windows system media session, built on SystemMediaTransportControls.
 *
 * SMTC is what drives the Windows media flyout, the volume-key overlay,
 * hardware transport keys, Bluetooth headsets, and lock-screen controls. For a
 * non-UWP desktop app it is obtained from
 * `ISystemMediaTransportControlsInterop::GetForWindow`, so it must run in
 * LoomTV's own process with LoomTV's own `HWND`.
 *
 * Interface IDs and vtable slot numbers below come from the Windows SDK
 * `windows.media.h`, where each interface is declared as
 * `MIDL_INTERFACE("<iid>")` followed by its methods in vtable order. The first
 * six slots of every WinRT interface are IUnknown's three and IInspectable's
 * three, so the declared methods start at slot 6.
 */

/** Interface IDs from the Windows SDK. */
const IID = {
  systemMediaTransportControlsInterop: 'ddb0472d-c911-4a1f-86d9-dc3d71a95f5a',
  systemMediaTransportControls: '99fa3ff4-1742-42a6-902e-087d41f965ec',
  systemMediaTransportControls2: 'ea98d2f6-7f3c-4af2-a586-72889808efb1',
  videoDisplayProperties: '5609fdb1-5d2d-4872-8170-45dee5bc2f5c',
  buttonPressedEventArgs: 'b7f47116-a56f-4dc8-9e11-92031f4a87c2',
  timelineProperties: '5125316a-c3a2-475b-8507-93534dc88f15',
  playbackPositionChangeRequestedEventArgs: 'b4493f88-eb28-4961-9c14-335e44f3e125',
  playbackRateChangeRequestedEventArgs: '2ce2c41f-3cd6-4f77-9ba7-eb27c26a2140',
} as const;

const RUNTIME_CLASS = {
  systemMediaTransportControls: 'Windows.Media.SystemMediaTransportControls',
  timelineProperties: 'Windows.Media.SystemMediaTransportControlsTimelineProperties',
} as const;

/** `ISystemMediaTransportControls` vtable slots. */
const SMTC = {
  put_PlaybackStatus: 7,
  get_DisplayUpdater: 8,
  put_IsEnabled: 11,
  put_IsPlayEnabled: 13,
  put_IsStopEnabled: 15,
  put_IsPauseEnabled: 17,
  put_IsFastForwardEnabled: 21,
  put_IsRewindEnabled: 23,
  put_IsPreviousEnabled: 25,
  put_IsNextEnabled: 27,
  add_ButtonPressed: 32,
  remove_ButtonPressed: 33,
} as const;

/** `ISystemMediaTransportControls2` vtable slots. */
const SMTC2 = {
  put_PlaybackRate: 11,
  UpdateTimelineProperties: 12,
  add_PlaybackPositionChangeRequested: 13,
  remove_PlaybackPositionChangeRequested: 14,
  add_PlaybackRateChangeRequested: 15,
  remove_PlaybackRateChangeRequested: 16,
} as const;

/** `ISystemMediaTransportControlsDisplayUpdater` vtable slots. */
const DISPLAY_UPDATER = {
  put_Type: 7,
  get_VideoProperties: 13,
  ClearAll: 16,
  Update: 17,
} as const;

/** `IVideoDisplayProperties` vtable slots. */
const VIDEO_PROPERTIES = {
  put_Title: 7,
  put_Subtitle: 9,
} as const;

/** `ISystemMediaTransportControlsTimelineProperties` vtable slots. */
const TIMELINE = {
  put_StartTime: 7,
  put_EndTime: 9,
  put_MinSeekTime: 11,
  put_MaxSeekTime: 13,
  put_Position: 15,
} as const;

/** `ISystemMediaTransportControlsButtonPressedEventArgs::get_Button`. */
const BUTTON_PRESSED_GET_BUTTON = 6;
/** `IPlaybackPositionChangeRequestedEventArgs::get_RequestedPlaybackPosition`. */
const GET_REQUESTED_POSITION = 6;
/** `IPlaybackRateChangeRequestedEventArgs::get_RequestedPlaybackRate`. */
const GET_REQUESTED_RATE = 6;

/** `MediaPlaybackStatus`. */
const PLAYBACK_STATUS = {
  closed: 0,
  changing: 1,
  stopped: 2,
  playing: 3,
  paused: 4,
} as const;

/** `MediaPlaybackType`. */
const MEDIA_PLAYBACK_TYPE_VIDEO = 2;

/** `SystemMediaTransportControlsButton`. */
const BUTTON = {
  play: 0,
  pause: 1,
  stop: 2,
  record: 3,
  fastForward: 4,
  rewind: 5,
  next: 6,
  previous: 7,
} as const;

/** 100-nanosecond ticks in one second, the unit of a WinRT `TimeSpan`. */
const TICKS_PER_SECOND = 10_000_000n;

export function secondsToTicks(seconds: number): bigint {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0n;
  return BigInt(Math.round(seconds * 1_000)) * (TICKS_PER_SECOND / 1_000n);
}

export function ticksToSeconds(ticks: bigint): number {
  return Number(ticks) / Number(TICKS_PER_SECOND);
}

/**
 * Map an SMTC button to LoomTV's contract.
 *
 * Windows has no dedicated skip-interval button, so fast-forward and rewind are
 * mapped to a relative seek using the user's configured intervals. Exported so
 * the mapping is testable without Windows.
 */
export function commandForSmtcButton(
  button: number,
  snapshot: MediaSessionSnapshot,
): MediaSessionCommand | null {
  switch (button) {
    case BUTTON.play: return { type: 'play' };
    case BUTTON.pause: return { type: 'pause' };
    case BUTTON.stop: return { type: 'stop' };
    case BUTTON.next: return { type: 'nextItem' };
    case BUTTON.previous: return { type: 'previousItem' };
    case BUTTON.fastForward:
      return { type: 'seekRelative', offsetSeconds: snapshot.skipForwardSeconds };
    case BUTTON.rewind:
      return { type: 'seekRelative', offsetSeconds: -snapshot.skipBackSeconds };
    default:
      return null;
  }
}

/** Which SMTC capability flags a snapshot turns on. Exported for tests. */
export function smtcCapabilities(snapshot: MediaSessionSnapshot) {
  const supports = (type: MediaSessionCommand['type']) => snapshot.supportedCommands.includes(type);
  const canSeek = supports('seekRelative');
  return {
    play: supports('play'),
    pause: supports('pause'),
    stop: supports('stop'),
    next: supports('nextItem'),
    previous: supports('previousItem'),
    fastForward: canSeek,
    rewind: canSeek,
  };
}

export function playbackStatusForSnapshot(snapshot: MediaSessionSnapshot): number {
  if (snapshot.state === 'playing') return PLAYBACK_STATUS.playing;
  if (snapshot.state === 'paused') return PLAYBACK_STATUS.paused;
  return PLAYBACK_STATUS.stopped;
}

export type WindowsSmtcAdapterOptions = {
  /**
   * LoomTV's top-level window handle, as returned by
   * `BrowserWindow.getNativeWindowHandle()`.
   */
  getWindowHandle: () => Buffer | null;
  logWarning?: (message: string, error?: unknown) => void;
  /** Injected in tests so the adapter can be built without WinRT. */
  loadRuntime?: () => KoffiWinRtRuntime;
};

function loadKoffi(): KoffiWinRtRuntime {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('koffi') as KoffiWinRtRuntime;
}

export function createWindowsSmtcAdapter(options: WindowsSmtcAdapterOptions): MediaSessionAdapter {
  const { getWindowHandle, logWarning } = options;
  const loadRuntime = options.loadRuntime ?? loadKoffi;

  let winrt: WinRtBridge | null = null;
  let controls: ComPointer | null = null;
  let controls2: ComPointer | null = null;
  let displayUpdater: ComPointer | null = null;
  let videoProperties: ComPointer | null = null;
  let timeline: ComPointer | null = null;
  let buttonHandler: ReturnType<WinRtBridge['createEventHandler']> | null = null;
  let positionHandler: ReturnType<WinRtBridge['createEventHandler']> | null = null;
  let rateHandler: ReturnType<WinRtBridge['createEventHandler']> | null = null;
  let buttonToken = 0n;
  let positionToken = 0n;
  let rateToken = 0n;
  let lastSnapshot: MediaSessionSnapshot | null = null;

  const warn = (message: string, error?: unknown) => logWarning?.(message, error);

  const teardown = () => {
    const bridge = winrt;
    if (bridge) {
      if (controls && buttonToken) {
        bridge.removeEventHandler(controls, SMTC.remove_ButtonPressed, buttonToken, 'remove_ButtonPressed');
      }
      if (controls2 && positionToken) {
        bridge.removeEventHandler(
          controls2,
          SMTC2.remove_PlaybackPositionChangeRequested,
          positionToken,
          'remove_PlaybackPositionChangeRequested',
        );
      }
      if (controls2 && rateToken) {
        bridge.removeEventHandler(
          controls2,
          SMTC2.remove_PlaybackRateChangeRequested,
          rateToken,
          'remove_PlaybackRateChangeRequested',
        );
      }
      try {
        if (displayUpdater) {
          bridge.invokeVoid(displayUpdater, DISPLAY_UPDATER.ClearAll, 'DisplayUpdater.ClearAll');
          bridge.invokeVoid(displayUpdater, DISPLAY_UPDATER.Update, 'DisplayUpdater.Update');
        }
        if (controls) {
          bridge.putInt(controls, SMTC.put_PlaybackStatus, PLAYBACK_STATUS.closed, 'put_PlaybackStatus');
          bridge.putBool(controls, SMTC.put_IsEnabled, false, 'put_IsEnabled');
        }
      } catch (error) {
        warn('[media-session] Clearing the Windows media session failed.', error);
      }

      for (const pointer of [videoProperties, displayUpdater, timeline, controls2, controls]) {
        bridge.release(pointer);
      }
    }

    buttonHandler?.dispose();
    positionHandler?.dispose();
    rateHandler?.dispose();

    buttonHandler = null;
    positionHandler = null;
    rateHandler = null;
    buttonToken = 0n;
    positionToken = 0n;
    rateToken = 0n;
    videoProperties = null;
    displayUpdater = null;
    timeline = null;
    controls2 = null;
    controls = null;
    winrt = null;
    lastSnapshot = null;
  };

  return {
    kind: 'windows-smtc',

    start({ onCommand }) {
      if (controls) return;
      if (process.platform !== 'win32') {
        throw new Error('The SystemMediaTransportControls bridge only runs on Windows.');
      }

      const windowHandle = getWindowHandle();
      if (!windowHandle || windowHandle.length === 0) {
        throw new Error('LoomTV has no native window handle to attach the media session to.');
      }

      const bridge = createWinRtBridge(loadRuntime());
      winrt = bridge;

      try {
        bridge.initializeApartment();

        const interop = bridge.activationFactory(
          RUNTIME_CLASS.systemMediaTransportControls,
          IID.systemMediaTransportControlsInterop,
        );
        try {
          controls = getForWindow(bridge, interop, windowHandle);
        } finally {
          bridge.release(interop);
        }

        controls2 = bridge.queryInterface(
          controls,
          IID.systemMediaTransportControls2,
          'QueryInterface(ISystemMediaTransportControls2)',
        );
        displayUpdater = bridge.readInterface(controls, SMTC.get_DisplayUpdater, 'get_DisplayUpdater');
        videoProperties = bridge.readInterface(
          displayUpdater,
          DISPLAY_UPDATER.get_VideoProperties,
          'get_VideoProperties',
        );
        timeline = bridge.activateInstance(RUNTIME_CLASS.timelineProperties);

        bridge.putInt(
          displayUpdater,
          DISPLAY_UPDATER.put_Type,
          MEDIA_PLAYBACK_TYPE_VIDEO,
          'DisplayUpdater.put_Type',
        );

        buttonHandler = bridge.createEventHandler((_sender, args) => {
          const snapshot = lastSnapshot;
          if (!snapshot || !args) return;
          const argsInterface = bridge.queryInterface(
            args,
            IID.buttonPressedEventArgs,
            'QueryInterface(ButtonPressedEventArgs)',
          );
          try {
            const button = bridge.readInt(argsInterface, BUTTON_PRESSED_GET_BUTTON, 'get_Button');
            const command = commandForSmtcButton(button, snapshot);
            if (command && snapshot.supportedCommands.includes(command.type)) onCommand(command);
          } finally {
            bridge.release(argsInterface);
          }
        });

        positionHandler = bridge.createEventHandler((_sender, args) => {
          const snapshot = lastSnapshot;
          if (!snapshot || !args) return;
          const argsInterface = bridge.queryInterface(
            args,
            IID.playbackPositionChangeRequestedEventArgs,
            'QueryInterface(PlaybackPositionChangeRequestedEventArgs)',
          );
          try {
            const ticks = bridge.readTimeSpan(
              argsInterface,
              GET_REQUESTED_POSITION,
              'get_RequestedPlaybackPosition',
            );
            onCommand({ type: 'seekAbsolute', positionSeconds: ticksToSeconds(ticks) });
          } finally {
            bridge.release(argsInterface);
          }
        });

        rateHandler = bridge.createEventHandler((_sender, args) => {
          if (!args) return;
          const argsInterface = bridge.queryInterface(
            args,
            IID.playbackRateChangeRequestedEventArgs,
            'QueryInterface(PlaybackRateChangeRequestedEventArgs)',
          );
          try {
            const rate = bridge.readDouble(argsInterface, GET_REQUESTED_RATE, 'get_RequestedPlaybackRate');
            if (Number.isFinite(rate) && rate > 0) onCommand({ type: 'setRate', rate });
          } finally {
            bridge.release(argsInterface);
          }
        });

        buttonToken = bridge.addEventHandler(
          controls,
          SMTC.add_ButtonPressed,
          buttonHandler.interfacePointer,
          'add_ButtonPressed',
        );
        positionToken = bridge.addEventHandler(
          controls2,
          SMTC2.add_PlaybackPositionChangeRequested,
          positionHandler.interfacePointer,
          'add_PlaybackPositionChangeRequested',
        );
        rateToken = bridge.addEventHandler(
          controls2,
          SMTC2.add_PlaybackRateChangeRequested,
          rateHandler.interfacePointer,
          'add_PlaybackRateChangeRequested',
        );

        bridge.putBool(controls, SMTC.put_IsEnabled, true, 'put_IsEnabled');
      } catch (error) {
        teardown();
        throw error;
      }
    },

    publish(snapshot) {
      const bridge = winrt;
      if (!bridge || !controls || !controls2 || !displayUpdater || !videoProperties || !timeline) return;
      lastSnapshot = snapshot;

      const capabilities = smtcCapabilities(snapshot);
      bridge.putBool(controls, SMTC.put_IsPlayEnabled, capabilities.play, 'put_IsPlayEnabled');
      bridge.putBool(controls, SMTC.put_IsPauseEnabled, capabilities.pause, 'put_IsPauseEnabled');
      bridge.putBool(controls, SMTC.put_IsStopEnabled, capabilities.stop, 'put_IsStopEnabled');
      bridge.putBool(controls, SMTC.put_IsNextEnabled, capabilities.next, 'put_IsNextEnabled');
      bridge.putBool(controls, SMTC.put_IsPreviousEnabled, capabilities.previous, 'put_IsPreviousEnabled');
      bridge.putBool(
        controls,
        SMTC.put_IsFastForwardEnabled,
        capabilities.fastForward,
        'put_IsFastForwardEnabled',
      );
      bridge.putBool(controls, SMTC.put_IsRewindEnabled, capabilities.rewind, 'put_IsRewindEnabled');

      bridge.putInt(
        controls,
        SMTC.put_PlaybackStatus,
        playbackStatusForSnapshot(snapshot),
        'put_PlaybackStatus',
      );
      bridge.putDouble(controls2, SMTC2.put_PlaybackRate, snapshot.rate, 'put_PlaybackRate');

      const subtitle = snapshot.season && snapshot.episode
        ? `Season ${snapshot.season}, Episode ${snapshot.episode}`
        : snapshot.seriesTitle || '';
      bridge.putString(videoProperties, VIDEO_PROPERTIES.put_Title, snapshot.title, 'VideoProperties.put_Title');
      bridge.putString(videoProperties, VIDEO_PROPERTIES.put_Subtitle, subtitle, 'VideoProperties.put_Subtitle');
      bridge.invokeVoid(displayUpdater, DISPLAY_UPDATER.Update, 'DisplayUpdater.Update');

      // Timeline properties are pushed on discontinuities only; Windows
      // interpolates position from the rate between updates.
      const end = secondsToTicks(snapshot.durationSeconds);
      bridge.putTimeSpan(timeline, TIMELINE.put_StartTime, 0n, 'Timeline.put_StartTime');
      bridge.putTimeSpan(timeline, TIMELINE.put_MinSeekTime, 0n, 'Timeline.put_MinSeekTime');
      bridge.putTimeSpan(timeline, TIMELINE.put_EndTime, end, 'Timeline.put_EndTime');
      bridge.putTimeSpan(timeline, TIMELINE.put_MaxSeekTime, end, 'Timeline.put_MaxSeekTime');
      bridge.putTimeSpan(
        timeline,
        TIMELINE.put_Position,
        secondsToTicks(snapshot.positionSeconds),
        'Timeline.put_Position',
      );
      bridge.invokeWithPointer(
        controls2,
        SMTC2.UpdateTimelineProperties,
        timeline,
        'UpdateTimelineProperties',
      );
    },

    clear() {
      teardown();
    },
  };
}

/**
 * Read LoomTV's `HWND` out of Electron's buffer and ask the interop factory for
 * the media session bound to that window.
 *
 * `getNativeWindowHandle()` returns the handle value inside a Buffer, so the
 * value is read out rather than passing the buffer's own address.
 */
function getForWindow(bridge: WinRtBridge, interop: ComPointer, windowHandle: Buffer): ComPointer {
  const handle = windowHandle.length >= 8
    ? windowHandle.readBigUInt64LE(0)
    : BigInt(windowHandle.readUInt32LE(0));
  if (!handle) throw new Error('LoomTV window handle is null.');

  const out = Buffer.alloc(8);
  bridge.getForWindow(interop, handle, IID.systemMediaTransportControls, out);
  const value = out.readBigUInt64LE(0);
  if (!value) throw new Error('GetForWindow returned a null SystemMediaTransportControls.');
  return value;
}
