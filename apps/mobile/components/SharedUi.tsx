import { memo, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  type ImageStyle,
  Pressable,
  type PressableProps,
  StyleSheet,
  type StyleProp,
  View,
  type ViewStyle,
} from 'react-native';
import { Image as ExpoImage, type ImageContentFit } from 'expo-image';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect as SvgRect, Stop } from 'react-native-svg';
import { BackIcon } from './LoomIcons';
import { captureMobileFocus } from '../mobileModalStack';
import { secureLanUrl } from '../mobileSecureTransport';
import { useMobileTheme } from '../mobileThemeContext';
import { useMobileReducedMotion } from '../mobileReducedMotion';
import type { MediaItem, MobileProfile } from '../mobileDomain';

const PROFILE_COLOR_HEX: Record<string, string> = {
  ember: 'f97316',
  gold: 'f59e0b',
  crimson: 'dc3f4f',
  ocean: '207ce5',
  violet: '8551dc',
  teal: '24a9a1',
  rose: 'de3d72',
  slate: '64748b',
};

export function mobileProfileAvatarUri(profile: Pick<MobileProfile, 'avatarKey' | 'colorKey'>): string {
  if (profile.avatarKey.startsWith('data:image/')) return profile.avatarKey;
  const match = /(?:glyph|weave)-(\d+)$/.exec(profile.avatarKey);
  const parsed = match ? Number.parseInt(match[1], 10) : 1;
  const glyph = Number.isFinite(parsed) && parsed > 0 ? ((parsed - 1) % 12) + 1 : 1;
  const variant = String(glyph).padStart(2, '0');
  const color = PROFILE_COLOR_HEX[profile.colorKey] || PROFILE_COLOR_HEX.ember;
  return `https://api.dicebear.com/10.x/glyphs/png?seed=loomtv-glyph-${variant}&shapeVariant=variant${variant}&backgroundColor=${color}&backgroundColorFill=solid&glyphColor=${color}&glyphColorFill=solid&size=256`;
}
const imageLoadTimeoutMs = 8000;
const imageRetryDelayMs = 12000;
const imageCacheBustQueryParam = 'loomtvImageBust';

export function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return 'Runtime unknown';
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0 ? `${hours}h ${remainder}m` : `${minutes}m`;
}

export function formatShortMinutes(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  return `${Math.max(1, Math.round(seconds / 60))}m`;
}

export function seasonCountLabel(item: MediaItem): string {
  const seasons = new Set((item.episodeFiles || []).map((ep) => ep.season)).size;
  if (seasons > 0) return `${seasons} ${seasons === 1 ? 'season' : 'seasons'}`;
  return item.type === 'anime' ? 'Anime' : 'Series';
}

function appendImageCacheBust(url: string, cacheBust?: string): string {
  if (!cacheBust || !/^https?:/i.test(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set(imageCacheBustQueryParam, cacheBust);
    return parsed.toString();
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}${imageCacheBustQueryParam}=${encodeURIComponent(cacheBust)}`;
  }
}

export function imageUrlFor(baseUrl: string, source?: string, cacheBust?: string): string {
  if (!source) return '';
  if (/^(file:|data:|blob:)/i.test(source)) return source;
  const url = /^https?:/i.test(source) ? source : `${baseUrl}${source.startsWith('/') ? '' : '/'}${source}`;
  return secureLanUrl(appendImageCacheBust(url, cacheBust));
}

export function imageUrlsFor(baseUrl: string, sources: Array<string | undefined>, cacheBust?: string): string[] {
  return Array.from(new Set(sources.map((source) => imageUrlFor(baseUrl, source, cacheBust)).filter(Boolean)));
}

export function FallbackImage({
  altFallback,
  resizeMode,
  sources,
  style,
}: {
  altFallback: ReactElement;
  resizeMode?: 'cover' | 'contain' | 'stretch' | 'repeat' | 'center';
  sources: string[];
  style: StyleProp<ImageStyle>;
}) {
  const [sourceIndex, setSourceIndex] = useState(0);
  const [retryEpoch, setRetryEpoch] = useState(0);
  const sourcesKey = sources.join('|');
  const source = sources[sourceIndex] || '';
  const exhausted = !source && sources.length > 0;

  useEffect(() => {
    setSourceIndex(0);
  }, [sourcesKey]);

  // The desktop server can be briefly unreachable (asleep, restarting, or
  // relaunching during development). Without a retry, one failed pass through
  // the sources leaves the placeholder up for good even after the host comes
  // back, so exhausted sources restart from the top after a pause. The epoch
  // in the render key remounts the image so a URL that already failed gets a
  // fresh native load instead of being ignored as an unchanged prop.
  useEffect(() => {
    if (!exhausted) return;
    const timer = setTimeout(() => {
      setRetryEpoch((current) => current + 1);
      setSourceIndex(0);
    }, imageRetryDelayMs);
    return () => clearTimeout(timer);
  }, [exhausted]);

  if (!source) return altFallback;

  return (
    <FadeInImage
      key={`${retryEpoch}:${source}`}
      uri={source}
      style={style}
      resizeMode={resizeMode}
      onError={() => setSourceIndex((current) => current + 1)}
    />
  );
}

const ShimmerOverlay = memo(function ShimmerOverlay() {
  const { styles } = useMobileTheme();
  const reduceMotion = useMobileReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;
  const [width, setWidth] = useState(0);

  useEffect(() => {
    progress.stopAnimation();
    if (reduceMotion) {
      progress.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 1300,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [progress, reduceMotion]);

  // A soft, transparent-edged sheen sized to the frame, swept from fully off the
  // left to fully off the right at a constant speed. Because both ends of the
  // travel put the highlight entirely out of view, the loop restart is invisible
  // — no hard bar, no stall at the edges, no snap-back flicker. Sizing to the
  // measured width keeps the sweep consistent across posters, thumbnails, and the
  // detail backdrop.
  const bandWidth = Math.max(140, width * 0.85);
  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-bandWidth, width + bandWidth],
  });

  return (
    <View
      pointerEvents="none"
      style={styles.shimmerBase}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {!reduceMotion && width > 0 ? (
        <Animated.View
          style={[styles.shimmerBand, { width: bandWidth, transform: [{ translateX }, { skewX: '-18deg' }] }]}
        >
          <Svg width="100%" height="100%">
            <Defs>
              <SvgLinearGradient id="shimmerSheen" x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor="#ffffff" stopOpacity={0} />
                <Stop offset="0.5" stopColor="#ffffff" stopOpacity={0.18} />
                <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
              </SvgLinearGradient>
            </Defs>
            <SvgRect x="0" y="0" width="100%" height="100%" fill="url(#shimmerSheen)" />
          </Svg>
        </Animated.View>
      ) : null}
    </View>
  );
});

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// A Pressable that springs down slightly while held, then back on release.
// Replaces the flat opacity dim for cards and primary buttons so touches feel
// tactile without being flashy.
export function PressableScale({
  accessibilityLabel,
  accessibilityRole,
  accessibilityState,
  children,
  disabled,
  onFocus,
  onPress,
  scaleTo = 0.96,
  style,
}: {
  accessibilityLabel?: string;
  accessibilityRole?: 'button' | 'tab' | 'menuitem' | 'adjustable';
  accessibilityState?: { selected?: boolean; disabled?: boolean };
  children: ReactNode;
  disabled?: boolean;
  onFocus?: PressableProps['onFocus'];
  onPress?: PressableProps['onPress'];
  scaleTo?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const reduceMotion = useMobileReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!reduceMotion) return;
    scale.stopAnimation();
    scale.setValue(1);
  }, [reduceMotion, scale]);
  const springTo = (toValue: number) => {
    if (reduceMotion) {
      scale.stopAnimation();
      scale.setValue(1);
      return;
    }
    Animated.spring(scale, {
      toValue,
      useNativeDriver: true,
      speed: 45,
      bounciness: toValue < 1 ? 0 : 7,
    }).start();
  };
  return (
    <AnimatedPressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
      accessibilityState={accessibilityState}
      disabled={disabled}
      onFocus={onFocus}
      onPress={(event) => {
        captureMobileFocus(event);
        onPress?.(event);
      }}
      onPressIn={() => springTo(scaleTo)}
      onPressOut={() => springTo(1)}
      style={[style, { transform: [{ scale }] }]}
    >
      {children}
    </AnimatedPressable>
  );
}

// Fades an image in on load instead of letting it pop, softening poster,
// backdrop, and thumbnail swaps. Resets when the source URI changes.
function resizeModeToContentFit(resizeMode?: 'cover' | 'contain' | 'stretch' | 'repeat' | 'center'): ImageContentFit {
  switch (resizeMode) {
    case 'contain': return 'contain';
    case 'stretch': return 'fill';
    case 'center': return 'none';
    default: return 'cover';
  }
}

export function FadeInImage({
  onError,
  resizeMode,
  style,
  uri,
}: {
  onError?: () => void;
  resizeMode?: 'cover' | 'contain' | 'stretch' | 'repeat' | 'center';
  style: StyleProp<ImageStyle>;
  uri: string;
}) {
  const { styles } = useMobileTheme();
  const [loaded, setLoaded] = useState(false);
  const settledRef = useRef(false);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    settledRef.current = false;
    setLoaded(false);
    const timeout = setTimeout(() => {
      if (settledRef.current) return;
      settledRef.current = true;
      setLoaded(true);
      onErrorRef.current?.();
    }, imageLoadTimeoutMs);
    return () => clearTimeout(timeout);
  }, [uri]);

  const settleAsLoaded = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    setLoaded(true);
  };

  const settleAsFailed = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    setLoaded(true);
    onErrorRef.current?.();
  };

  // expo-image keeps a persistent memory + disk cache, so an image loads once
  // and is reused across scrolls, screens, and app restarts instead of being
  // refetched. Its native transition fades the image in on first load but shows
  // instantly on a cache hit, and `recyclingKey` resets cleanly when a recycled
  // FlatList cell swaps to a different URL.
  return (
    <View style={[style as StyleProp<ViewStyle>, styles.imageLoadFrame]}>
      {!loaded ? <ShimmerOverlay /> : null}
      <ExpoImage
        source={uri}
        style={StyleSheet.absoluteFill}
        contentFit={resizeModeToContentFit(resizeMode)}
        transition={220}
        cachePolicy="memory-disk"
        recyclingKey={uri}
        onLoad={settleAsLoaded}
        onError={settleAsFailed}
      />
    </View>
  );
}

// One-shot mount entrance for full-screen overlays: fade, with an optional rise.
export function useEntrance(translateY = 0) {
  const reduceMotion = useMobileReducedMotion();
  const progress = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  const hasEntered = useRef(false);
  useEffect(() => {
    progress.stopAnimation();
    if (reduceMotion || hasEntered.current) {
      progress.setValue(1);
      hasEntered.current = true;
      return;
    }
    hasEntered.current = true;
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 300,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [progress, reduceMotion]);
  return {
    opacity: progress,
    transform: translateY
      ? [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [translateY, 0] }) }]
      : undefined,
  };
}

export function SubpageBackButton({
  accessibilityLabel = 'Back',
  onPress,
  style,
}: {
  accessibilityLabel?: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { styles } = useMobileTheme();
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.subpageBackButton, style, pressed && styles.pressed]}
    >
      <BackIcon size={24} color="#ffffff" />
    </Pressable>
  );
}
