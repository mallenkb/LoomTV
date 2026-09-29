import { StatusBar } from 'expo-status-bar';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  type StyleProp,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import { VideoView, useVideoPlayer } from 'expo-video';
import {
  AudioTracksIcon,
  CheckIcon,
  CloseIcon,
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SpeedIcon,
  SubtitlesIcon,
} from './LoomIcons';
import { reportNonFatal } from '../mobileDiagnostics';
import { recoveryActionFor, type PlaybackFailure } from '../playbackRecovery';
import { useMobilePlayerGestures } from '../useMobilePlayerGestures';
import { useMobilePlayerSession } from '../useMobilePlayerSession';
import { playerDisplayLabels, playbackPreferenceScope, localTrackLabel, nativeTrackKey, nativeTrackLabel, sidecarSubtitleLabel, audioPreference, subtitlePreference, preferredAudioKey, preferredSubtitleKey, formatClock, mobileSeekAccessibilityText, type PlayerAudioOption, type PlayerSubtitleOption } from '../mobilePlaybackPresentation';
import { captureMobileFocus, useMobileModalLayer } from '../mobileModalStack';
import { useMobileTheme } from '../mobileThemeContext';
import { filePathFromUrl } from '../mobileLibrary';
import type {
  MediaSegment,
  PlaybackTrackPreferences,
  PlayTarget,
  StreamOptions,
} from '../mobileDomain';
import { activeKnownMediaSegmentAt, mobileMediaSegmentLabel } from '../mobileDomain';
import {
  mediaSegmentsPayloadSchema,
  playbackTrackPreferencesSchema,
  readJsonResponse,
} from '../mobileDecoders';
import { useEntrance } from './SharedUi';
import { mobileLanClient } from '../mobileLanClientInstance';

type PlayerAspectRatio = 'default' | '4 / 3' | '16 / 9' | '16 / 10' | '21 / 9' | '5 / 4';
type PlayerCropMode = 'none' | '4 / 3' | '16 / 9' | '16 / 10' | '21 / 9' | '5 / 4' | 'custom';
type PlayerRotation = 0 | 90 | 180 | 270;
const PLAYER_ASPECT_OPTIONS: { value: PlayerAspectRatio; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: '4 / 3', label: '4:3' },
  { value: '16 / 9', label: '16:9' },
  { value: '16 / 10', label: '16:10' },
  { value: '21 / 9', label: '21:9' },
  { value: '5 / 4', label: '5:4' },
];

const PLAYER_CROP_OPTIONS: { value: PlayerCropMode; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: '4 / 3', label: '4:3' },
  { value: '16 / 9', label: '16:9' },
  { value: '16 / 10', label: '16:10' },
  { value: '21 / 9', label: '21:9' },
  { value: '5 / 4', label: '5:4' },
  { value: 'custom', label: 'Custom…' },
];

const PLAYER_ROTATION_OPTIONS: { value: PlayerRotation; label: string }[] = [
  { value: 0, label: '0°' },
  { value: 90, label: '90°' },
  { value: 180, label: '180°' },
  { value: 270, label: '270°' },
];
const MOBILE_SUBTITLE_FONT_SIZE_KEY = 'loomtv.mobile-subtitle-font-size.v1';
const DEFAULT_MOBILE_SUBTITLE_FONT_SIZE = 64;
const MOBILE_SUBTITLE_SIZE_OPTIONS = [
  { value: 32, label: '100%' },
  { value: 48, label: '150%' },
  { value: 64, label: '200%' },
  { value: 80, label: '250%' },
  { value: 96, label: '300%' },
];

export function PlayerModal({
  baseUrl,
  deviceToken,
  selectionRevision,
  failure,
  isPreparing,
  target,
  onClose,
  onRetry,
  onStreamOptionsChange,
  playbackUrl,
  player,
}: {
  baseUrl: string;
  deviceToken: string;
  selectionRevision?: number;
  failure: PlaybackFailure | null;
  isPreparing: boolean;
  target: PlayTarget | null;
  onClose: () => void;
  onRetry: () => void;
  onStreamOptionsChange: (options: StreamOptions) => void;
  playbackUrl: string | null;
  player: ReturnType<typeof useVideoPlayer>;
}) {
  if (!target) return null;
  // Keyed so playback position/controls state resets per title.
  return (
    <PlayerContent
      key={target.streamPath}
      baseUrl={baseUrl}
      deviceToken={deviceToken}
      selectionRevision={selectionRevision}
      failure={failure}
      isPreparing={isPreparing}
      target={target}
      onClose={onClose}
      onRetry={onRetry}
      onStreamOptionsChange={onStreamOptionsChange}
      playbackUrl={playbackUrl}
      player={player}
    />
  );
}

function PlayerSkipButton({
  amount,
  direction,
  iconSize = 38,
  onPress,
  style,
}: {
  amount: number;
  direction: 'back' | 'forward';
  iconSize?: number;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { styles } = useMobileTheme();
  const Icon = direction === 'back' ? SkipBackIcon : SkipForwardIcon;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.playerSkipButton, style, pressed && styles.playerControlPressed]}
      accessibilityRole="button"
      accessibilityLabel={`${direction === 'back' ? 'Back' : 'Forward'} ${amount} seconds`}
    >
      <Icon size={iconSize} color="#ffffff" />
      <Text style={styles.playerSkipLabel}>{amount}</Text>
    </Pressable>
  );
}

function PlayerMenuRow({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const { colors: { accent }, styles } = useMobileTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.playerMenuRow, pressed && styles.pressed]}
      accessibilityRole="menuitem"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
    >
      <Text numberOfLines={2} style={[styles.playerMenuRowText, selected && styles.playerMenuRowTextActive]}>{label}</Text>
      {selected ? <CheckIcon size={16} color={accent} /> : null}
    </Pressable>
  );
}

function PlayerSegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const { styles } = useMobileTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.playerSegmentScroll}
    >
      <View style={styles.playerSegmented}>
        {options.map((option, index) => (
          <Fragment key={String(option.value)}>
            {index > 0 ? <View style={styles.playerSegmentDivider} /> : null}
            <Pressable
              onPress={() => onChange(option.value)}
              style={({ pressed }) => [
                styles.playerSegment,
                value === option.value && styles.playerSegmentActive,
                pressed && styles.pressed,
              ]}
              accessibilityRole="radio"
              accessibilityLabel={option.label}
              accessibilityState={{ selected: value === option.value }}
            >
              <Text style={[styles.playerSegmentText, value === option.value && styles.playerSegmentTextActive]}>
                {option.label}
              </Text>
            </Pressable>
          </Fragment>
        ))}
      </View>
    </ScrollView>
  );
}

function PlayerContent({
  baseUrl,
  deviceToken,
  selectionRevision,
  failure,
  isPreparing,
  target,
  onClose,
  onRetry,
  onStreamOptionsChange,
  playbackUrl,
  player,
}: {
  baseUrl: string;
  deviceToken: string;
  selectionRevision?: number;
  failure: PlaybackFailure | null;
  isPreparing: boolean;
  target: PlayTarget;
  onClose: () => void;
  onRetry: () => void;
  onStreamOptionsChange: (options: StreamOptions) => void;
  playbackUrl: string | null;
  player: ReturnType<typeof useVideoPlayer>;
}) {
  const { colors: { accent }, styles } = useMobileTheme();
  const insets = useSafeAreaInsets();
  const { width: playerWidth } = useWindowDimensions();
  const [showLongPreparation, setShowLongPreparation] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<PlayerAspectRatio>('default');
  const [cropMode, setCropMode] = useState<PlayerCropMode>('none');
  const [rotation, setRotation] = useState<PlayerRotation>(0);
  const entrance = useEntrance();
  const [trackWidth, setTrackWidth] = useState(0);
  const [menu, setMenu] = useState<'none' | 'video' | 'speed' | 'audio' | 'subtitles'>('none');
  const playerMenuOpen = menu !== 'none';
  const {
    controlsOpacity,
    controlsVisible,
    duration,
    isPlaying,
    markInteraction,
    nativeAudioTracks,
    nativeSubtitleTracks,
    position,
    seekToFraction,
    seekToSeconds,
    setControlsVisible,
    showControls,
    skipBy,
    toggleControls,
    togglePlay,
  } = useMobilePlayerSession({ menuOpen: playerMenuOpen, playbackUrl, player });
  const { gestureLevel, panHandlers } = useMobilePlayerGestures({
    closeMenu: () => setMenu('none'),
    markInteraction,
    player,
    playerWidth,
    setControlsVisible,
  });
  const playerUnderlayAccessibilityProps = {
    accessibilityElementsHidden: playerMenuOpen,
    importantForAccessibility: playerMenuOpen ? 'no-hide-descendants' as const : 'auto' as const,
  };
  useEffect(() => {
    if (!isPreparing) {
      setShowLongPreparation(false);
      return undefined;
    }
    const timer = setTimeout(() => setShowLongPreparation(true), 2_000);
    return () => clearTimeout(timer);
  }, [isPreparing, target.streamPath]);
  useMobileModalLayer({
    priority: 50,
    onBack: () => {
      if (menu !== 'none') setMenu('none');
      else onClose();
    },
  });
  useMobileModalLayer({
    open: menu !== 'none',
    priority: 60,
    onBack: () => setMenu('none'),
  });
  const [playbackRate, setPlaybackRate] = useState(1);
  const [activeAudioKey, setActiveAudioKey] = useState('');
  const [activeSubtitleKey, setActiveSubtitleKey] = useState('off');
  const [subtitleFontSize, setSubtitleFontSize] = useState(DEFAULT_MOBILE_SUBTITLE_FONT_SIZE);
  const [mediaSegments, setMediaSegments] = useState<MediaSegment[]>([]);
  const recoveryAction = failure ? recoveryActionFor(failure) : null;
  const [trackPreferences, setTrackPreferences] = useState<PlaybackTrackPreferences>({});
  const preferenceScope = useMemo(
    () => playbackPreferenceScope({ mediaId: target.mediaId, streamPath: target.streamPath }),
    [target.mediaId, target.streamPath],
  );
  const appliedPreferenceKeyRef = useRef('');

  useEffect(() => {
    let cancelled = false;
    void SecureStore.getItemAsync(MOBILE_SUBTITLE_FONT_SIZE_KEY).then((storedValue) => {
      if (cancelled) return;
      const parsedValue = Number(storedValue);
      if (MOBILE_SUBTITLE_SIZE_OPTIONS.some((option) => option.value === parsedValue)) {
        setSubtitleFontSize(parsedValue);
      }
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const localAudioTracks = useMemo(
    () => (target.localMetadata?.tracks || []).filter((track) => track.type === 'audio'),
    [target.localMetadata?.tracks],
  );
  const localSubtitleTracks = useMemo(
    () => (target.localMetadata?.tracks || []).filter((track) => track.type === 'subtitle'),
    [target.localMetadata?.tracks],
  );
  const audioOptions = useMemo<PlayerAudioOption[]>(() => {
    if (localAudioTracks.length > 0) {
      return localAudioTracks.map((track, index) => ({
        key: `local-audio-${track.index}`,
        label: localTrackLabel(track, index),
        localTrack: track,
      }));
    }

    return nativeAudioTracks.map((track, index) => ({
      key: nativeTrackKey(track, 'native-audio', index),
      label: nativeTrackLabel(track, index),
      nativeTrack: track,
    }));
  }, [localAudioTracks, nativeAudioTracks]);
  const subtitleOptions = useMemo<PlayerSubtitleOption[]>(() => [
    ...localSubtitleTracks.map((track, index) => ({
      key: `local-subtitle-${track.index}`,
      label: localTrackLabel(track, index),
      localTrack: track,
      streamOrdinal: index,
    })),
    ...(target.subtitles || []).map((subtitle, index) => ({
      key: `sidecar-subtitle-${filePathFromUrl(subtitle.url)}-${index}`,
      label: sidecarSubtitleLabel(subtitle, index),
      sidecar: subtitle,
    })),
    ...(localSubtitleTracks.length > 0 || (target.subtitles || []).length > 0
      ? []
      : nativeSubtitleTracks.map((track, index) => ({
        key: nativeTrackKey(track, 'native-subtitle', index),
        label: nativeTrackLabel(track, index),
        nativeTrack: track,
      }))),
  ], [localSubtitleTracks, nativeSubtitleTracks, target.subtitles]);

  useEffect(() => {
    let cancelled = false;
    appliedPreferenceKeyRef.current = '';
    setTrackPreferences({});
    if (!baseUrl || !deviceToken || !preferenceScope) return () => { cancelled = true; };

    mobileLanClient.getTrackPreferences(baseUrl, deviceToken, preferenceScope)
      .then((response) => (response.ok
        ? readJsonResponse(response, playbackTrackPreferencesSchema, 'Playback track preferences')
        : {}))
      .then((preferences) => {
        if (!cancelled) setTrackPreferences(preferences || {});
      })
      .catch(() => {
        if (!cancelled) setTrackPreferences({});
      });

    return () => {
      cancelled = true;
    };
  }, [baseUrl, deviceToken, preferenceScope]);

  useEffect(() => {
    setMediaSegments([]);
    if (!baseUrl || !deviceToken || !target.mediaId) return;
    const controller = new AbortController();
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const retryDelays = [5000, 15000];
    const params = new URLSearchParams({ mediaId: target.mediaId });
    if (target.mediaType !== 'movie' && typeof target.season === 'number' && typeof target.episode === 'number') {
      params.set('season', String(target.season));
      params.set('episode', String(target.episode));
    }
    const load = async (attempt = 0) => {
      try {
        const response = await mobileLanClient.getPlaybackSegments(
          baseUrl,
          deviceToken,
          params,
          controller.signal,
        );
        if (!response.ok) throw new Error(`Skip marker lookup failed (${response.status}).`);
        const payload = await readJsonResponse(response, mediaSegmentsPayloadSchema, 'Skip markers');
        if (cancelled) return;
        const segments = Array.isArray(payload.segments) ? payload.segments : [];
        setMediaSegments(segments);
        if (segments.length === 0 && attempt < retryDelays.length) {
          refreshTimer = setTimeout(() => void load(attempt + 1), retryDelays[attempt]);
        }
      } catch (error) {
        if (!cancelled && !(error instanceof Error && error.name === 'AbortError')) {
          console.warn('[mobile-player] skip marker lookup failed', error);
        }
        if (!cancelled && attempt < retryDelays.length) {
          refreshTimer = setTimeout(() => void load(attempt + 1), retryDelays[attempt]);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      controller.abort();
    };
  }, [baseUrl, deviceToken, target.episode, target.mediaId, target.mediaType, target.season]);

  useEffect(() => {
    if (!activeAudioKey && audioOptions[0]) setActiveAudioKey(audioOptions[0].key);
  }, [activeAudioKey, audioOptions]);

  useEffect(() => {
    if (!controlsVisible) setMenu('none');
  }, [controlsVisible]);

  const toggleMenu = (nextMenu: 'video' | 'speed' | 'audio' | 'subtitles') => {
    showControls();
    setMenu((current) => (current === nextMenu ? 'none' : nextMenu));
  };

  const selectRate = (rate: number) => {
    showControls();
    try {
      player.playbackRate = rate;
    } catch (error) {
      // Rate changes can be rejected while the stream is loading.
      reportNonFatal('player.playback-rate', error);
    }
    setPlaybackRate(rate);
  };

  const streamOptionsForSelection = useCallback((
    audioKey: string,
    subtitleKey: string,
    startSeconds: number,
  ): StreamOptions | null => {
    const audioOption = audioOptions.find((option) => option.key === audioKey);
    const subtitleOption = subtitleOptions.find((option) => option.key === subtitleKey);
    const options: StreamOptions = {};

    if (audioOption?.localTrack) {
      options.audioTrackIndex = audioOption.localTrack.index;
    }

    if (subtitleOption?.localTrack) {
      options.subtitleTrackIndex = subtitleOption.localTrack.index;
      options.subtitleStreamOrdinal = subtitleOption.streamOrdinal || 0;
      options.subtitleCodec = subtitleOption.localTrack.codec;
      options.subtitleStyle = { fontSize: subtitleFontSize };
    } else if (subtitleOption?.sidecar) {
      options.subtitleFilePath = filePathFromUrl(subtitleOption.sidecar.url);
      options.subtitleStyle = { fontSize: subtitleFontSize };
    }

    const needsServerVariant = target.transcode
      || Boolean(audioOption?.localTrack)
      || Boolean(subtitleOption?.localTrack)
      || Boolean(subtitleOption?.sidecar);
    if (!needsServerVariant) return null;

    return {
      ...options,
      forceTranscode: true,
      ...(startSeconds > 2 ? { startSeconds } : {}),
    };
  }, [audioOptions, subtitleFontSize, subtitleOptions, target.transcode]);

  const requestSelectionStream = (audioKey: string, subtitleKey: string) => {
    const startSeconds = Number(player.currentTime || position || 0);
    onStreamOptionsChange(streamOptionsForSelection(audioKey, subtitleKey, startSeconds) || {});
  };

  const selectSubtitleFontSize = (fontSize: number) => {
    showControls();
    setSubtitleFontSize(fontSize);
    void SecureStore.setItemAsync(MOBILE_SUBTITLE_FONT_SIZE_KEY, String(fontSize))
      .catch((error) => reportNonFatal('secure-store.subtitle-font-size', error));

    const subtitleOption = subtitleOptions.find((option) => option.key === activeSubtitleKey);
    if (!subtitleOption?.localTrack && !subtitleOption?.sidecar) return;
    const startSeconds = Number(player.currentTime || position || 0);
    const nextOptions = streamOptionsForSelection(
      activeAudioKey || audioOptions[0]?.key || '',
      activeSubtitleKey,
      startSeconds,
    );
    if (nextOptions?.subtitleStyle) nextOptions.subtitleStyle.fontSize = fontSize;
    onStreamOptionsChange(nextOptions || {});
  };

  const applyNativeTrackSelection = useCallback((audioKey: string, subtitleKey: string) => {
    const audioOption = audioOptions.find((option) => option.key === audioKey);
    const subtitleOption = subtitleOptions.find((option) => option.key === subtitleKey);
    const hasServerSubtitle = Boolean(subtitleOption?.localTrack || subtitleOption?.sidecar);

    if (audioOption?.nativeTrack && localAudioTracks.length === 0 && !hasServerSubtitle) {
      try {
        player.audioTrack = audioOption.nativeTrack;
      } catch (error) {
        // Track selection can be rejected while the stream is loading.
        reportNonFatal('player.audio-track-apply', error);
      }
    }

    if (subtitleOption?.nativeTrack && localSubtitleTracks.length === 0 && !target.subtitles?.length) {
      try {
        player.subtitleTrack = subtitleOption.nativeTrack;
      } catch (error) {
        // Track selection can be rejected while the stream is loading.
        reportNonFatal('player.subtitle-track-apply', error);
      }
    } else if (subtitleKey === 'off') {
      try {
        player.subtitleTrack = null;
      } catch (error) {
        // Track selection can be rejected while the stream is loading.
        reportNonFatal('player.subtitle-track-clear', error);
      }
    }
  }, [audioOptions, localAudioTracks.length, localSubtitleTracks.length, player, subtitleOptions, target.subtitles?.length]);

  useEffect(() => {
    if (!trackPreferences.audio && !trackPreferences.subtitle) return;
    if (trackPreferences.audio && audioOptions.length === 0) return;

    const nextAudioKey = trackPreferences.audio
      ? preferredAudioKey(audioOptions, trackPreferences.audio)
      : activeAudioKey || audioOptions[0]?.key || '';
    const nextSubtitleKey = trackPreferences.subtitle
      ? preferredSubtitleKey(subtitleOptions, trackPreferences.subtitle)
      : activeSubtitleKey;
    const applyKey = JSON.stringify({
      scope: preferenceScope,
      audio: nextAudioKey,
      subtitle: nextSubtitleKey,
      subtitleFontSize,
      preference: trackPreferences,
      audioOptions: audioOptions.map((option) => option.key),
      subtitleOptions: subtitleOptions.map((option) => option.key),
    });

    if (appliedPreferenceKeyRef.current === applyKey) return;
    appliedPreferenceKeyRef.current = applyKey;

    if (nextAudioKey && nextAudioKey !== activeAudioKey) setActiveAudioKey(nextAudioKey);
    if (nextSubtitleKey !== activeSubtitleKey) setActiveSubtitleKey(nextSubtitleKey);

    const startSeconds = Number(player.currentTime || position || 0);
    onStreamOptionsChange(streamOptionsForSelection(nextAudioKey, nextSubtitleKey, startSeconds) || {});
    applyNativeTrackSelection(nextAudioKey, nextSubtitleKey);
    // Track application intentionally runs once per resolved option set; the
    // helper functions are local to that player render.
  }, [
    activeAudioKey,
    activeSubtitleKey,
    applyNativeTrackSelection,
    audioOptions,
    localAudioTracks.length,
    localSubtitleTracks.length,
    onStreamOptionsChange,
    player,
    position,
    preferenceScope,
    streamOptionsForSelection,
    subtitleOptions,
    subtitleFontSize,
    target.subtitles?.length,
    trackPreferences,
  ]);

  const saveTrackPreferences = (nextPreference: PlaybackTrackPreferences) => {
    const nextPreferences = { ...trackPreferences, ...nextPreference };
    setTrackPreferences(nextPreferences);
    if (!baseUrl || !deviceToken || !preferenceScope) return;
    mobileLanClient.saveTrackPreferences(baseUrl, deviceToken, preferenceScope, nextPreferences, selectionRevision)
      .catch((error) => reportNonFatal('player.track-preferences-save', error));
  };

  const selectAudioOption = (option: PlayerAudioOption) => {
    showControls();
    setActiveAudioKey(option.key);
    saveTrackPreferences({ audio: audioPreference(option, true) });
    const activeSubtitleOption = subtitleOptions.find((candidate) => candidate.key === activeSubtitleKey);
    const hasServerSubtitle = Boolean(activeSubtitleOption?.localTrack || activeSubtitleOption?.sidecar);
    if (option.nativeTrack && localAudioTracks.length === 0 && !hasServerSubtitle) {
      try {
        player.audioTrack = option.nativeTrack;
      } catch (error) {
        // Track selection can be rejected while the stream is loading.
        reportNonFatal('player.audio-track-select', error);
      }
      return;
    }
    requestSelectionStream(option.key, activeSubtitleKey);
  };

  const selectSubtitleOption = (option: PlayerSubtitleOption | null) => {
    showControls();
    const nextSubtitleKey = option?.key || 'off';
    setActiveSubtitleKey(nextSubtitleKey);
    saveTrackPreferences({ subtitle: subtitlePreference(option, Boolean(option)) });

    if (option?.nativeTrack && localSubtitleTracks.length === 0 && !target.subtitles?.length) {
      try {
        player.subtitleTrack = option.nativeTrack;
      } catch (error) {
        // Track selection can be rejected while the stream is loading.
        reportNonFatal('player.subtitle-track-select', error);
      }
      return;
    }

    if (!option) {
      try {
        player.subtitleTrack = null;
      } catch (error) {
        // Track selection can be rejected while the stream is loading.
        reportNonFatal('player.subtitle-track-disable', error);
      }
    }
    requestSelectionStream(activeAudioKey || audioOptions[0]?.key || '', nextSubtitleKey);
  };

  const progressFractionValue = duration > 0 ? Math.min(1, position / duration) : 0;
  const activeMediaSegment = useMemo(() => activeKnownMediaSegmentAt(mediaSegments, position), [mediaSegments, position]);
  const activeSegmentLabel = activeMediaSegment ? mobileMediaSegmentLabel(activeMediaSegment.type, target.mediaType === 'movie') : '';
  const displayLabels = playerDisplayLabels(target);
  const controlVerticalPadding = Math.max(insets.top, insets.bottom, 16);
  const aspectRatioValue = aspectRatio === 'default' ? undefined : aspectRatio;
  const cropRatio = cropMode !== 'none' && cropMode !== 'custom' ? cropMode : undefined;
  const videoFrameRatio = cropRatio || aspectRatioValue;
  const menuWidth = Math.max(
    250,
    Math.min(360, playerWidth - Math.max(insets.left, 20) - Math.max(insets.right, 20) - 16),
  );

  return (
    <Animated.View
      accessibilityViewIsModal
      importantForAccessibility="yes"
      style={[styles.overlay, styles.playerRoot, entrance]}
    >
      <StatusBar style="light" hidden />
      {playbackUrl ? (
        <>
          <View
            {...playerUnderlayAccessibilityProps}
            style={[
              styles.playerVideoFrame,
              videoFrameRatio ? { aspectRatio: videoFrameRatio, maxHeight: '100%', width: '100%' } : styles.playerVideoFrameFill,
            ]}
          >
            <VideoView
              contentFit={cropMode === 'none' ? 'contain' : 'cover'}
              nativeControls={false}
              player={player}
              style={[styles.playerVideo, rotation === 0 ? null : { transform: [{ rotate: `${rotation}deg` }] }]}
            />
          </View>
          <Pressable
            {...playerUnderlayAccessibilityProps}
            style={StyleSheet.absoluteFill}
            onPress={toggleControls}
            accessibilityLabel={controlsVisible ? 'Hide player controls' : 'Show player controls'}
            {...panHandlers}
          />
          {gestureLevel ? (
            <View {...playerUnderlayAccessibilityProps} style={styles.playerGestureHint} pointerEvents="none">
              <Text style={styles.playerGestureTitle}>
                {gestureLevel.kind === 'brightness' ? 'Brightness' : 'Volume'}
              </Text>
              <View style={styles.playerGestureTrack}>
                <View style={[styles.playerGestureFill, { width: `${gestureLevel.value * 100}%` }]} />
              </View>
              <Text style={styles.playerGestureValue}>{Math.round(gestureLevel.value * 100)}%</Text>
            </View>
          ) : null}
          {activeMediaSegment ? (
            <Pressable
              {...playerUnderlayAccessibilityProps}
              onPress={() => seekToSeconds(activeMediaSegment.endMs === null
                ? Math.max(activeMediaSegment.startMs / 1000, activeMediaSegment.mediaDurationMs / 1000 - 1)
                : activeMediaSegment.endMs / 1000)}
              style={({ pressed }) => [styles.playerSegmentSkip, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={`Skip ${activeSegmentLabel}`}
            >
              <Text style={styles.playerSegmentSkipText}>Skip {activeSegmentLabel}</Text>
            </Pressable>
          ) : null}
          <Animated.View
            style={[StyleSheet.absoluteFill, { opacity: controlsOpacity }]}
            pointerEvents={controlsVisible ? 'box-none' : 'none'}
          >
            <View
              style={[
                styles.playerControls,
                {
                  paddingBottom: controlVerticalPadding,
                  paddingLeft: Math.max(insets.left, 18),
                  paddingRight: Math.max(insets.right, 18),
                  paddingTop: controlVerticalPadding,
                },
              ]}
              pointerEvents="box-none"
            >
              <View
                {...playerUnderlayAccessibilityProps}
                pointerEvents="box-none"
              >
              <View
                style={[
                  styles.playerTopRow,
                  {
                    marginHorizontal: -Math.max(insets.left, 18),
                    marginTop: -controlVerticalPadding,
                  },
                ]}
              >
                <Pressable
                  style={({ pressed }) => [styles.playerIconButton, styles.playerCloseControl, pressed && styles.pressed]}
                  onPress={onClose}
                  accessibilityRole="button"
                  accessibilityLabel="Close player"
                >
                  <CloseIcon size={26} color="#ffffff" />
                </Pressable>
                <Text numberOfLines={1} ellipsizeMode="tail" style={styles.playerTopTitle}>
                  {displayLabels.topTitle}
                </Text>
                <View style={styles.playerOptionsPill}>
                  <Pressable
                    onPress={(event) => {
                      captureMobileFocus(event);
                      toggleMenu('video');
                    }}
                    style={({ pressed }) => [styles.playerFitButton, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel="Video framing settings"
                    accessibilityState={{ expanded: menu === 'video' }}
                  >
                    <Text style={[styles.playerFitLabel, (menu === 'video' || cropMode !== 'none') && styles.playerFitLabelActive]}>
                      {cropMode === 'none' ? 'Fit' : 'Crop'}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={(event) => {
                      captureMobileFocus(event);
                      toggleMenu('subtitles');
                    }}
                    style={({ pressed }) => [styles.playerIconButton, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel="Subtitles"
                    accessibilityState={{ expanded: menu === 'subtitles' }}
                  >
                    <SubtitlesIcon size={22} color={menu === 'subtitles' ? accent : '#ffffff'} />
                  </Pressable>
                  <Pressable
                    onPress={(event) => {
                      captureMobileFocus(event);
                      toggleMenu('audio');
                    }}
                    style={({ pressed }) => [styles.playerIconButton, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel="Audio tracks"
                    accessibilityState={{ expanded: menu === 'audio' }}
                  >
                    <AudioTracksIcon size={22} color={menu === 'audio' ? accent : '#ffffff'} />
                  </Pressable>
                  <Pressable
                    onPress={(event) => {
                      captureMobileFocus(event);
                      toggleMenu('speed');
                    }}
                    style={({ pressed }) => [styles.playerIconButton, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel="Playback speed"
                    accessibilityState={{ expanded: menu === 'speed' }}
                  >
                    <SpeedIcon size={22} color={menu === 'speed' ? accent : '#ffffff'} />
                  </Pressable>
                </View>
              </View>

                <View style={styles.playerCenterOverlay} pointerEvents="box-none">
                  <View style={styles.playerCenterRow} pointerEvents="box-none">
                    <PlayerSkipButton
                      amount={10}
                      direction="back"
                      onPress={() => skipBy(-10)}
                      style={styles.playerSkipBackControl}
                    />
                    <Pressable
                      onPress={togglePlay}
                      style={({ pressed }) => [styles.playerPlayButton, styles.playerPlayCenterControl, pressed && styles.playerControlPressed]}
                      accessibilityRole="button"
                      accessibilityLabel={isPlaying ? 'Pause' : 'Play'}
                    >
                      {isPlaying ? <PauseIcon size={34} color="#0b0b0b" /> : <PlayIcon size={34} color="#0b0b0b" />}
                    </Pressable>
                    <PlayerSkipButton
                      amount={10}
                      direction="forward"
                      onPress={() => skipBy(10)}
                      style={styles.playerSkipForwardControl}
                    />
                  </View>
                </View>

              <View style={[styles.playerBottomBlock, { bottom: controlVerticalPadding }]} pointerEvents="box-none">
                <Text numberOfLines={1} ellipsizeMode="tail" style={styles.playerTitle}>
                  {displayLabels.bottomTitle}
                </Text>
                <Pressable
                  style={styles.playerSeekTrackHit}
                  onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
                  onPress={(event) => {
                    if (trackWidth > 0) seekToFraction(event.nativeEvent.locationX / trackWidth);
                  }}
                  accessibilityRole="adjustable"
                  accessibilityLabel="Seek"
                  accessibilityValue={{
                    min: 0,
                    max: duration,
                    now: Math.min(position, duration || 0),
                    text: mobileSeekAccessibilityText(position, duration),
                  }}
                  accessibilityActions={[
                    { name: 'decrement', label: 'Seek backward 10 seconds' },
                    { name: 'increment', label: 'Seek forward 10 seconds' },
                  ]}
                  onAccessibilityAction={({ nativeEvent }) => {
                    if (nativeEvent.actionName === 'decrement') seekToSeconds(position - 10);
                    if (nativeEvent.actionName === 'increment') seekToSeconds(position + 10);
                  }}
                >
                  <View style={styles.playerSeekTrack}>
                    <View style={[styles.playerSeekFill, { width: `${progressFractionValue * 100}%` }]} />
                    <View style={[styles.playerSeekThumb, { left: `${progressFractionValue * 100}%` }]} />
                  </View>
                </Pressable>
                <View style={styles.playerTimesRow}>
                  <Text style={styles.playerTime}>{formatClock(position)}</Text>
                  <Text style={styles.playerTime}>{formatClock(duration)}</Text>
                  <Text style={styles.playerTime}>-{formatClock(Math.max(0, duration - position))}</Text>
                </View>
              </View>
              </View>

              {menu !== 'none' ? (
                <View
                  style={[
                    styles.playerMenuPanel,
                    menu === 'video' && { width: menuWidth },
                    { right: Math.max(insets.right, 20), top: Math.max(insets.top, 16) + 56 },
                  ]}
                  accessibilityViewIsModal
                  importantForAccessibility="yes"
                >
                  <Text style={styles.playerMenuTitle}>
                    {menu === 'video' ? 'Video' : menu === 'speed' ? 'Playback Speed' : menu === 'audio' ? 'Audio' : 'Subtitles'}
                  </Text>
                  <ScrollView
                    accessibilityLabel={`${menu === 'video' ? 'Video' : menu === 'speed' ? 'Playback speed' : menu === 'audio' ? 'Audio' : 'Subtitles'} options`}
                    accessibilityRole="menu"
                    style={styles.playerMenuScroll}
                  >
                    {menu === 'video' ? (
                      <View style={styles.playerVideoSettings}>
                        <View style={styles.playerSettingBlock}>
                          <Text style={styles.playerSettingLabel}>Aspect ratio:</Text>
                          <PlayerSegmentedControl
                            options={PLAYER_ASPECT_OPTIONS}
                            value={aspectRatio}
                            onChange={(value) => {
                              showControls();
                              setAspectRatio(value);
                            }}
                          />
                        </View>
                        <View style={styles.playerSettingBlock}>
                          <Text style={styles.playerSettingLabel}>Crop:</Text>
                          <PlayerSegmentedControl
                            options={PLAYER_CROP_OPTIONS}
                            value={cropMode}
                            onChange={(value) => {
                              showControls();
                              setCropMode(value);
                            }}
                          />
                        </View>
                        <View>
                          <Text style={styles.playerSettingLabel}>Rotation:</Text>
                          <PlayerSegmentedControl
                            options={PLAYER_ROTATION_OPTIONS}
                            value={rotation}
                            onChange={(value) => {
                              showControls();
                              setRotation(value);
                            }}
                          />
                        </View>
                      </View>
                    ) : menu === 'speed' ? (
                      [0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                        <PlayerMenuRow
                          key={rate}
                          label={rate === 1 ? 'Normal' : `${rate}×`}
                          selected={playbackRate === rate}
                          onPress={() => selectRate(rate)}
                        />
                      ))
                    ) : menu === 'audio' ? (
                      audioOptions.length <= 1 ? (
                        <Text style={styles.playerMenuEmpty}>This stream has a single audio track.</Text>
                      ) : (
                        audioOptions.map((option) => (
                          <PlayerMenuRow
                            key={option.key}
                            label={option.label}
                            selected={activeAudioKey ? activeAudioKey === option.key : audioOptions[0]?.key === option.key}
                            onPress={() => selectAudioOption(option)}
                          />
                        ))
                      )
                    ) : (
                      <>
                        <View style={styles.playerSettingBlock}>
                          <Text style={styles.playerSettingLabel}>Subtitle size:</Text>
                          <PlayerSegmentedControl
                            options={MOBILE_SUBTITLE_SIZE_OPTIONS}
                            value={subtitleFontSize}
                            onChange={selectSubtitleFontSize}
                          />
                        </View>
                        <PlayerMenuRow
                          label="Off"
                          selected={activeSubtitleKey === 'off'}
                          onPress={() => selectSubtitleOption(null)}
                        />
                        {subtitleOptions.map((option) => (
                          <PlayerMenuRow
                            key={option.key}
                            label={option.label}
                            selected={activeSubtitleKey === option.key}
                            onPress={() => selectSubtitleOption(option)}
                          />
                        ))}
                        {subtitleOptions.length === 0 ? (
                          <Text style={styles.playerMenuEmpty}>No subtitle tracks in this stream.</Text>
                        ) : null}
                      </>
                    )}
                  </ScrollView>
                </View>
              ) : null}
              </View>
          </Animated.View>
        </>
      ) : (
        <>
          <View style={styles.playerStatus}>
            {isPreparing ? <ActivityIndicator color={accent} size="large" /> : null}
            <Text selectable style={styles.playerStatusText}>
              {failure?.message || (isPreparing
                ? (showLongPreparation ? 'Preparing stream…' : 'Connecting to server…')
                : 'Starting playback…')}
            </Text>
            <Text selectable numberOfLines={2} style={styles.playerStatusTitle}>{target.title}</Text>
            {failure ? (
              <>
                {recoveryAction ? (
                  <Text selectable style={styles.playerRecoveryText}>{recoveryAction.description}</Text>
                ) : null}
                <View style={styles.playerRecoveryActions}>
                  {recoveryAction ? (
                    <Pressable
                      style={({ pressed }) => [styles.playerStatusButton, styles.playerStatusButtonPrimary, pressed && styles.pressed]}
                      onPress={onRetry}
                      accessibilityRole="button"
                      accessibilityLabel={recoveryAction.label}
                    >
                      <Text style={styles.playerStatusButtonPrimaryText}>{recoveryAction.label}</Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    style={({ pressed }) => [styles.playerStatusButton, pressed && styles.pressed]}
                    onPress={onClose}
                    accessibilityRole="button"
                    accessibilityLabel="Back to library"
                  >
                    <Text style={styles.playerStatusButtonText}>Back to library</Text>
                  </Pressable>
                </View>
              </>
            ) : null}
          </View>
          <Pressable
            style={({ pressed }) => [styles.playerClose, { top: insets.top + 8 }, pressed && styles.pressed]}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close player"
          >
            <CloseIcon size={24} color="#ffffff" />
          </Pressable>
        </>
      )}
    </Animated.View>
  );
}
