import { memo, useEffect, useMemo, useState, type ReactElement, type Ref } from 'react';
import {
  FlatList,
  Pressable,
  type RefreshControlProps,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  type StyleProp,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect as SvgRect, Stop } from 'react-native-svg';
import { ChevronRightIcon, PlayIcon, PlayMark, StarIcon } from './LoomIcons';
import { captureMobileFocus } from '../mobileModalStack';
import { useMobileTheme } from '../mobileThemeContext';
import { collections } from '../mobileLibrary';
import type { LibraryKind, MediaItem } from '../mobileDomain';
import { FadeInImage, FallbackImage, PressableScale, formatDuration, imageUrlFor, imageUrlsFor, seasonCountLabel } from './SharedUi';

export function HomeSections({
  artworkCacheBusters,
  baseUrl,
  continueWatching,
  grouped,
  isTablet,
  myList,
  onOpenKind,
  onResume,
  onSelect,
}: {
  artworkCacheBusters: Record<string, string>;
  baseUrl: string;
  continueWatching: MediaItem[];
  grouped: ReturnType<typeof collections>;
  isTablet: boolean;
  myList: MediaItem[];
  onOpenKind: (kind: LibraryKind) => void;
  onResume: (item: MediaItem) => void;
  onSelect: (item: MediaItem) => void;
}) {
  const { styles } = useMobileTheme();
  const hasItems = grouped.anime.length > 0 || grouped.tv.length > 0 || grouped.movies.length > 0;

  // Keep one featured title fixed while Home remains mounted. Playback progress
  // updates `lastPlayed`, but that should not replace the cover already shown.
  const heroCandidates = useMemo<MediaItem[]>(() => {
    const picked = new Set<string>();
    const items: MediaItem[] = [];
    for (const item of [...continueWatching, ...grouped.anime, ...grouped.tv, ...grouped.movies]) {
      if (picked.has(item.id)) continue;
      picked.add(item.id);
      items.push(item);
    }
    return items;
  }, [continueWatching, grouped]);
  const [heroItemId, setHeroItemId] = useState(() => heroCandidates[0]?.id || '');

  useEffect(() => {
    const availableIds = new Set(heroCandidates.map((item) => item.id));
    setHeroItemId((current) => availableIds.has(current) ? current : heroCandidates[0]?.id || '');
  }, [heroCandidates]);

  const heroItem = heroCandidates.find((item) => item.id === heroItemId);

  return (
    <View style={styles.sections}>
      {heroItem ? (
        <HomeHero
          artworkCacheBusters={artworkCacheBusters}
          baseUrl={baseUrl}
          isTablet={isTablet}
          item={heroItem}
          resume={continueWatching.some((item) => item.id === heroItem.id)}
          onPlay={onResume}
          onSelect={onSelect}
        />
      ) : null}
      {continueWatching.length > 0 ? (
        <Rail title="Continue Watching" artworkCacheBusters={artworkCacheBusters} items={continueWatching} baseUrl={baseUrl} onSelect={onSelect} />
      ) : null}
      {myList.length > 0 ? <Rail title="My List" artworkCacheBusters={artworkCacheBusters} items={myList} baseUrl={baseUrl} onSelect={onSelect} /> : null}
      <Rail title="Anime" artworkCacheBusters={artworkCacheBusters} items={grouped.anime.slice(0, 24)} baseUrl={baseUrl} onSelect={onSelect} onPressTitle={() => onOpenKind('anime')} />
      <Rail title="TV Shows" artworkCacheBusters={artworkCacheBusters} items={grouped.tv.slice(0, 24)} baseUrl={baseUrl} onSelect={onSelect} onPressTitle={() => onOpenKind('tv')} />
      <Rail title="Movies" artworkCacheBusters={artworkCacheBusters} items={grouped.movies.slice(0, 24)} baseUrl={baseUrl} onSelect={onSelect} onPressTitle={() => onOpenKind('movies')} />
      {!hasItems ? <EmptyLibrary isTablet={isTablet} /> : null}
    </View>
  );
}

// A fixed featured card. This deliberately is not horizontally scrollable:
// diagonal vertical gestures must never snap Home to a different cover.
function HomeHero({
  artworkCacheBusters,
  baseUrl,
  isTablet,
  item,
  resume,
  onPlay,
  onSelect,
}: {
  artworkCacheBusters: Record<string, string>;
  baseUrl: string;
  isTablet: boolean;
  item: MediaItem;
  resume: boolean;
  onPlay: (item: MediaItem) => void;
  onSelect: (item: MediaItem) => void;
}) {
  const { styles } = useMobileTheme();
  const { width } = useWindowDimensions();
  const contentWidth = isTablet ? width - 220 : width;
  const cardWidth = isTablet ? Math.min(contentWidth - 56, 460) : contentWidth - 32;
  const cardHeight = Math.round(cardWidth * 1.42);

  return (
    <View style={styles.heroCarousel}>
      <HeroCard
        baseUrl={baseUrl}
        cacheBust={artworkCacheBusters[item.id]}
        height={cardHeight}
        item={item}
        resume={resume}
        onPlay={() => onPlay(item)}
        onSelect={() => onSelect(item)}
        width={cardWidth}
      />
    </View>
  );
}

function HeroCard({
  baseUrl,
  cacheBust,
  height,
  item,
  resume,
  onPlay,
  onSelect,
  width,
}: {
  baseUrl: string;
  cacheBust?: string;
  height: number;
  item: MediaItem;
  resume: boolean;
  onPlay: () => void;
  onSelect: () => void;
  width: number;
}) {
  const { colors: { accent, accentForeground }, styles } = useMobileTheme();
  const canonicalPoster = item.poster || item.posterCandidates?.[0];
  const sources = useMemo(
    () => imageUrlsFor(baseUrl, [canonicalPoster], cacheBust),
    [baseUrl, cacheBust, canonicalPoster],
  );
  const meta = [
    item.type === 'movie' ? 'Movie' : item.type === 'anime' ? 'Anime' : 'TV Show',
    item.year ? String(item.year) : null,
    item.type === 'movie' ? (item.localMetadata?.durationSeconds ? formatDuration(item.localMetadata.durationSeconds) : null) : seasonCountLabel(item),
  ].filter(Boolean).join(' · ');
  const rating = item.rating && item.rating > 0 ? item.rating : null;

  return (
    <View style={[styles.heroCard, { height, width }]}>
      <PressableScale
        accessibilityLabel={`Open ${item.title}`}
        accessibilityRole="button"
        onPress={onSelect}
        scaleTo={0.98}
        style={StyleSheet.absoluteFill}
      >
        <View pointerEvents="none" style={StyleSheet.absoluteFill} />
      </PressableScale>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <FallbackImage
          sources={sources}
          style={styles.heroCardImage}
          resizeMode="cover"
          altFallback={(
            <View style={[styles.heroCardImage, styles.posterFallback]}>
              <PlayMark size={40} color={accent} />
            </View>
          )}
        />
        <Svg pointerEvents="none" style={styles.heroCardShade} viewBox="0 0 1 1" preserveAspectRatio="none">
          <Defs>
            <SvgLinearGradient id="heroCardBottomFade" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0.28" stopColor="#050505" stopOpacity={0.12} />
              <Stop offset="0.50" stopColor="#050505" stopOpacity={0.68} />
              <Stop offset="0.74" stopColor="#050505" stopOpacity={0.9} />
              <Stop offset="1" stopColor="#050505" stopOpacity={0.98} />
            </SvgLinearGradient>
          </Defs>
          <SvgRect x="0" y="0" width="1" height="1" fill="url(#heroCardBottomFade)" />
        </Svg>
        <View style={[styles.heroCardFooter, { paddingBottom: 84 }]}>
          <Text numberOfLines={2} style={styles.heroCardTitle}>{item.title}</Text>
          {(meta || rating !== null) ? (
            <View style={styles.heroCardMetaRow}>
              {meta ? <Text numberOfLines={1} style={styles.heroCardMeta}>{meta}</Text> : null}
              {rating !== null ? (
                <View accessibilityLabel={`Rated ${rating.toFixed(1)} out of 10`} style={styles.heroCardRating}>
                  <StarIcon size={13} color="#f5c451" />
                  <Text style={styles.heroCardRatingText}>{rating.toFixed(1)}</Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
      <Pressable
        accessibilityLabel={`${resume ? 'Resume' : 'Play'} ${item.title}`}
        accessibilityRole="button"
        onPress={(event) => {
          captureMobileFocus(event);
          onPlay();
        }}
        style={({ pressed }) => [
          styles.heroPlayButton,
          { bottom: 16, left: 16, position: 'absolute', right: 16, width: undefined, zIndex: 3 },
          pressed && styles.heroPlayButtonPressed,
        ]}
      >
        <PlayIcon size={22} color={accentForeground} />
        <Text style={styles.heroPlayButtonText}>{resume ? 'Resume' : 'Play'}</Text>
      </Pressable>
    </View>
  );
}

function Rail({
  artworkCacheBusters,
  badgeLabel,
  baseUrl,
  items,
  onPressTitle,
  onSelect,
  title,
}: {
  artworkCacheBusters: Record<string, string>;
  badgeLabel?: string;
  baseUrl: string;
  items: MediaItem[];
  onPressTitle?: () => void;
  onSelect: (item: MediaItem) => void;
  title: string;
}) {
  const { colors: { text }, styles } = useMobileTheme();
  if (items.length === 0) return null;
  return (
    <View style={styles.rail}>
      <Pressable
        disabled={!onPressTitle}
        onPress={onPressTitle}
        style={({ pressed }) => [styles.railTitleRow, pressed && styles.pressed]}
        accessibilityRole={onPressTitle ? 'button' : undefined}
        accessibilityLabel={onPressTitle ? `Open ${title}` : undefined}
      >
        <Text numberOfLines={1} style={styles.sectionTitle}>{title}</Text>
        {onPressTitle ? <ChevronRightIcon size={24} color={text} /> : null}
      </Pressable>
      <FlatList
        contentContainerStyle={styles.railContent}
        data={items}
        horizontal
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <PosterCard badgeLabel={badgeLabel} baseUrl={baseUrl} cacheBust={artworkCacheBusters[item.id]} item={item} onSelect={onSelect} width={128} />
        )}
        showsHorizontalScrollIndicator={false}
        // Poster cells are a fixed 128px wide with a 14px gap, so the list can
        // size rows without measuring and only keep a small window mounted.
        getItemLayout={(_data, index) => ({ length: 128, offset: (128 + 14) * index, index })}
        initialNumToRender={5}
        maxToRenderPerBatch={6}
        windowSize={5}
        removeClippedSubviews
      />
    </View>
  );
}

// The single scroller for every non-settings view. It virtualizes the poster
// grid (only a small window of rows stays mounted, instead of the old
// `items.map` that mounted every poster up front) while keeping the search
// `Header` and — in home mode — the rails inside `ListHeaderComponent`. Because
// it's one persistent FlatList, the Header never remounts when the query toggles
// between rails and grid, so search keeps keyboard focus.
export function LibraryList({
  artworkCacheBusters,
  baseUrl,
  contentContainerStyle,
  header = null,
  isTablet,
  items,
  listRef,
  onScroll,
  onSelect,
  refreshControl,
  showEmpty = true,
}: {
  artworkCacheBusters: Record<string, string>;
  baseUrl: string;
  contentContainerStyle?: StyleProp<ViewStyle>;
  header?: ReactElement | null;
  isTablet: boolean;
  items: MediaItem[];
  listRef?: Ref<FlatList<MediaItem>>;
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onSelect: (item: MediaItem) => void;
  refreshControl?: ReactElement<RefreshControlProps>;
  showEmpty?: boolean;
}) {
  const { styles } = useMobileTheme();
  const { width } = useWindowDimensions();
  const gap = 14;
  // Side nav (tablet) is 220px wide; account for the 16px content padding on each side.
  const available = (isTablet ? width - 220 : width) - 32;
  const columns = isTablet ? Math.max(3, Math.floor(available / 180)) : 3;
  const itemWidth = Math.floor((available - gap * (columns - 1)) / columns);
  return (
    <FlatList
      ref={listRef}
      // numColumns can't change without remounting the list; key by it so a
      // rotation that changes the column count rebuilds cleanly (losing scroll
      // position on rotate is acceptable).
      key={columns}
      data={items}
      numColumns={columns}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <PosterCard baseUrl={baseUrl} cacheBust={artworkCacheBusters[item.id]} item={item} onSelect={onSelect} width={itemWidth} />
      )}
      columnWrapperStyle={columns > 1 ? { gap } : undefined}
      contentContainerStyle={[contentContainerStyle, { gap }]}
      ListHeaderComponent={header}
      ListEmptyComponent={showEmpty ? (
        <View style={styles.emptyInline}>
          <Text selectable style={styles.emptyTitle}>No local matches found</Text>
          <Text selectable style={styles.emptyCopy}>Try another search or refresh the server library.</Text>
        </View>
      ) : null}
      refreshControl={refreshControl}
      // The content padding already includes the safe-area top inset; letting
      // iOS also apply automatic content insets doubles the gap under the
      // Dynamic Island (Android ignores this prop, which hid the mismatch).
      contentInsetAdjustmentBehavior="never"
      keyboardShouldPersistTaps="handled"
      onScroll={onScroll}
      scrollEventThrottle={16}
      showsVerticalScrollIndicator={false}
      initialNumToRender={9}
      maxToRenderPerBatch={9}
      windowSize={7}
      removeClippedSubviews
    />
  );
}

// Memoized: a poster is rendered in every rail and across the whole grid, and
// its props (item, stable onSelect setter, baseUrl, width) don't change when the
// app re-renders for unrelated reasons — e.g. the periodic progress sync during
// playback. Without memo, every such re-render walks hundreds of posters.
const PosterCard = memo(function PosterCard({
  badgeLabel,
  baseUrl,
  cacheBust,
  item,
  onSelect,
  width,
}: {
  badgeLabel?: string;
  baseUrl: string;
  cacheBust?: string;
  item: MediaItem;
  onSelect: (item: MediaItem) => void;
  width: number;
}) {
  const { colors: { accent }, styles } = useMobileTheme();
  const posterCandidates = useMemo(
    () => [
      item.poster,
      ...(item.posterCandidates || []),
      item.backdrop,
      ...(item.backdropCandidates || []),
    ].map((source) => imageUrlFor(baseUrl, source, cacheBust)).filter(Boolean),
    [baseUrl, cacheBust, item.backdrop, item.backdropCandidates, item.poster, item.posterCandidates],
  );
  const [posterIndex, setPosterIndex] = useState(0);
  const poster = posterCandidates[posterIndex] || '';

  useEffect(() => {
    setPosterIndex(0);
  }, [item.id, posterCandidates]);

  // Plex-style single meta line: year for movies, season count for series.
  const meta = item.type === 'movie'
    ? (item.year ? String(item.year) : 'Movie')
    : seasonCountLabel(item);
  return (
    <PressableScale
      style={[styles.posterCard, { width }]}
      onPress={() => onSelect(item)}
      accessibilityRole="button"
      accessibilityLabel={item.title}
    >
      <View style={styles.posterFrame}>
        {poster ? (
          <FadeInImage
            uri={poster}
            style={styles.posterImage}
            onError={() => setPosterIndex((current) => current + 1)}
          />
        ) : (
          <View style={styles.posterFallback}>
            <PlayMark size={26} color={accent} />
          </View>
        )}
        {item.rating && item.rating > 0 ? (
          <View
            accessibilityLabel={`Rated ${item.rating.toFixed(1)} out of 10`}
            accessibilityRole="text"
            style={styles.posterRatingBadge}
          >
            <StarIcon size={11} color="#f5c451" />
            <Text style={styles.posterRatingText}>{item.rating.toFixed(1)}</Text>
          </View>
        ) : null}
        {badgeLabel ? (
          <View style={styles.posterBadge}>
            <View style={styles.posterBadgeDot} />
            <Text style={styles.posterBadgeText}>{badgeLabel}</Text>
          </View>
        ) : null}
      </View>
      <Text selectable numberOfLines={2} ellipsizeMode="tail" style={styles.posterTitle}>{item.title}</Text>
      <Text selectable numberOfLines={1} style={styles.metaText}>{meta}</Text>
    </PressableScale>
  );
});

function EmptyLibrary({ isTablet }: { isTablet: boolean }) {
  const { styles } = useMobileTheme();
  return (
    <View style={[styles.emptyLibrary, isTablet && styles.emptyLibraryTablet]}>
      <View style={styles.emptyIcon}>
        <Text style={styles.emptyIconText}>＋</Text>
      </View>
      <Text selectable style={styles.emptyTitle}>Add your first library folder on the server</Text>
      <Text selectable style={styles.emptyCopy}>
        Pairing worked. Add video folders on your LoomTV server, then refresh here.
      </Text>
    </View>
  );
}
