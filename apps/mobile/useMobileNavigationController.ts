import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  type FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
} from 'react-native';

import { useMobileModalLayer } from './mobileModalStack';
import type {
  LibraryKind,
  MediaItem,
  MobileLibraryFilter,
  MobileSearchScope,
  SettingsSection,
} from './mobileDomain';

export function useMobileNavigationController({ cancelActiveRequests }: { cancelActiveRequests: () => void }) {
  const [activeKind, setActiveKind] = useState<LibraryKind>('home');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchScope, setSearchScope] = useState<MobileSearchScope>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const [libraryFilter, setLibraryFilter] = useState<MobileLibraryFilter>('all');
  const [detailItem, setDetailItem] = useState<MediaItem | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [homeHeaderPinned, setHomeHeaderPinned] = useState(false);
  const homeHeaderPinnedRef = useRef(false);
  const homeHeaderAnimation = useRef(new Animated.Value(0)).current;
  const libraryListRef = useRef<FlatList<MediaItem> | null>(null);
  const settingsScrollRef = useRef<ScrollView | null>(null);
  const scrollOffsetsRef = useRef<Record<LibraryKind, number>>({
    home: 0,
    anime: 0,
    tv: 0,
    movies: 0,
    others: 0,
    settings: 0,
  });
  const lastDetailByKindRef = useRef(new Map<LibraryKind, MediaItem>());

  const updateHomeHeaderPinned = useCallback((pinned: boolean) => {
    if (homeHeaderPinnedRef.current === pinned) return;
    homeHeaderPinnedRef.current = pinned;
    setHomeHeaderPinned(pinned);
  }, []);

  const navigateToKind = useCallback((kind: LibraryKind) => {
    cancelActiveRequests();
    if (kind === activeKind) {
      lastDetailByKindRef.current.delete(kind);
      setDetailItem(null);
      setSearchOpen(false);
      setQuery('');
      setSearchScope('all');
      setFilterOpen(false);
      setLibraryFilter('all');
      if (kind === 'settings') setSettingsSection(null);
      scrollOffsetsRef.current[kind] = 0;
      if (kind === 'settings') settingsScrollRef.current?.scrollTo({ y: 0, animated: true });
      else libraryListRef.current?.scrollToOffset({ offset: 0, animated: true });
      updateHomeHeaderPinned(false);
      return;
    }
    if (detailItem) lastDetailByKindRef.current.set(activeKind, detailItem);
    setDetailItem(kind === 'settings' ? null : lastDetailByKindRef.current.get(kind) || null);
    setSearchOpen(false);
    setQuery('');
    setSearchScope('all');
    setFilterOpen(false);
    setLibraryFilter('all');
    setActiveKind(kind);
    updateHomeHeaderPinned(false);
  }, [activeKind, cancelActiveRequests, detailItem, updateHomeHeaderPinned]);

  const rememberMainScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offset = event.nativeEvent.contentOffset.y;
    if (query) return;
    scrollOffsetsRef.current[activeKind] = offset;
    if (activeKind === 'settings') {
      updateHomeHeaderPinned(false);
      return;
    }
    updateHomeHeaderPinned(offset > (homeHeaderPinnedRef.current ? 84 : 112));
  }, [activeKind, query, updateHomeHeaderPinned]);

  useMobileModalLayer({ open: filterOpen, priority: 10, onBack: () => setFilterOpen(false) });
  useMobileModalLayer({
    open: activeKind === 'settings' && settingsSection !== null,
    priority: 12,
    onBack: () => setSettingsSection(null),
  });

  useEffect(() => {
    const animation = homeHeaderPinned
      ? Animated.spring(homeHeaderAnimation, {
          damping: 22,
          isInteraction: false,
          mass: 0.72,
          stiffness: 250,
          toValue: 1,
          useNativeDriver: true,
        })
      : Animated.timing(homeHeaderAnimation, {
          duration: 150,
          easing: Easing.out(Easing.cubic),
          isInteraction: false,
          toValue: 0,
          useNativeDriver: true,
        });
    animation.start();
    return () => animation.stop();
  }, [homeHeaderAnimation, homeHeaderPinned]);

  useEffect(() => {
    if (activeKind !== 'settings' && !query) return;
    updateHomeHeaderPinned(false);
  }, [activeKind, query, updateHomeHeaderPinned]);

  useEffect(() => {
    if (!searchOpen) return;
    updateHomeHeaderPinned(false);
    const frame = requestAnimationFrame(() => libraryListRef.current?.scrollToOffset({ offset: 0, animated: false }));
    return () => cancelAnimationFrame(frame);
  }, [searchOpen, updateHomeHeaderPinned]);

  useEffect(() => {
    if (query) return;
    const offset = scrollOffsetsRef.current[activeKind] || 0;
    const frame = requestAnimationFrame(() => {
      if (activeKind === 'settings') settingsScrollRef.current?.scrollTo({ y: offset, animated: false });
      else libraryListRef.current?.scrollToOffset({ offset, animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeKind, query]);

  return {
    activeKind,
    detailItem,
    filterOpen,
    homeHeaderPinned,
    homeHeaderOpacity: homeHeaderAnimation.interpolate({ inputRange: [0, 0.35, 1], outputRange: [0, 0.45, 1], extrapolate: 'clamp' }),
    homeHeaderScale: homeHeaderAnimation.interpolate({ inputRange: [0, 1], outputRange: [0.985, 1], extrapolate: 'clamp' }),
    homeHeaderTranslateY: homeHeaderAnimation.interpolate({ inputRange: [0, 1], outputRange: [-14, 0], extrapolate: 'clamp' }),
    lastDetailByKindRef,
    libraryFilter,
    libraryListRef,
    navigateToKind,
    query,
    rememberMainScroll,
    searchOpen,
    searchScope,
    settingsSection,
    setActiveKind,
    setDetailItem,
    setFilterOpen,
    setLibraryFilter,
    setQuery,
    setSearchOpen,
    setSearchScope,
    setSettingsSection,
    settingsScrollRef,
    updateHomeHeaderPinned,
  };
}
