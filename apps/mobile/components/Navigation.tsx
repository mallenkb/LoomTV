import { useEffect, useRef, type ReactElement } from 'react';
import { Animated, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { Image as ExpoImage } from 'expo-image';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect as SvgRect, Stop } from 'react-native-svg';
import {
  CloseIcon,
  FilterIcon,
  LoomLogo,
  PlayIcon,
  SearchIcon,
  UserCircleIcon,
  UserCircleSolidIcon,
  navIcons,
  type IconProps,
} from './LoomIcons';
import { formatClock } from '../mobilePlaybackPresentation';
import { captureMobileFocus, useMobileModalLayer } from '../mobileModalStack';
import { useMobileTheme } from '../mobileThemeContext';
import type {
  LibraryKind,
  MobileProfile,
  MobileLibraryFilter,
  MobileSearchScope,
  PlayTarget,
} from '../mobileDomain';
import { FallbackImage, imageUrlsFor, mobileProfileAvatarUri } from './SharedUi';

export function Header({
  activeKind,
  filterOpen,
  hasActiveFilters,
  query,
  searchScope,
  searchOpen,
  setFilterOpen,
  setQuery,
  setSearchScope,
  setSearchOpen,
}: {
  activeKind: LibraryKind;
  filterOpen: boolean;
  hasActiveFilters: boolean;
  query: string;
  searchScope: MobileSearchScope;
  searchOpen: boolean;
  setFilterOpen: (value: boolean) => void;
  setQuery: (value: string) => void;
  setSearchScope: (value: MobileSearchScope) => void;
  setSearchOpen: (value: boolean) => void;
}) {
  const { colors: { accent, faint, muted, text }, styles } = useMobileTheme();
  const canFilter = activeKind !== 'settings';
  const searchTriggerRef = useRef<View | null>(null);
  useMobileModalLayer({
    open: searchOpen,
    priority: 11,
    onBack: () => {
      setSearchOpen(false);
      setQuery('');
      setSearchScope('all');
    },
    restoreFocusRef: searchTriggerRef,
  });
  if (searchOpen) {
    return (
      <View style={styles.searchHeader}>
        <View style={styles.searchHeaderRow}>
          <View style={styles.searchBox}>
            <SearchIcon size={19} color={muted} />
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              onChangeText={setQuery}
              placeholder="Search titles, genres, or years"
              placeholderTextColor={faint}
              returnKeyType="search"
              style={styles.searchInput}
              value={query}
            />
            {query ? (
              <Pressable
                hitSlop={8}
                onPress={() => setQuery('')}
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                style={({ pressed }) => [styles.searchClearButton, pressed && styles.pressed]}
              >
                <CloseIcon size={16} color={muted} />
              </Pressable>
            ) : null}
          </View>
          <Pressable
            onPress={() => {
              setSearchOpen(false);
              setQuery('');
            }}
            accessibilityRole="button"
            accessibilityLabel="Cancel search"
            style={({ pressed }) => [styles.searchCancelButton, pressed && styles.pressed]}
          >
            <Text style={styles.searchCancelText}>Cancel</Text>
          </Pressable>
        </View>
        <SearchScopeFilters activeScope={searchScope} onChange={setSearchScope} />
      </View>
    );
  }

  return (
    <View style={styles.header}>
      <View style={styles.topBarRow}>
        <View style={styles.brandRow}>
          <LoomLogo width={86} height={24} accent={accent} wordColor={text} />
        </View>
        <View style={styles.headerActions}>
          {canFilter ? (
            <Pressable
              onPress={(event) => {
                captureMobileFocus(event);
                setFilterOpen(!filterOpen);
              }}
              accessibilityRole="button"
              accessibilityLabel={filterOpen ? 'Close filters' : 'Open filters'}
              accessibilityState={{ expanded: filterOpen }}
              style={({ pressed }) => [styles.topBarIconButton, filterOpen && styles.filterButtonActive, pressed && styles.pressed]}
            >
              <FilterIcon size={20} color={filterOpen || hasActiveFilters ? accent : text} />
            </Pressable>
          ) : null}
          <Pressable
            ref={searchTriggerRef}
            onPress={() => setSearchOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Search"
            style={({ pressed }) => [styles.topBarIconButton, pressed && styles.pressed]}
          >
            <SearchIcon size={23} color={text} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function SearchScopeFilters({
  activeScope,
  onChange,
}: {
  activeScope: MobileSearchScope;
  onChange: (value: MobileSearchScope) => void;
}) {
  const { styles } = useMobileTheme();
  const options: { id: MobileSearchScope; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'genre:drama', label: 'Drama' },
    { id: 'genre:animation', label: 'Animation' },
    { id: 'genre:action-adventure', label: 'Action & Adventure' },
    { id: 'genre:comedy', label: 'Comedy' },
  ];
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.filterChipRow}
    >
      {options.map((option) => {
        const selected = activeScope === option.id;
        return (
            <Pressable
              key={option.id}
              onPress={() => onChange(option.id)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={({ pressed }) => [styles.filterChip, selected && styles.filterChipSelected, pressed && styles.pressed]}
            >
              <Text style={[styles.filterChipText, selected && styles.filterChipTextSelected]}>{option.label}</Text>
            </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function LibraryFilters({
  activeFilter,
  onChange,
}: {
  activeFilter: MobileLibraryFilter;
  onChange: (value: MobileLibraryFilter) => void;
}) {
  const { styles } = useMobileTheme();
  const options: { id: MobileLibraryFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'in-progress', label: 'In Progress' },
    { id: 'unwatched', label: 'Unwatched' },
    { id: 'watched', label: 'Watched' },
  ];

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.filterChipRow}
    >
      {options.map((option) => {
        const selected = activeFilter === option.id;
        return (
          <Pressable
            key={option.id}
            onPress={() => onChange(option.id)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={({ pressed }) => [styles.filterChip, selected && styles.filterChipSelected, pressed && styles.pressed]}
          >
            <Text style={[styles.filterChipText, selected && styles.filterChipTextSelected]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function BottomNavItem({
  item,
  isActive,
  onPress,
}: {
  item: { id: string; label: string; Icon: (props: IconProps) => ReactElement; ActiveIcon?: (props: IconProps) => ReactElement; avatarUri?: string };
  isActive: boolean;
  onPress: () => void;
}) {
  const { colors: { accent, faint }, styles } = useMobileTheme();
  const active = useRef(new Animated.Value(isActive ? 1 : 0)).current;
  useEffect(() => {
    Animated.spring(active, {
      toValue: isActive ? 1 : 0,
      useNativeDriver: true,
      speed: 18,
      bounciness: 9,
    }).start();
  }, [active, isActive]);
  const iconScale = active.interpolate({ inputRange: [0, 1], outputRange: [1, 1] });
  const Icon = isActive ? (item.ActiveIcon || item.Icon) : item.Icon;
  return (
    <Pressable
      style={styles.bottomNavButton}
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: isActive }}
      accessibilityLabel={item.label}
    >
      <Animated.View style={[styles.bottomNavIconWrap, { transform: [{ scale: iconScale }] }]}>
        {item.avatarUri ? (
          <ExpoImage
        cachePolicy="memory-disk"
            source={{ uri: item.avatarUri }}
            style={styles.bottomNavAvatar}
            contentFit="cover"
          />
        ) : (
          <Icon size={24} color={isActive ? accent : faint} />
        )}
      </Animated.View>
      <Text style={[styles.bottomNavLabel, isActive && styles.bottomNavLabelActive]} numberOfLines={1}>{item.label}</Text>
    </Pressable>
  );
}

// The bottom nav mirrors the primary library destinations and settings.
export function BottomNav({
  activeProfile,
  activeKind,
  setActiveKind,
}: {
  activeProfile?: MobileProfile | null;
  activeKind: LibraryKind;
  setActiveKind: (kind: LibraryKind) => void;
}) {
  const { colors: { themeLabel }, styles } = useMobileTheme();
  const insets = useSafeAreaInsets();
  const isAndroid = Platform.OS === 'android';
  const androidGlassBackground = themeLabel === 'Light'
    ? 'rgba(255,255,255,0.42)'
    : 'rgba(10,10,10,0.88)';
  const bottomItems: { id: string; label: string; Icon: (props: IconProps) => ReactElement; ActiveIcon?: (props: IconProps) => ReactElement; avatarUri?: string; isActive: boolean; onPress: () => void }[] = [
    { id: 'home', label: 'Home', Icon: navIcons.home, ActiveIcon: navIcons.homeActive, isActive: activeKind === 'home', onPress: () => setActiveKind('home') },
    { id: 'anime', label: 'Anime', Icon: navIcons.anime, ActiveIcon: navIcons.animeActive, isActive: activeKind === 'anime', onPress: () => setActiveKind('anime') },
    { id: 'tv', label: 'TV Shows', Icon: navIcons.tv, ActiveIcon: navIcons.tvActive, isActive: activeKind === 'tv', onPress: () => setActiveKind('tv') },
    { id: 'movies', label: 'Movies', Icon: navIcons.movies, ActiveIcon: navIcons.moviesActive, isActive: activeKind === 'movies', onPress: () => setActiveKind('movies') },
    { id: 'settings', label: 'Settings', Icon: UserCircleIcon, ActiveIcon: UserCircleSolidIcon, avatarUri: activeProfile ? mobileProfileAvatarUri(activeProfile) : undefined, isActive: activeKind === 'settings', onPress: () => setActiveKind('settings') },
  ];
  const items = (
    <View style={styles.bottomNavRow}>
      {bottomItems.map((item) => (
        <BottomNavItem
          key={item.id}
          item={item}
          isActive={item.isActive}
          onPress={item.onPress}
        />
      ))}
    </View>
  );

  return (
    <BlurView
      intensity={isAndroid ? 54 : 36}
      tint={themeLabel === 'Light' ? 'light' : 'dark'}
      blurReductionFactor={isAndroid ? 1.5 : 4}
      experimentalBlurMethod={isAndroid ? 'dimezisBlurView' : 'none'}
      style={[
        styles.bottomNav,
        isAndroid && { backgroundColor: androidGlassBackground },
        { paddingBottom: Math.max(insets.bottom, 10) },
      ]}
    >
      {items}
    </BlurView>
  );
}

export function MiniPlayerStrip({
  accessibilityHidden,
  baseUrl,
  bottomOffset,
  cacheBust,
  onDismiss,
  onOpen,
  target,
}: {
  accessibilityHidden?: boolean;
  baseUrl: string;
  bottomOffset: number;
  cacheBust?: string;
  onDismiss: () => void;
  onOpen: () => void;
  target: PlayTarget | null;
}) {
  const { colors: { accentForeground }, styles } = useMobileTheme();
  if (!target) return null;
  const thumbnailSources = imageUrlsFor(baseUrl, [
    target.thumbnail,
    ...(target.thumbnailCandidates || []),
  ], cacheBust);
  const progressLabel = target.startPosition && target.startPosition > 0
    ? `Paused at ${formatClock(target.startPosition)}`
    : 'Paused';
  const content = (
    <>
      <View pointerEvents="none" style={styles.miniPlayerArtworkBackdrop}>
        <FallbackImage
          sources={thumbnailSources}
          style={styles.miniPlayerArtworkBackdropImage}
          resizeMode="cover"
          altFallback={<View style={styles.miniPlayerArtworkBackdropFallback} />}
        />
      </View>
      <Svg pointerEvents="none" style={styles.miniPlayerArtworkScrim} width="100%" height="100%">
        <Defs>
          <SvgLinearGradient id="miniPlayerScrim" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor="#171717" stopOpacity="0.98" />
            <Stop offset="0.58" stopColor="#171717" stopOpacity="0.88" />
            <Stop offset="1" stopColor="#171717" stopOpacity="0.64" />
          </SvgLinearGradient>
        </Defs>
        <SvgRect width="100%" height="100%" fill="url(#miniPlayerScrim)" />
      </Svg>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Resume ${target.title}`}
        onPress={(event) => {
          captureMobileFocus(event);
          onOpen();
        }}
        style={({ pressed }) => [styles.miniPlayerMain, pressed && styles.pressed]}
      >
        <View style={styles.miniPlayerThumb}>
          <FallbackImage
            sources={thumbnailSources}
            style={styles.miniPlayerThumbImage}
            resizeMode="cover"
            altFallback={(
              <View style={styles.miniPlayerThumbFallback}>
                <PlayIcon size={18} color={accentForeground} />
              </View>
            )}
          />
          <View style={styles.miniPlayerThumbBadge}>
            <PlayIcon size={13} color={accentForeground} />
          </View>
        </View>
        <View style={styles.miniPlayerText}>
          <Text numberOfLines={1} ellipsizeMode="tail" style={styles.miniPlayerTitle}>{target.title}</Text>
          <Text numberOfLines={1} ellipsizeMode="tail" style={styles.miniPlayerMeta}>
            {[target.subtitle, progressLabel].filter(Boolean).join(' · ')}
          </Text>
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss paused video"
        hitSlop={10}
        onPress={onDismiss}
        style={({ pressed }) => [styles.miniPlayerDismiss, pressed && styles.pressed]}
      >
        <CloseIcon size={20} color="#ffffff" />
      </Pressable>
    </>
  );

  return (
    <View
      accessibilityElementsHidden={accessibilityHidden}
      importantForAccessibility={accessibilityHidden ? 'no-hide-descendants' : 'auto'}
      style={[styles.miniPlayerWrap, { bottom: bottomOffset }]}
    >
      <BlurView
        experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : 'none'}
        intensity={46}
        tint="dark"
        style={[styles.miniPlayerStrip, styles.miniPlayerBlur]}
      >
        {content}
      </BlurView>
    </View>
  );
}
