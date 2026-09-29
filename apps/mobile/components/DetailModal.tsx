import { StatusBar } from 'expo-status-bar';
import { memo, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect as SvgRect, Stop } from 'react-native-svg';
import {
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  PlayIcon,
  PlayMark,
  RefreshIcon,
  StarIcon,
} from './LoomIcons';
import { captureMobileFocus, useMobileModalLayer } from '../mobileModalStack';
import { useMobileTheme } from '../mobileThemeContext';
import { mediaIdForPlayTarget } from '../useMobileDownloadsController';
import {
  episodeCode,
  episodePlayTarget,
  orderedSeasonNumbers,
  playTargetForItem,
  progressStateFor,
  sortedEpisodes,
  streamPathFor,
} from '../mobileLibrary';
import type {
  EpisodeFile,
  LibraryKind,
  MediaItem,
  MobileProfile,
  OfficialMetadataCandidate,
  PlayTarget,
  StoredProgress,
} from '../mobileDomain';
import { FallbackImage, PressableScale, SubpageBackButton, formatDuration, formatShortMinutes, imageUrlsFor, useEntrance } from './SharedUi';
import { mobileLanClient } from '../mobileLanClientInstance';
import { BottomNav } from './Navigation';

const mobileEpisodeAirDateFormatter = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
  year: 'numeric',
});

function formatMobileEpisodeAirDate(value?: string): string {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return mobileEpisodeAirDateFormatter.format(date);
}

function mobileSeasonLabel(season: number): string {
  return season === 0 ? 'Specials' : `Season ${season}`;
}

function metadataCandidateKey(candidate: OfficialMetadataCandidate, index: number): string {
  return candidate.id || `${candidate.source || 'source'}-${candidate.title || 'untitled'}-${candidate.year || 'year'}-${index}`;
}

export function DetailModal({
  activeProfile,
  activeKind,
  artworkCacheBusters,
  artworkRefreshError,
  baseUrl,
  hasMiniPlayer,
  accessibilityHidden,
  isRefreshingArtwork,
  isTablet,
  item,
  isWatchlisted,
  progress,
  onClose,
  onOpenKind,
  onToggleList,
  onPlay,
  onDownload,
  onRemoveDownload,
  downloadedMediaIds,
  downloadingMediaId,
  onRefreshArtwork,
}: {
  activeProfile: MobileProfile | null;
  activeKind: LibraryKind;
  artworkCacheBusters: Record<string, string>;
  artworkRefreshError: string;
  baseUrl: string;
  hasMiniPlayer: boolean;
  accessibilityHidden?: boolean;
  isRefreshingArtwork: boolean;
  isTablet: boolean;
  item: MediaItem | null;
  isWatchlisted: boolean;
  progress: Record<string, StoredProgress>;
  onClose: () => void;
  onOpenKind: (kind: LibraryKind) => void;
  onToggleList: (kind: 'watchlist' | 'favorite', present: boolean) => Promise<void>;
  onPlay: (target: PlayTarget) => void;
  onDownload: (target: PlayTarget) => Promise<void>;
  onRemoveDownload: (target: PlayTarget) => Promise<void>;
  downloadedMediaIds: ReadonlySet<string>;
  downloadingMediaId: string;
  onRefreshArtwork: (item: MediaItem) => void;
}) {
  if (!item) return null;
  // Keyed so per-show state (selected season) resets when a different title opens.
  return (
    <DetailContent
      key={item.id}
      activeProfile={activeProfile}
      activeKind={activeKind}
      artworkCacheBusters={artworkCacheBusters}
      artworkRefreshError={artworkRefreshError}
      baseUrl={baseUrl}
      hasMiniPlayer={hasMiniPlayer}
      accessibilityHidden={accessibilityHidden}
      isRefreshingArtwork={isRefreshingArtwork}
      isTablet={isTablet}
      item={item}
      isWatchlisted={isWatchlisted}
      progress={progress}
      onClose={onClose}
      onOpenKind={onOpenKind}
      onToggleList={onToggleList}
      onPlay={onPlay}
      onDownload={onDownload}
      onRemoveDownload={onRemoveDownload}
      downloadedMediaIds={downloadedMediaIds}
      downloadingMediaId={downloadingMediaId}
      onRefreshArtwork={onRefreshArtwork}
    />
  );
}

const HeroGradient = memo(function HeroGradient() {
  const { colors: { bg } } = useMobileTheme();
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <SvgLinearGradient id="heroFade" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0.3" stopColor={bg} stopOpacity={0} />
          <Stop offset="0.82" stopColor={bg} stopOpacity={0.85} />
          <Stop offset="1" stopColor={bg} stopOpacity={1} />
        </SvgLinearGradient>
      </Defs>
      <SvgRect x="0" y="0" width="100%" height="100%" fill="url(#heroFade)" />
    </Svg>
  );
});

function DetailContent({
  activeProfile,
  activeKind,
  artworkCacheBusters,
  artworkRefreshError,
  baseUrl,
  hasMiniPlayer,
  accessibilityHidden,
  isRefreshingArtwork,
  isTablet,
  item,
  isWatchlisted,
  progress,
  onClose,
  onOpenKind,
  onToggleList,
  onPlay,
  onDownload,
  onRemoveDownload,
  downloadedMediaIds,
  downloadingMediaId,
  onRefreshArtwork,
}: {
  activeProfile: MobileProfile | null;
  activeKind: LibraryKind;
  artworkCacheBusters: Record<string, string>;
  artworkRefreshError: string;
  baseUrl: string;
  hasMiniPlayer: boolean;
  accessibilityHidden?: boolean;
  isRefreshingArtwork: boolean;
  isTablet: boolean;
  item: MediaItem;
  isWatchlisted: boolean;
  progress: Record<string, StoredProgress>;
  onClose: () => void;
  onOpenKind: (kind: LibraryKind) => void;
  onToggleList: (kind: 'watchlist' | 'favorite', present: boolean) => Promise<void>;
  onPlay: (target: PlayTarget) => void;
  onDownload: (target: PlayTarget) => Promise<void>;
  onRemoveDownload: (target: PlayTarget) => Promise<void>;
  downloadedMediaIds: ReadonlySet<string>;
  downloadingMediaId: string;
  onRefreshArtwork: (item: MediaItem) => void;
}) {
  const { colors: { accent, accentForeground, text }, styles } = useMobileTheme();
  const insets = useSafeAreaInsets();
  const isLightTheme = text === '#000000';
  const entrance = useEntrance(16);
  const detailScrollY = useRef(new Animated.Value(0)).current;
  const stickyHeaderOpacity = detailScrollY.interpolate({
    inputRange: [90, 160],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const stickyHeaderTitleTranslateY = detailScrollY.interpolate({
    inputRange: [90, 160],
    outputRange: [-6, 0],
    extrapolate: 'clamp',
  });
  const episodes = useMemo(() => sortedEpisodes(item), [item]);
  const cacheBust = artworkCacheBusters[item.id];
  const heroSources = useMemo(() => {
    const episodeArtwork = episodes.flatMap((episode) => [episode.still, episode.thumbnail]);
    return imageUrlsFor(baseUrl, [
      item.backdrop,
      ...(item.backdropCandidates || []),
      item.poster,
      ...(item.posterCandidates || []),
      ...episodeArtwork,
    ], cacheBust);
  }, [baseUrl, cacheBust, episodes, item.backdrop, item.backdropCandidates, item.poster, item.posterCandidates]);
  const isSeries = item.type !== 'movie' && episodes.length > 0;
  const hasEpisodeTab = item.type !== 'movie';
  const seasonNumbers = useMemo(() => orderedSeasonNumbers(item), [item]);
  const [selectedSeason, setSelectedSeason] = useState(seasonNumbers[0] ?? 1);
  const [seasonPickerOpen, setSeasonPickerOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<'episodes' | 'details'>(hasEpisodeTab ? 'episodes' : 'details');
  const seasonEpisodes = episodes.filter((ep) => ep.season === selectedSeason);
  useMobileModalLayer({
    priority: 20,
    onBack: onClose,
  });
  useMobileModalLayer({
    open: seasonPickerOpen,
    priority: 30,
    onBack: () => setSeasonPickerOpen(false),
  });

  // Plex-style "on deck": first unwatched episode; resume it if in progress.
  const nextUp = useMemo(() => {
    for (const ep of episodes) {
      const state = progressStateFor(progress, ep.filePath, ep.localMetadata?.durationSeconds);
      if (!state.watched) return { ep, state };
    }
    return episodes.length > 0
      ? { ep: episodes[0], state: progressStateFor(progress, episodes[0].filePath, episodes[0].localMetadata?.durationSeconds) }
      : null;
  }, [episodes, progress]);
  const movieState = progressStateFor(progress, streamPathFor(item), item.localMetadata?.durationSeconds);
  const primaryPlayTarget = isSeries && nextUp
    ? episodePlayTarget(item, nextUp.ep, progress)
    : playTargetForItem(item, progress);
  const primaryMediaId = mediaIdForPlayTarget(primaryPlayTarget);
  const isDownloaded = downloadedMediaIds.has(primaryMediaId);
  const isDownloading = downloadingMediaId === primaryMediaId;

  const watchProgress = isSeries && nextUp ? nextUp.state : movieState;
  const watchPrimaryLabel = watchProgress.inProgress ? 'Resume' : isSeries ? 'Watch' : 'Watch Now';
  const watchEpisodeLabel = isSeries && nextUp ? episodeCode(nextUp.ep.season, nextUp.ep.episode) : '';
  const watchProgressCopy = watchProgress.inProgress && watchProgress.duration > 0
    ? `${formatShortMinutes(watchProgress.position)} of ${formatShortMinutes(watchProgress.duration)}`
    : '';
  const watchMetaLabel = [watchEpisodeLabel, watchProgressCopy].filter(Boolean).join(' · ');
  const watchProgressWidth = `${Math.round(watchProgress.fraction * 100)}%` as `${number}%`;
  const onPressPlay = () => {
    onPlay(primaryPlayTarget);
  };

  const contentRating = item.contentRating
    || Object.values(item.contentRatings || {}).find((rating) => rating.code.trim())?.code;
  const reportedEpisodeCount = item.episodeCount || episodes.length || 0;
  const reportedSeasonCount = item.seasonCount || new Set(episodes.map((episode) => episode.season)).size;
  const metaLine = [
    item.year ? String(item.year) : null,
    item.format || null,
    contentRating || null,
    item.type === 'movie'
      ? (item.localMetadata?.durationSeconds
        ? formatDuration(item.localMetadata.durationSeconds)
        : item.runtime || null)
      : [
          reportedSeasonCount > 0 ? `${reportedSeasonCount} season${reportedSeasonCount === 1 ? '' : 's'}` : null,
          reportedEpisodeCount > 0 ? `${reportedEpisodeCount} episode${reportedEpisodeCount === 1 ? '' : 's'}` : null,
        ].filter(Boolean).join(' · ') || 'Episodes',
    item.genres?.slice(0, 2).join(', ') || null,
  ].filter(Boolean).join('   ');
  const detailBottomPadding = 48
    + (!isTablet ? Math.max(insets.bottom, 10) + 70 : 0)
    + (hasMiniPlayer ? 82 : 0);

  return (
    <Animated.View
      accessibilityViewIsModal
      accessibilityElementsHidden={accessibilityHidden}
      importantForAccessibility={accessibilityHidden ? 'no-hide-descendants' : 'yes'}
      onTouchStart={() => {
        if (seasonPickerOpen) setSeasonPickerOpen(false);
      }}
      style={[styles.overlay, entrance]}
    >
      <StatusBar style={text !== '#000000' ? 'light' : 'dark'} />
      <Animated.ScrollView
        contentContainerStyle={[styles.detailScroll, { paddingBottom: detailBottomPadding }]}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: detailScrollY } } }],
          { useNativeDriver: true },
        )}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.detailHero}>
          <FallbackImage
            sources={heroSources}
            style={styles.detailBackdrop}
            resizeMode="cover"
            altFallback={(
              <View style={[styles.detailBackdrop, styles.posterFallback]}>
                <PlayMark size={44} color={accent} />
              </View>
            )}
          />
          <HeroGradient />
        </View>

        <View style={styles.detailBody}>
          <Text selectable numberOfLines={2} style={styles.detailTitle}>{item.title}</Text>
          {metaLine ? <Text selectable style={styles.detailMeta}>{metaLine}</Text> : null}
          {item.rating && item.rating > 0 ? (
            <View style={styles.detailRatingRow}>
              <StarIcon size={15} color="#f5c451" />
              <Text style={styles.detailRatingText}>{item.rating.toFixed(1)}</Text>
            </View>
          ) : null}

          <PressableScale
            scaleTo={0.97}
            style={styles.playButton}
            onPress={onPressPlay}
            accessibilityRole="button"
            accessibilityLabel={`${watchPrimaryLabel}${watchMetaLabel ? ` ${watchMetaLabel}` : ''} ${item.title}`}
          >
            {watchProgress.fraction > 0 ? (
              <View pointerEvents="none" style={[styles.playButtonProgress, { width: watchProgressWidth }]} />
            ) : null}
            <View style={styles.playButtonContent}>
              <PlayIcon size={22} color={accentForeground} />
              <View style={styles.playButtonCopy}>
                <Text style={styles.playButtonText}>{watchPrimaryLabel}</Text>
                {watchMetaLabel ? <Text style={styles.playButtonMeta}>{watchMetaLabel}</Text> : null}
              </View>
            </View>
          </PressableScale>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={isDownloaded ? `Remove downloaded ${primaryPlayTarget.title}` : `Download ${primaryPlayTarget.title}`}
            accessibilityState={{ disabled: isDownloading }}
            disabled={isDownloading}
            onPress={() => void (isDownloaded ? onRemoveDownload(primaryPlayTarget) : onDownload(primaryPlayTarget))}
            style={({ pressed }) => [styles.detailTabButton, isDownloading && styles.disabledButton, pressed && styles.pressed]}
          >
            {isDownloading ? <ActivityIndicator color={accent} size="small" /> : <Ionicons name={isDownloaded ? 'checkmark-circle' : 'download-outline'} size={20} color={accent} />}
            <Text style={styles.detailTabLabel}>{isDownloaded ? 'Remove download' : isDownloading ? 'Downloading…' : 'Download'}</Text>
          </Pressable>
          {artworkRefreshError ? <Text selectable style={styles.detailErrorText}>{artworkRefreshError}</Text> : null}

          {hasEpisodeTab ? (
            <View style={styles.detailTabs} accessibilityRole="tablist">
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: detailTab === 'episodes' }}
                onPress={() => setDetailTab('episodes')}
                style={({ pressed }) => [styles.detailTabButton, pressed && styles.pressed]}
              >
                <Text style={[styles.detailTabLabel, detailTab === 'episodes' && styles.detailTabLabelActive]}>Episodes</Text>
                {detailTab === 'episodes' ? <View style={styles.detailTabIndicator} /> : null}
              </Pressable>
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: detailTab === 'details' }}
                onPress={() => setDetailTab('details')}
                style={({ pressed }) => [styles.detailTabButton, pressed && styles.pressed]}
              >
                <Text style={[styles.detailTabLabel, detailTab === 'details' && styles.detailTabLabelActive]}>Details</Text>
                {detailTab === 'details' ? <View style={styles.detailTabIndicator} /> : null}
              </Pressable>
            </View>
          ) : null}

          {detailTab === 'details' || !hasEpisodeTab ? (
            <DetailInfo baseUrl={baseUrl} cacheBust={cacheBust} item={item} />
          ) : isSeries ? (
            <View style={styles.episodesSection}>
              <View
                onTouchStart={(event) => event.stopPropagation()}
                style={styles.seasonPickerContainer}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Choose season"
                  accessibilityState={{ expanded: seasonPickerOpen }}
                  onPress={() => setSeasonPickerOpen((current) => !current)}
                  style={({ pressed }) => [styles.seasonPicker, pressed && styles.pressed]}
                >
                  <Text style={styles.seasonPickerText}>{mobileSeasonLabel(selectedSeason)}</Text>
                  <View style={[styles.seasonPickerChevron, seasonPickerOpen && styles.seasonPickerChevronOpen]}>
                    <ChevronRightIcon size={20} color={text} />
                  </View>
                </Pressable>
                {seasonPickerOpen ? (
                  <View style={styles.seasonPickerMenu}>
                    {seasonNumbers.map((season) => (
                      <Pressable
                        key={season}
                        accessibilityRole="menuitem"
                        accessibilityState={{ selected: season === selectedSeason }}
                        onPress={() => {
                          setSelectedSeason(season);
                          setSeasonPickerOpen(false);
                        }}
                        style={({ pressed }) => [styles.seasonPickerOption, season === selectedSeason && styles.seasonPickerOptionActive, pressed && styles.pressed]}
                      >
                        <Text style={[styles.seasonPickerOptionText, season === selectedSeason && styles.seasonPickerOptionTextActive]}>{mobileSeasonLabel(season)}</Text>
                        <Text style={styles.seasonPickerOptionMeta}>
                          {episodes.filter((ep) => ep.season === season).length} {episodes.filter((ep) => ep.season === season).length === 1 ? 'episode' : 'episodes'}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </View>
              <View style={styles.episodeList}>
                {seasonEpisodes.map((ep) => {
                  const episodeDetails = item.episodes?.find((candidate) =>
                    candidate.season === ep.season && candidate.number === ep.episode,
                  );
                  return (
                    <EpisodeRow
                      key={`${ep.season}-${ep.episode}`}
                      baseUrl={baseUrl}
                      cacheBust={cacheBust}
                      episode={ep}
                      fallbackSources={[
                        item.backdrop,
                        ...(item.backdropCandidates || []),
                        item.poster,
                        ...(item.posterCandidates || []),
                      ]}
                      progress={progressStateFor(progress, ep.filePath, ep.localMetadata?.durationSeconds)}
                      airDate={episodeDetails?.airDate}
                      summary={episodeDetails?.summary}
                      onPress={() => onPlay(episodePlayTarget(item, ep, progress))}
                    />
                  );
                })}
              </View>
            </View>
          ) : item.type !== 'movie' ? (
            <View style={styles.episodesSection}>
              <Text style={styles.episodesHeading}>Episodes</Text>
              <View style={styles.emptyEpisodesCard}>
                <Text style={styles.emptyEpisodesTitle}>No episodes found</Text>
                <Text style={styles.emptyEpisodesCopy}>Refresh the server library or rescan this show folder.</Text>
              </View>
            </View>
          ) : null}
        </View>
      </Animated.ScrollView>
      <Animated.View
        pointerEvents="box-none"
        style={[styles.detailTopBar, { paddingTop: insets.top + 8 }]}
      >
        <Animated.View
          pointerEvents="none"
          style={[
            styles.detailTopBarBackground,
            {
              backgroundColor: isLightTheme ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)',
              borderBottomWidth: 0,
              opacity: stickyHeaderOpacity,
            },
          ]}
        />
        <SubpageBackButton onPress={onClose} />
        <Animated.Text
          numberOfLines={1}
          style={[
            styles.detailStickyTitle,
            {
              color: isLightTheme ? '#000000' : '#ffffff',
              opacity: stickyHeaderOpacity,
              transform: [{ translateY: stickyHeaderTitleTranslateY }],
            },
          ]}
        >
          {item.title}
        </Animated.Text>
        <View style={styles.detailTopActions}>
          <Pressable
            accessibilityLabel={isWatchlisted ? `Remove ${item.title} from My List` : `Add ${item.title} to My List`}
            accessibilityRole="button"
            accessibilityState={{ selected: isWatchlisted }}
            onPress={() => void onToggleList('watchlist', !isWatchlisted)}
            style={({ pressed }) => [styles.detailTopAction, pressed && styles.pressed]}
          >
            <Ionicons name={isWatchlisted ? 'bookmark' : 'bookmark-outline'} size={22} color={isWatchlisted ? accent : '#ffffff'} />
          </Pressable>
          {mobileLanClient.supportsArtworkEditing && <Pressable
            style={({ pressed }) => [styles.detailTopAction, isRefreshingArtwork && styles.disabledButton, pressed && styles.pressed]}
            onPress={(event) => {
              captureMobileFocus(event);
              onRefreshArtwork(item);
            }}
            disabled={isRefreshingArtwork}
            accessibilityRole="button"
            accessibilityLabel={`Refresh poster for ${item.title}`}
          >
            {isRefreshingArtwork ? (
              <ActivityIndicator color={accent} size="small" />
            ) : (
              <RefreshIcon size={20} color="#ffffff" />
            )}
          </Pressable>}
        </View>
      </Animated.View>
      {!isTablet ? (
        <BottomNav activeProfile={activeProfile} activeKind={activeKind} setActiveKind={onOpenKind} />
      ) : null}
    </Animated.View>
  );
}

function DetailInfo({
  baseUrl,
  cacheBust,
  item,
}: {
  baseUrl: string;
  cacheBust?: string;
  item: MediaItem;
}) {
  const { styles } = useMobileTheme();
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const cast = (item.cast || []).filter((actor) => actor.name.trim()).slice(0, 8);

  return (
    <View style={styles.detailsPanel}>
      {item.summary ? (
        <View style={styles.detailSummaryBlock}>
          <Text selectable numberOfLines={summaryExpanded ? undefined : 4} style={styles.detailSummary}>
            {item.summary}
          </Text>
          <Pressable
            onPress={() => setSummaryExpanded((current) => !current)}
            accessibilityRole="button"
            accessibilityLabel={summaryExpanded ? 'Show less summary' : 'Show more summary'}
            style={({ pressed }) => [styles.detailSummaryToggle, pressed && styles.pressed]}
          >
            <Text style={styles.detailSummaryToggleText}>
              {summaryExpanded ? 'Show less' : 'Show more'}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {cast.length > 0 ? (
        <View style={styles.castSection}>
          <Text style={styles.detailsSectionHeading}>Cast</Text>
          <FlatList
            contentContainerStyle={styles.castRailContent}
            data={cast}
            horizontal
            keyExtractor={(actor) => `${actor.name}-${actor.character || ''}`}
            renderItem={({ item: actor }) => {
              const actorSources = imageUrlsFor(baseUrl, [actor.image], cacheBust);
              return (
                <View style={styles.castCard}>
                  <View style={styles.castAvatar}>
                    <FallbackImage
                      sources={actorSources}
                      style={styles.castAvatarImage}
                      resizeMode="cover"
                      altFallback={(
                        <View style={styles.castAvatarFallback}>
                          <Text style={styles.castAvatarFallbackText}>{actor.name.charAt(0).toUpperCase()}</Text>
                        </View>
                      )}
                    />
                  </View>
                  <Text numberOfLines={1} style={styles.castName}>{actor.name}</Text>
                  {actor.character ? <Text numberOfLines={1} style={styles.castCharacter}>{actor.character}</Text> : null}
                </View>
              );
            }}
            showsHorizontalScrollIndicator={false}
          />
        </View>
      ) : null}

      {!item.summary && cast.length === 0 ? (
        <Text style={styles.detailsEmpty}>No additional details available.</Text>
      ) : null}
    </View>
  );
}

export function PosterCandidateSheet({
  applyingCandidateId,
  accessibilityHidden,
  baseUrl,
  candidates,
  error,
  item,
  onApply,
  onClose,
}: {
  applyingCandidateId: string;
  accessibilityHidden?: boolean;
  baseUrl: string;
  candidates: OfficialMetadataCandidate[];
  error: string;
  item: MediaItem | null;
  onApply: (candidate: OfficialMetadataCandidate, candidateKey: string) => void;
  onClose: () => void;
}) {
  const { colors: { accent, accentForeground, text }, styles } = useMobileTheme();
  const insets = useSafeAreaInsets();
  const entrance = useEntrance(22);
  useMobileModalLayer({
    open: Boolean(item),
    priority: 40,
    onBack: () => {
      if (!applyingCandidateId) onClose();
    },
  });
  if (!item) return null;

  return (
    <View
      accessibilityViewIsModal
      accessibilityElementsHidden={accessibilityHidden}
      importantForAccessibility={accessibilityHidden ? 'no-hide-descendants' : 'yes'}
      style={styles.posterSheetOverlay}
    >
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={() => {
          if (!applyingCandidateId) onClose();
        }}
        accessibilityLabel="Close poster choices"
      />
      <Animated.View style={[styles.posterSheet, { paddingBottom: Math.max(insets.bottom, 14) + 8 }, entrance]}>
        <View style={styles.posterSheetHandle} />
        <View style={styles.posterSheetHeader}>
          <View style={styles.posterSheetTitleBlock}>
            <Text style={styles.posterSheetEyebrow}>Refresh poster</Text>
            <Text numberOfLines={2} style={styles.posterSheetTitle}>{item.title}</Text>
          </View>
          <Pressable
            style={({ pressed }) => [styles.posterSheetClose, pressed && styles.pressed]}
            onPress={onClose}
            disabled={Boolean(applyingCandidateId)}
            accessibilityRole="button"
            accessibilityLabel="Close poster choices"
          >
            <CloseIcon size={20} color={text} />
          </Pressable>
        </View>
        {error ? <Text selectable style={styles.posterSheetError}>{error}</Text> : null}
        <ScrollView
          contentContainerStyle={styles.posterCandidateList}
          showsVerticalScrollIndicator={false}
        >
          {candidates.length === 0 ? (
            <View style={styles.posterCandidateEmpty}>
              <Text style={styles.posterCandidateEmptyTitle}>No matches found</Text>
              <Text style={styles.posterCandidateEmptyCopy}>The server metadata search did not return poster choices for this title.</Text>
            </View>
          ) : candidates.map((candidate, index) => {
            const candidateKey = metadataCandidateKey(candidate, index);
            const posterSources = imageUrlsFor(baseUrl, [
              candidate.thumbnail,
              candidate.posterCandidates?.[0],
              candidate.cover,
              candidate.backdropCandidates?.[0],
            ]);
            const title = candidate.title?.trim() || item.title;
            const episodeTotal = candidate.episodeCount || candidate.episodePreview?.length || 0;
            const metaLine = [
              candidate.genres?.slice(0, 2).join(' • ') || null,
              episodeTotal ? `${episodeTotal} episodes` : null,
            ].filter(Boolean).join('   ·   ');
            const isApplying = applyingCandidateId === candidateKey;
            return (
              <View key={candidateKey} style={styles.posterCandidateCard}>
                <View style={styles.posterCandidateTop}>
                  <FallbackImage
                    sources={posterSources}
                    style={styles.posterCandidateImage}
                    resizeMode="cover"
                    altFallback={(
                      <View style={[styles.posterCandidateImage, styles.posterFallback]}>
                        <PlayMark size={26} color={accent} />
                      </View>
                    )}
                  />
                  <View style={styles.posterCandidateInfo}>
                    <Text numberOfLines={2} style={styles.posterCandidateTitle}>{title}</Text>
                    <View style={styles.posterCandidateDetails}>
                      {candidate.year ? <Text style={styles.posterCandidateYear}>{candidate.year}</Text> : null}
                      {candidate.source ? <Text style={styles.posterCandidateSource}>{candidate.source}</Text> : null}
                      {candidate.rating ? (
                        <View style={styles.posterCandidateRating}>
                          <StarIcon size={12} color="#f5c451" />
                          <Text style={styles.posterCandidateRatingText}>{candidate.rating.toFixed(1)}</Text>
                        </View>
                      ) : null}
                    </View>
                    <Text numberOfLines={3} style={styles.posterCandidateSummary}>
                      {candidate.summary?.trim() || 'No summary provided.'}
                    </Text>
                  </View>
                </View>
                <View style={styles.posterCandidateFooter}>
                  {metaLine ? (
                    <Text numberOfLines={1} style={styles.posterCandidateGenres}>{metaLine}</Text>
                  ) : <View style={styles.posterCandidateFooterSpacer} />}
                  <Pressable
                    style={({ pressed }) => [
                      styles.posterCandidateApply,
                      (isApplying || Boolean(applyingCandidateId)) && styles.disabledButton,
                      pressed && styles.pressed,
                    ]}
                    onPress={() => onApply(candidate, candidateKey)}
                    disabled={Boolean(applyingCandidateId)}
                    accessibilityRole="button"
                    accessibilityLabel={`Apply poster from ${candidate.source || 'metadata result'} for ${title}`}
                  >
                    {isApplying ? <ActivityIndicator color={accentForeground} size="small" /> : <CheckIcon size={17} color={accentForeground} />}
                    <Text style={styles.posterCandidateApplyText}>{isApplying ? 'Applying' : 'Apply'}</Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

function EpisodeRow({
  baseUrl,
  cacheBust,
  episode,
  fallbackSources,
  progress,
  airDate,
  summary,
  onPress,
}: {
  baseUrl: string;
  cacheBust?: string;
  episode: EpisodeFile;
  fallbackSources: Array<string | undefined>;
  progress: ReturnType<typeof progressStateFor>;
  airDate?: string;
  summary?: string;
  onPress: () => void;
}) {
  const { styles } = useMobileTheme();
  const thumbnailSources = useMemo(
    () => imageUrlsFor(baseUrl, [
      episode.thumbnail,
      episode.still,
      ...fallbackSources,
    ], cacheBust),
    [baseUrl, cacheBust, episode.still, episode.thumbnail, fallbackSources],
  );
  const progressWidth = `${Math.max(6, Math.round(progress.fraction * 100))}%` as `${number}%`;
  const episodeAirDate = formatMobileEpisodeAirDate(airDate);
  return (
    <PressableScale
      onPress={onPress}
      scaleTo={0.98}
      style={[styles.episodeRow, progress.watched && styles.episodeRowWatched]}
      accessibilityRole="button"
      accessibilityLabel={`Play ${episodeCode(episode.season, episode.episode)} ${episode.title || ''}${episodeAirDate ? `, released ${episodeAirDate}` : ''}`}
    >
      <View style={styles.episodeThumb}>
        <FallbackImage
          sources={thumbnailSources}
          style={styles.episodeThumbImage}
          altFallback={(
            <View style={styles.episodeThumbFallback}>
              <Text style={styles.episodeIndexText}>{episode.episode}</Text>
            </View>
          )}
        />
        <View style={styles.episodePlayBadge}>
          <PlayIcon size={16} color="#ffffff" />
        </View>
        {progress.watched ? (
          <View style={styles.watchedBadge}>
            <CheckIcon size={12} color="#06130a" />
          </View>
        ) : null}
        {progress.inProgress ? (
          <View style={styles.episodeProgressTrack}>
            <View style={[styles.episodeProgressFill, { width: progressWidth }]} />
          </View>
        ) : null}
      </View>
      <View style={styles.episodeInfo}>
        <Text numberOfLines={2} style={[styles.episodeTitle, progress.watched && styles.episodeTitleWatched]}>
          {episode.episode}. {episode.title || `Episode ${episode.episode}`}
        </Text>
        <View style={styles.episodeMetaRow}>
          <Text style={styles.episodeMeta}>
            {[episodeAirDate, episode.localMetadata?.durationSeconds ? formatDuration(episode.localMetadata.durationSeconds) : 'Runtime unknown'].filter(Boolean).join('  •  ')}
          </Text>
          {progress.inProgress ? <Text style={styles.resumePill}>Resume</Text> : null}
        </View>
        {summary ? <Text numberOfLines={1} ellipsizeMode="tail" style={styles.episodeSummary}>{summary}</Text> : null}
      </View>
    </PressableScale>
  );
}
