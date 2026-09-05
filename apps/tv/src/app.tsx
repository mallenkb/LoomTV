import * as SecureStore from 'expo-secure-store';
import { StatusBar } from 'expo-status-bar';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Zeroconf from 'react-native-zeroconf';
import {
  ActivityIndicator,
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  CanonicalTvClient,
  isTvAuthorizationFailure,
  type Credential,
  type LibraryItem,
  type Profile,
  type ProfileListEntry,
} from './canonical-client.ts';
import { discoveredTvServer, type DiscoveredTvServer } from './discovery.ts';
import {
  backDestination,
  preferredFocusableId,
  type TvLibraryScreen,
  type TvScreen,
} from './focus-model.ts';
import {
  probeTvCertificate,
  secureServerOrigin,
  startTvSecureTransport,
  stopTvSecureTransport,
} from './secure-transport.ts';

const CONNECTION_KEY = 'loomtv-tv-connection-v1';
const DEVICE_ID_KEY = 'loomtv-tv-device-id-v1';
const colors = { background: '#090a0c', panel: '#17191d', panelFocus: '#2b2f36', text: '#f7f7f8', muted: '#a8adb8', accent: '#fc9c03', danger: '#ff6b6b' };

type SavedConnection = { baseUrl: string; certificateFingerprint: string; credential: Credential };
type PendingTrust = { baseUrl: string; certificateFingerprint: string; name: string };
type ActivePlayback = {
  item: LibraryItem;
  url: string;
  action: 'direct' | 'hls';
  sessionId?: string;
  expiresAt?: number;
  startSeconds: number;
  durationSeconds?: number;
};
type PlaybackTrack = { id: string; kind: string; language?: string; title?: string };

function isSavedConnection(value: unknown): value is SavedConnection {
  if (!value || typeof value !== 'object') return false;
  const saved = value as Partial<SavedConnection>;
  return typeof saved.baseUrl === 'string'
    && typeof saved.certificateFingerprint === 'string'
    && Boolean(saved.certificateFingerprint)
    && Boolean(saved.credential)
    && typeof saved.credential?.id === 'string'
    && typeof saved.credential?.secret === 'string';
}

function TvButton({ label, onPress, disabled = false, preferred = false, selected = false, onFocus }: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  preferred?: boolean;
  selected?: boolean;
  onFocus?: () => void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      hasTVPreferredFocus={preferred && !disabled}
      onFocus={() => { setFocused(true); onFocus?.(); }}
      onBlur={() => setFocused(false)}
      onPress={onPress}
      style={[styles.button, focused && styles.focused, disabled && styles.disabled]}
    >
      <Text style={styles.buttonText}>{selected ? `✓ ${label}` : label}</Text>
    </Pressable>
  );
}

function TvCard({ item, width, preferred, onFocus, onPress }: {
  item: LibraryItem;
  width: `${number}%`;
  preferred: boolean;
  onFocus: () => void;
  onPress: () => void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityLabel={`${item.title}${item.available ? '' : ', unavailable'}`}
      accessibilityRole="button"
      disabled={!item.available}
      hasTVPreferredFocus={preferred && item.available}
      onBlur={() => setFocused(false)}
      onFocus={() => { setFocused(true); onFocus(); }}
      onPress={onPress}
      style={[styles.card, { width }, focused && styles.focused, !item.available && styles.disabled]}
    >
      <Text numberOfLines={2} style={styles.cardTitle}>{item.title}</Text>
      <Text style={styles.muted}>{item.year || item.kind}</Text>
    </Pressable>
  );
}

function Player({ playback, client, onClose, onError }: {
  playback: ActivePlayback;
  client: CanonicalTvClient;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [expiresAt, setExpiresAt] = useState(playback.expiresAt || 0);
  const sourceOffset = playback.action === 'hls' ? playback.startSeconds : 0;
  const player = useVideoPlayer(playback.url, (instance) => {
    instance.currentTime = playback.action === 'hls' ? 0 : playback.startSeconds;
    instance.timeUpdateEventInterval = 5;
    instance.play();
  });

  useEffect(() => {
    let lastSaved = playback.startSeconds - sourceOffset;
    const update = player.addListener('timeUpdate', ({ currentTime }) => {
      if (Math.abs(currentTime - lastSaved) < 15) return;
      lastSaved = currentTime;
      const duration = playback.durationSeconds || (Number.isFinite(player.duration) ? sourceOffset + player.duration : 0);
      void client.saveProgress(playback.item.id, sourceOffset + currentTime, duration, false).catch(() => undefined);
    });
    const ended = player.addListener('playToEnd', () => {
      const duration = playback.durationSeconds || sourceOffset + player.currentTime;
      void client.saveProgress(playback.item.id, duration, duration, true).catch(() => undefined);
    });
    return () => { update.remove(); ended.remove(); };
  }, [client, playback.item.id, playback.startSeconds, playback.durationSeconds, sourceOffset, player]);

  useEffect(() => {
    if (!expiresAt || !playback.sessionId) return undefined;
    let cancelled = false;
    const delay = Math.max(1_000, expiresAt - Date.now() - 60_000);
    const timer = setTimeout(() => {
      void client.renewPlayback(playback.item.id, playback.action, playback.sessionId as string).then(async (renewed) => {
        if (cancelled) return;
        const position = player.currentTime;
        const wasPlaying = player.playing;
        await player.replaceAsync(renewed.url);
        if (cancelled) return;
        player.currentTime = position;
        if (wasPlaying) player.play();
        else player.pause();
        setExpiresAt(renewed.expiresAt);
      }).catch((error) => { if (!cancelled) onError(error instanceof Error ? error.message : 'Playback authorization expired.'); });
    }, delay);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [client, expiresAt, onError, playback.action, playback.item.id, playback.sessionId, player]);

  return (
    <View style={styles.playerScreen}>
      <VideoView accessibilityLabel={`Playing ${playback.item.title}`} contentFit="contain" nativeControls player={player} style={styles.video} />
      <View style={styles.playerClose}><TvButton label="Back to details" onPress={() => {
        const duration = playback.durationSeconds || (Number.isFinite(player.duration) ? sourceOffset + player.duration : 0);
        void client.saveProgress(playback.item.id, sourceOffset + player.currentTime, duration, false).catch(() => undefined);
        onClose();
      }} preferred /></View>
    </View>
  );
}

function TvApp() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const columns = width >= 1700 ? 6 : width >= 1200 ? 5 : 4;
  const [screen, setScreen] = useState<TvScreen>('connect');
  const [baseUrl, setBaseUrl] = useState('');
  const [client, setClient] = useState<CanonicalTvClient | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [listEntries, setListEntries] = useState<ProfileListEntry[]>([]);
  const [detail, setDetail] = useState<LibraryItem | null>(null);
  const [detailOrigin, setDetailOrigin] = useState<TvLibraryScreen>('library');
  const [parentSeries, setParentSeries] = useState<LibraryItem | null>(null);
  const [playback, setPlayback] = useState<ActivePlayback | null>(null);
  const [playbackTracks, setPlaybackTracks] = useState<PlaybackTrack[]>([]);
  const [audioTrackId, setAudioTrackId] = useState<string | null | undefined>(undefined);
  const [subtitleTrackId, setSubtitleTrackId] = useState<string | null | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [discoveredServers, setDiscoveredServers] = useState<DiscoveredTvServer[]>([]);
  const [pendingTrust, setPendingTrust] = useState<PendingTrust | null>(null);
  const [invitationId, setInvitationId] = useState('');
  const [invitationSecret, setInvitationSecret] = useState('');
  const [savedConnectionRetry, setSavedConnectionRetry] = useState<SavedConnection | null>(null);
  const [lastFocusedByScreen, setLastFocusedByScreen] = useState<Record<TvLibraryScreen, string>>({
    library: '',
    'my-list': '',
  });
  const [lastFocusedEpisodeId, setLastFocusedEpisodeId] = useState('');
  const pairingGeneration = useRef(0);

  const myListIds = useMemo(() => new Set(
    listEntries
      .filter((entry) => entry.kind === 'watchlist' || entry.kind === 'favorite')
      .map((entry) => entry.mediaId),
  ), [listEntries]);

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const source = screen === 'my-list' ? items.filter((item) => myListIds.has(item.id)) : items;
    return source.filter((item) => item.kind !== 'episode' && (!normalized || item.title.toLowerCase().includes(normalized)));
  }, [items, myListIds, query, screen]);

  const restoreSavedConnection = useCallback(async (saved: SavedConnection) => {
    setBusy(true);
    setError('');
    try {
      const proxyBaseUrl = await startTvSecureTransport(saved.baseUrl, saved.certificateFingerprint);
      const restored = new CanonicalTvClient(saved.baseUrl, saved.credential, proxyBaseUrl);
      await restored.discover();
      const restoredProfiles = await restored.profiles();
      setBaseUrl(saved.baseUrl);
      setClient(restored);
      setProfiles(restoredProfiles.profiles);
      setSavedConnectionRetry(null);
      setScreen('profiles');
    } catch (nextError) {
      await stopTvSecureTransport().catch(() => undefined);
      setBaseUrl(saved.baseUrl);
      setClient(null);
      setProfiles([]);
      setScreen('connect');
      if (isTvAuthorizationFailure(nextError)) {
        await SecureStore.deleteItemAsync(CONNECTION_KEY);
        setSavedConnectionRetry(null);
        setError('This television is no longer authorized. Pair it with the server again.');
      } else {
        setSavedConnectionRetry(saved);
        setError('The saved LoomTV server is unavailable. Check the server and network, then retry.');
      }
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void SecureStore.getItemAsync(CONNECTION_KEY).then(async (raw) => {
      if (!raw) return;
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
      if (!isSavedConnection(parsed)) {
        await SecureStore.deleteItemAsync(CONNECTION_KEY);
        setError('The saved connection could not be read. Pair this television again.');
        return;
      }
      await restoreSavedConnection(parsed);
    }).catch(() => {
      setError('LoomTV could not read the saved connection. Reference: TV-STORAGE.');
    }).finally(() => setBusy(false));
  }, [restoreSavedConnection]);

  useEffect(() => {
    if (screen !== 'connect') return undefined;
    const zeroconf = new Zeroconf();
    const finish = setTimeout(() => { try { zeroconf.stop(); } catch { /* Discovery is optional. */ } }, 6_000);
    zeroconf.on('resolved', (service) => {
      const discovered = discoveredTvServer(service);
      if (!discovered) return;
      setDiscoveredServers((current) => [discovered, ...current.filter((entry) => entry.id !== discovered.id)]);
    });
    zeroconf.on('error', () => undefined);
    try { zeroconf.scan('loomtv', 'tcp', 'local.'); } catch { /* Manual entry remains available. */ }
    return () => {
      clearTimeout(finish);
      try { zeroconf.stop(); } catch { /* Already stopped. */ }
      zeroconf.removeAllListeners();
      zeroconf.removeDeviceListeners();
    };
  }, [screen]);

  const returnFromDetail = useCallback(() => {
    setPlaybackTracks([]);
    setAudioTrackId(undefined);
    setSubtitleTrackId(undefined);
    if (parentSeries) {
      setDetail(parentSeries);
      setParentSeries(null);
      return;
    }
    setDetail(null);
    setScreen(detailOrigin);
  }, [detailOrigin, parentSeries]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen === 'detail') {
        returnFromDetail();
        return true;
      }
      const destination = backDestination(screen, detailOrigin);
      if (destination === 'exit') return false;
      if (screen === 'approval') pairingGeneration.current += 1;
      if (screen === 'player' && playback && client) {
        void client.stopPlayback(playback.item.id, playback.sessionId).catch(() => undefined);
        setPlayback(null);
      }
      if (screen === 'trust') setPendingTrust(null);
      setScreen(destination);
      return true;
    });
    return () => subscription.remove();
  }, [client, detailOrigin, playback, returnFromDetail, screen]);

  async function inspectManualServer() {
    setBusy(true);
    setError('');
    try {
      const origin = secureServerOrigin(baseUrl);
      const certificateFingerprint = await probeTvCertificate(origin);
      setBaseUrl(origin);
      setPendingTrust({ baseUrl: origin, certificateFingerprint, name: origin });
      setScreen('trust');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not inspect the server certificate.');
    } finally { setBusy(false); }
  }

  async function requestApproval() {
    if (!pendingTrust) return;
    const generation = pairingGeneration.current + 1;
    pairingGeneration.current = generation;
    setBusy(true);
    setError('');
    try {
      const proxyBaseUrl = await startTvSecureTransport(pendingTrust.baseUrl, pendingTrust.certificateFingerprint);
      const next = new CanonicalTvClient(pendingTrust.baseUrl, null, proxyBaseUrl);
      await next.discover();
      if (invitationId.trim() || invitationSecret.trim()) {
        if (!invitationId.trim() || !invitationSecret.trim()) throw new Error('Enter both invitation fields.');
        let deviceId = await SecureStore.getItemAsync(DEVICE_ID_KEY);
        if (!deviceId) {
          deviceId = `tv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
          await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId);
        }
        const accepted = await next.acceptInvitation(invitationId.trim(), invitationSecret.trim(), deviceId);
        const credential = { ...accepted.credential, scheme: 'LoomInvitation' as const };
        next.setCredential(credential);
        await SecureStore.setItemAsync(CONNECTION_KEY, JSON.stringify({
          baseUrl: next.baseUrl,
          certificateFingerprint: pendingTrust.certificateFingerprint,
          credential,
        } satisfies SavedConnection));
        setProfiles((await next.profiles()).profiles);
        setClient(next);
        setSavedConnectionRetry(null);
        setInvitationId('');
        setInvitationSecret('');
        setScreen('profiles');
        return;
      }
      const request = await next.requestPairing('LoomTV living-room client');
      setClient(next);
      setScreen('approval');
      setBusy(false);
      const deadline = Math.min(request.expiresAt, Date.now() + 5 * 60 * 1000);
      while (Date.now() < deadline && pairingGeneration.current === generation) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (pairingGeneration.current !== generation) return;
        const status = await next.pairingStatus(request.requestId, request.requestSecret);
        if (status.status === 'pending') continue;
        if (status.status !== 'approved' || !status.credential) throw new Error(status.status === 'denied' ? 'The server denied this television.' : 'Pairing expired. Try again.');
        next.setCredential(status.credential);
        await SecureStore.setItemAsync(CONNECTION_KEY, JSON.stringify({
          baseUrl: next.baseUrl,
          certificateFingerprint: pendingTrust.certificateFingerprint,
          credential: status.credential,
        } satisfies SavedConnection));
        setProfiles((await next.profiles()).profiles);
        setSavedConnectionRetry(null);
        setScreen('profiles');
        return;
      }
      throw new Error('Pairing expired. Try again.');
    } catch (nextError) {
      setScreen('connect');
      setError(nextError instanceof Error ? nextError.message : 'Could not connect to the server.');
    } finally { setBusy(false); }
  }

  async function chooseProfile(profile: Profile) {
    if (!client) return;
    setBusy(true);
    setError('');
    try {
      await client.selectProfile(profile.id, pin || undefined);
      setPin('');
      const [library, lists] = await Promise.all([client.library(), client.listEntries()]);
      setItems(library.items);
      setListEntries(lists.entries);
      setQuery('');
      setDetail(null);
      setParentSeries(null);
      setDetailOrigin('library');
      setScreen('library');
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : 'Could not select this profile.'); }
    finally { setBusy(false); }
  }

  function openBrowseScreen(destination: TvLibraryScreen) {
    setQuery('');
    setDetail(null);
    setParentSeries(null);
    setPlaybackTracks([]);
    setAudioTrackId(undefined);
    setSubtitleTrackId(undefined);
    setScreen(destination);
  }

  function openDetail(item: LibraryItem, origin: TvLibraryScreen) {
    setDetail(item);
    setDetailOrigin(origin);
    setParentSeries(null);
    setPlaybackTracks([]);
    setAudioTrackId(undefined);
    setSubtitleTrackId(undefined);
    setScreen('detail');
  }

  async function toggleMyList(item: LibraryItem) {
    if (!client) return;
    setError('');
    try {
      if (!myListIds.has(item.id)) {
        const result = await client.setListEntry(item.id, 'watchlist', true);
        setListEntries(result.entries);
        return;
      }
      let result = await client.setListEntry(item.id, 'watchlist', false);
      if (result.entries.some((entry) => entry.mediaId === item.id && entry.kind === 'favorite')) {
        result = await client.setListEntry(item.id, 'favorite', false);
      }
      setListEntries(result.entries);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not update My List.');
    }
  }

  async function play(item: LibraryItem) {
    if (!client) return;
    setBusy(true);
    setError('');
    try {
      const progress = await client.progress(item.id).catch(() => ({ progress: null }));
      const record = progress.progress;
      const startSeconds = Math.max(0, Number(record?.positionSeconds ?? record?.position ?? 0));
      const plan = await client.planPlayback(item.id, startSeconds, { audioTrackId, subtitleTrackId });
      if (plan.directUrl) {
        setPlayback({
          item, url: client.absoluteUrl(plan.directUrl), action: 'direct',
          sessionId: plan.directSessionId, expiresAt: plan.directExpiresAt, startSeconds, durationSeconds: plan.probe.durationSeconds,
        });
        setScreen('player');
        return;
      }
      if (!plan.transcodeUrl) throw new Error('This video cannot be played by this television.');
      const started = await client.startTranscode(plan.transcodeUrl);
      setPlayback({
        item, url: started.playlistUrl, action: 'hls', sessionId: started.sessionId,
        expiresAt: started.expiresAt, startSeconds, durationSeconds: plan.probe.durationSeconds,
      });
      setScreen('player');
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : 'Playback could not start.'); }
    finally { setBusy(false); }
  }

  async function loadPlaybackOptions(item: LibraryItem) {
    if (!client) return;
    setBusy(true);
    setError('');
    try {
      const plan = await client.planPlayback(item.id, 0);
      setPlaybackTracks(plan.probe.tracks || []);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : 'Playback options are unavailable.'); }
    finally { setBusy(false); }
  }

  async function signOut() {
    pairingGeneration.current += 1;
    await client?.signOut().catch(() => undefined);
    await SecureStore.deleteItemAsync(CONNECTION_KEY);
    await stopTvSecureTransport();
    setClient(null); setProfiles([]); setItems([]); setListEntries([]); setDetail(null); setParentSeries(null);
    setPlayback(null); setSavedConnectionRetry(null); setError(''); setScreen('connect');
  }

  const browseScreen: TvLibraryScreen = screen === 'my-list' ? 'my-list' : 'library';
  const preferredBrowseItemId = preferredFocusableId(
    visibleItems.map((item) => ({ id: item.id, disabled: !item.available })),
    lastFocusedByScreen[browseScreen],
  );
  const detailEpisodes = detail?.kind === 'series' ? detail.episodes || [] : [];
  const preferredEpisodeId = preferredFocusableId(
    detailEpisodes.map((episode) => ({ id: episode.id, disabled: !episode.available })),
    lastFocusedEpisodeId,
  );
  const hasFocusableEpisodes = detailEpisodes.some((episode) => episode.available);
  const showBrowseNavigation = Boolean(client && (screen === 'library' || screen === 'my-list' || screen === 'detail'));

  if (screen === 'player' && playback && client) return <Player
    key={playback.sessionId || playback.url}
    client={client}
    onClose={() => {
      void client.stopPlayback(playback.item.id, playback.sessionId).catch(() => undefined);
      setPlayback(null);
      setScreen('detail');
    }}
    onError={setError}
    playback={playback}
  />;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[styles.page, { paddingTop: Math.max(48, insets.top), paddingBottom: Math.max(48, insets.bottom), paddingLeft: Math.max(64, insets.left), paddingRight: Math.max(64, insets.right) }]}
    >
      <StatusBar style="light" hidden />
      <View style={styles.header}>
        <View><Text style={styles.brand}>LoomTV</Text><Text style={styles.eyebrow}>YOUR VIDEO LIBRARY</Text></View>
        <View style={styles.headerActions}>
          {showBrowseNavigation ? <>
            <TvButton
              label="Library"
              onPress={() => openBrowseScreen('library')}
              selected={screen === 'library' || (screen === 'detail' && detailOrigin === 'library')}
            />
            <TvButton
              label="My List"
              onPress={() => openBrowseScreen('my-list')}
              selected={screen === 'my-list' || (screen === 'detail' && detailOrigin === 'my-list')}
            />
          </> : null}
          {screen !== 'connect' && screen !== 'approval' ? <TvButton label="Sign out" onPress={() => void signOut()} /> : null}
        </View>
      </View>
      {busy ? <View style={styles.center}><ActivityIndicator color={colors.accent} size="large" /><Text style={styles.muted}>Working…</Text></View> : null}
      {!busy && screen === 'connect' ? <View style={styles.connectPanel}>
        <Text style={styles.title}>Connect this television</Text>
        <Text style={styles.copy}>Choose a discovered server or enter its secure address. LoomTV will show the certificate identity before sending a pairing request.</Text>
        {discoveredServers.length ? <View style={styles.row}>{discoveredServers.map((server, index) => <TvButton
          key={server.id}
          label={server.name}
          onPress={() => {
            setBaseUrl(server.baseUrl);
            setPendingTrust({ baseUrl: server.baseUrl, certificateFingerprint: server.certificateFingerprint, name: server.name });
            setScreen('trust');
          }}
          preferred={index === 0 && !savedConnectionRetry}
        />)}</View> : <Text style={styles.muted}>Searching the local network…</Text>}
        {savedConnectionRetry ? <TvButton
          label="Retry saved server"
          onPress={() => void restoreSavedConnection(savedConnectionRetry)}
          preferred
        /> : null}
        <TextInput accessibilityLabel="LoomTV server address" autoCapitalize="none" autoCorrect={false} onChangeText={setBaseUrl} placeholder="https://192.168.1.25:3848" placeholderTextColor={colors.muted} style={styles.input} value={baseUrl} />
        <Text style={styles.muted}>Invitation, if this server was shared with you</Text>
        <View style={styles.row}>
          <TextInput accessibilityLabel="Invitation ID" autoCapitalize="none" autoCorrect={false} onChangeText={setInvitationId} placeholder="Invitation ID" placeholderTextColor={colors.muted} style={[styles.input, styles.halfInput]} value={invitationId} />
          <TextInput accessibilityLabel="Invitation secret" autoCapitalize="none" autoCorrect={false} onChangeText={setInvitationSecret} placeholder="Invitation secret" placeholderTextColor={colors.muted} secureTextEntry style={[styles.input, styles.halfInput]} value={invitationSecret} />
        </View>
        <TvButton disabled={!baseUrl.trim()} label="Inspect server identity" onPress={() => void inspectManualServer()} preferred={!discoveredServers.length && !savedConnectionRetry} />
      </View> : null}
      {!busy && screen === 'trust' && pendingTrust ? <View style={styles.connectPanel}>
        <Text style={styles.title}>Trust this server?</Text>
        <Text style={styles.copy}>{pendingTrust.name}{'\n'}{pendingTrust.baseUrl}</Text>
        <Text selectable style={styles.fingerprint}>{pendingTrust.certificateFingerprint.match(/.{1,4}/g)?.join(' ')}</Text>
        <Text style={styles.copy}>Compare this fingerprint with LoomTV administration before approving the television.</Text>
        <View style={styles.row}><TvButton label="Trust and request approval" onPress={() => void requestApproval()} preferred /><TvButton label="Cancel" onPress={() => { setPendingTrust(null); setScreen('connect'); }} /></View>
      </View> : null}
      {!busy && screen === 'approval' ? <View style={styles.center}><Text style={styles.title}>Approve this television</Text><Text style={styles.copy}>Open LoomTV administration on another device and approve “LoomTV living-room client.”</Text></View> : null}
      {!busy && screen === 'profiles' ? <View style={styles.section}>
        <Text style={styles.title}>Who is watching?</Text>
        <TextInput accessibilityLabel="Profile PIN, when required" keyboardType="number-pad" maxLength={12} onChangeText={setPin} placeholder="Profile PIN if required" placeholderTextColor={colors.muted} secureTextEntry style={styles.input} value={pin} />
        <View style={styles.row}>{profiles.map((profile, index) => <TvButton key={profile.id} label={profile.name} onPress={() => void chooseProfile(profile)} preferred={index === 0} />)}</View>
      </View> : null}
      {!busy && (screen === 'library' || screen === 'my-list') ? <View style={styles.section}>
        <Text style={styles.title}>{screen === 'my-list' ? 'My List' : 'Library'}</Text>
        <TextInput
          accessibilityLabel={screen === 'my-list' ? 'Search My List' : 'Search library'}
          onChangeText={setQuery}
          placeholder={screen === 'my-list' ? 'Search My List' : 'Search movies and series'}
          placeholderTextColor={colors.muted}
          style={styles.input}
          value={query}
        />
        {visibleItems.length ? <View style={styles.grid}>{visibleItems.map((item) => <TvCard
          item={item}
          key={item.id}
          onFocus={() => setLastFocusedByScreen((current) => ({ ...current, [browseScreen]: item.id }))}
          onPress={() => openDetail(item, browseScreen)}
          preferred={item.id === preferredBrowseItemId}
          width={`${(100 / columns) - 2}%`}
        />)}</View> : <Text style={styles.copy}>{screen === 'my-list' && !query.trim()
          ? 'My List is empty. Add a movie or series from its details.'
          : 'No matching video is available.'}</Text>}
      </View> : null}
      {!busy && screen === 'detail' && detail ? <View style={styles.detail}>
        <Text style={styles.title}>{detail.title}</Text>
        <Text style={styles.muted}>{[detail.year, detail.kind].filter(Boolean).join(' • ')}</Text>
        <Text selectable style={styles.copy}>{detail.summary || 'No description is available.'}</Text>
        {detail.kind === 'series' ? <View style={styles.row}>{(detail.episodes || []).map((episode) => <TvButton
          disabled={!episode.available}
          key={episode.id}
          label={`${episode.seasonNumber || 1}×${episode.episodeNumber || 0} ${episode.title}`}
          onFocus={() => setLastFocusedEpisodeId(episode.id)}
          onPress={() => {
            setLastFocusedEpisodeId(episode.id);
            setParentSeries(detail);
            setDetail(episode);
            setPlaybackTracks([]);
          }}
          preferred={episode.id === preferredEpisodeId}
        />)}</View> : null}
        {detail.kind !== 'series' && playbackTracks.length ? <View style={styles.trackPanel}>
          <Text style={styles.muted}>Audio</Text>
          <View style={styles.row}>{playbackTracks.filter((track) => track.kind === 'audio').map((track) => <TvButton key={track.id} label={track.title || track.language || track.id} onPress={() => setAudioTrackId(track.id)} selected={audioTrackId === track.id} />)}</View>
          <Text style={styles.muted}>Subtitles</Text>
          <View style={styles.row}><TvButton label="Off" onPress={() => setSubtitleTrackId(null)} selected={subtitleTrackId === null} />{playbackTracks.filter((track) => track.kind === 'subtitle').map((track) => <TvButton key={track.id} label={track.title || track.language || track.id} onPress={() => setSubtitleTrackId(track.id)} selected={subtitleTrackId === track.id} />)}</View>
        </View> : null}
        <View style={styles.row}>
          {detail.kind !== 'series' ? <TvButton label="Play" onPress={() => void play(detail)} preferred /> : null}
          {detail.kind !== 'series' ? <TvButton label="Playback options" onPress={() => void loadPlaybackOptions(detail)} /> : null}
          <TvButton
            label={myListIds.has((parentSeries || detail).id) ? 'Remove from My List' : 'Add to My List'}
            onPress={() => void toggleMyList(parentSeries || detail)}
            selected={myListIds.has((parentSeries || detail).id)}
          />
          <TvButton
            label={parentSeries ? `Back to ${parentSeries.title}` : `Back to ${detailOrigin === 'my-list' ? 'My List' : 'Library'}`}
            onPress={returnFromDetail}
            preferred={detail.kind === 'series' && !hasFocusableEpisodes}
          />
        </View>
      </View> : null}
      {error ? <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" selectable style={styles.error}>{error}</Text> : null}
    </ScrollView>
  );
}

export default function App() { return <SafeAreaProvider><TvApp /></SafeAreaProvider>; }

const styles = StyleSheet.create({
  page: { flexGrow: 1, backgroundColor: colors.background, gap: 36 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 14 },
  brand: { color: colors.text, fontSize: 42, fontWeight: '800' },
  eyebrow: { color: colors.accent, fontSize: 13, fontWeight: '800', letterSpacing: 3 },
  title: { color: colors.text, fontSize: 40, fontWeight: '700' },
  copy: { color: colors.muted, fontSize: 24, lineHeight: 34, maxWidth: 980 },
  muted: { color: colors.muted, fontSize: 18 },
  error: { color: colors.danger, fontSize: 22, lineHeight: 30 },
  fingerprint: { color: colors.text, fontSize: 20, lineHeight: 30, fontFamily: 'monospace' },
  center: { flex: 1, minHeight: 420, alignItems: 'center', justifyContent: 'center', gap: 22 },
  connectPanel: { alignSelf: 'center', width: '70%', maxWidth: 1000, gap: 26, paddingTop: 70 },
  section: { gap: 28 },
  detail: { gap: 24, maxWidth: 1100 },
  trackPanel: { gap: 16, paddingVertical: 12 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 22 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 20 },
  input: { minHeight: 72, borderWidth: 3, borderColor: '#3b3f48', borderRadius: 12, color: colors.text, backgroundColor: colors.panel, fontSize: 24, paddingHorizontal: 24 },
  halfInput: { flex: 1, minWidth: 360 },
  button: { minHeight: 66, minWidth: 180, justifyContent: 'center', alignItems: 'center', borderWidth: 3, borderColor: '#3b3f48', borderRadius: 12, backgroundColor: colors.panel, paddingHorizontal: 28 },
  buttonText: { color: colors.text, fontSize: 22, fontWeight: '700' },
  focused: { borderColor: colors.accent, backgroundColor: colors.panelFocus, transform: [{ scale: 1.04 }] },
  disabled: { opacity: 0.42 },
  card: { minHeight: 190, justifyContent: 'flex-end', gap: 12, backgroundColor: colors.panel, borderWidth: 4, borderColor: 'transparent', borderRadius: 16, padding: 22 },
  cardTitle: { color: colors.text, fontSize: 25, lineHeight: 31, fontWeight: '700' },
  playerScreen: { flex: 1, backgroundColor: '#000' },
  video: { flex: 1 },
  playerClose: { position: 'absolute', top: 36, left: 48 },
});
