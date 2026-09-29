import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { LoomLogo, RefreshIcon } from './LoomIcons';
import { automaticDiscoveredHost } from '../mobileDiscoveryExperience';
import { useMobileTheme } from '../mobileThemeContext';
import type { DiscoveredHost, SavedConnection } from '../mobileDomain';
import { PressableScale } from './SharedUi';

export function formatOfflineSnapshotTime(savedAt: number): string {
  try {
    return new Date(savedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return 'an earlier sync';
  }
}

export function PairingScreen({
  baseUrl,
  discoveredHosts,
  discoveryError,
  error,
  isDiscoveringHosts,
  isPairing,
  isRestoringConnection,
  isServerOffline,
  onRefreshDiscovery,
  savedConnection,
  setBaseUrl,
  setShareCode,
  onPair,
}: {
  baseUrl: string;
  discoveredHosts: DiscoveredHost[];
  discoveryError: string;
  error: string;
  isDiscoveringHosts: boolean;
  isPairing: boolean;
  isRestoringConnection: boolean;
  isServerOffline: boolean;
  onRefreshDiscovery: () => void;
  savedConnection: SavedConnection | null;
  setBaseUrl: (value: string) => void;
  setShareCode: (value: string) => void;
  onPair: (host?: DiscoveredHost) => Promise<void>;
}) {
  const { colors: { accent, accentForeground, faint, text }, styles } = useMobileTheme();
  const { fontScale } = useWindowDimensions();
  const usesLargeTextLayout = fontScale >= 1.5;
  const canPair = Boolean(baseUrl.trim());
  const [showManual, setShowManual] = useState(false);
  const [connectingHostDeviceId, setConnectingHostDeviceId] = useState<string | null>(null);
  const isConnecting = isPairing || isRestoringConnection;
  const automaticallyConnectingHost = isConnecting
    ? automaticDiscoveredHost(discoveredHosts, savedConnection)
    : null;
  const activeConnectingHostDeviceId = connectingHostDeviceId || automaticallyConnectingHost?.deviceId || null;
  const manualVisible = showManual;
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSubscription = Keyboard.addListener(showEvent, () => setIsKeyboardVisible(true));
    const hideSubscription = Keyboard.addListener(hideEvent, () => setIsKeyboardVisible(false));
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.pairingAvoider}>
      <ScrollView
        alwaysBounceVertical={false}
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios' && isKeyboardVisible}
        bounces={isKeyboardVisible}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          styles.pairingContent,
          usesLargeTextLayout && styles.pairingContentLargeText,
          isKeyboardVisible && styles.pairingContentKeyboard,
        ]}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
        scrollEnabled
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.pairingHero, usesLargeTextLayout && styles.pairingHeroLargeText]}>
          <LoomLogo width={118} height={33} accent={accent} wordColor={text} />
          <Text selectable style={[styles.pairingSubtitle, usesLargeTextLayout && styles.pairingSubtitleLargeText]}>
            {savedConnection ? savedConnection.hostDeviceName : 'Finding your LoomTV server…'}
          </Text>
        </View>
        <View style={styles.formBlock}>
          <View style={styles.discoveryBlock}>
            <View style={styles.discoveryHeading}>
                <Text style={styles.discoveryTitle}>Devices</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Refresh devices"
                  disabled={isDiscoveringHosts}
                  onPress={onRefreshDiscovery}
                  style={({ pressed }) => [styles.refreshDiscoveryButton, pressed && styles.pressed]}
                >
                  {isDiscoveringHosts ? <ActivityIndicator size="small" color={accent} /> : <RefreshIcon size={17} color={accent} />}
                </Pressable>
              </View>
            {discoveredHosts.map((host) => (
                <Pressable
                    key={host.deviceId}
                    disabled={isConnecting}
                    onPress={() => {
                      setShareCode('');
                      setBaseUrl(host.baseUrl);
                      setShowManual(false);
                      setConnectingHostDeviceId(host.deviceId);
                      void onPair(host).finally(() => {
                        setConnectingHostDeviceId((current) => current === host.deviceId ? null : current);
                      });
                    }}
                    style={({ pressed }) => [
                      styles.hostCard,
                      usesLargeTextLayout && styles.hostCardLargeText,
                      activeConnectingHostDeviceId === host.deviceId && isConnecting && styles.hostCardSelected,
                      pressed && styles.pressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`Connect to ${host.deviceName}`}
                    accessibilityHint="Uses the saved secure pairing when available; first-time devices may need administrator approval"
                    accessibilityState={{ busy: isConnecting, disabled: isConnecting }}
                  >
                    <View style={styles.hostCardCopy}>
                      <Text selectable style={styles.hostName}>{host.deviceName}</Text>
                    </View>
                    {activeConnectingHostDeviceId === host.deviceId && isConnecting
                      ? <ActivityIndicator size="small" color={accent} />
                      : <Text style={[styles.hostConnectLabel, usesLargeTextLayout && styles.hostConnectLabelLargeText]}>Ready</Text>}
                </Pressable>
            ))}
            {!discoveredHosts.length ? (
              <View style={styles.emptyDiscoveryCard}>
                {isDiscoveringHosts ? (
                  <ActivityIndicator size="small" color={accent} />
                ) : (
                  <>
                    <Text style={styles.emptyDiscoveryTitle}>Still looking…</Text>
                    <Text style={styles.emptyDiscoveryCopy}>
                      {discoveryError
                        ? discoveryError
                        : 'Start LoomTV on your desktop or NAS.'}
                    </Text>
                  </>
                )}
              </View>
            ) : null}
          </View>

          {manualVisible ? (
            <View style={styles.manualForm}>
              <View style={styles.inputField}>
                <Text nativeID="desktop-address-label" style={styles.inputLabel}>Server address</Text>
                <TextInput
                  accessibilityLabel="Server address"
                  accessibilityLabelledBy="desktop-address-label"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  onChangeText={setBaseUrl}
                  onSubmitEditing={canPair ? () => onPair() : undefined}
                  placeholder="https://192.168.1.25:3848"
                  placeholderTextColor={faint}
                  returnKeyType="next"
                  style={styles.input}
                  value={baseUrl}
                />
              </View>
            </View>
          ) : null}
          {error && !isServerOffline ? (
            <View style={styles.errorCard}>
              <Text
                accessibilityLiveRegion="assertive"
                accessibilityRole="alert"
                selectable
                style={styles.errorText}
              >
                {error}
              </Text>
            </View>
          ) : null}
          {manualVisible ? (
            <PressableScale
              scaleTo={0.97}
              style={[styles.primaryButton, (!canPair || isConnecting) && styles.disabledButton]}
              onPress={() => onPair()}
              disabled={!canPair || isConnecting}
              accessibilityRole="button"
              accessibilityLabel="Connect"
            >
              {isPairing ? <ActivityIndicator color={accentForeground} /> : <Text style={styles.primaryButtonText}>Connect</Text>}
            </PressableScale>
          ) : null}
          {isConnecting && !manualVisible ? (
            <Text selectable style={styles.manualHint}>
              Connecting…
            </Text>
          ) : isServerOffline && !manualVisible ? (
            <Text selectable style={styles.manualHint}>Reconnecting…</Text>
          ) : manualVisible ? (
            <Text selectable style={styles.manualHint}>
              {'Enter the HTTPS address shown by LoomTV, then approve this device on the server.'}
            </Text>
          ) : null}
          <Pressable
            accessibilityLabel={showManual ? 'Cancel manual connection' : 'Connect manually'}
            accessibilityRole="button"
            accessibilityState={{ disabled: isConnecting }}
            disabled={isConnecting}
            onPress={() => {
              if (showManual) {
                Keyboard.dismiss();
                setShowManual(false);
                return;
              }
              setShowManual(true);
            }}
            style={[styles.helpToggle, isConnecting && styles.disabledButton]}
          >
            <Text style={styles.helpToggleText}>{showManual ? 'Cancel' : 'Connect manually'}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export function OfflineNotice({
  isRetrying,
  message,
  onOpenSettings,
  onRetry,
  savedAt,
}: {
  isRetrying: boolean;
  message: string;
  onOpenSettings?: () => void;
  onRetry: () => void;
  savedAt?: number | null;
}) {
  const { colors: { accent, accentForeground, text }, styles } = useMobileTheme();
  const normalizedMessage = message.toLowerCase();
  const isGenericMessage = !message
    || normalizedMessage.includes('desktop app offline')
    || normalizedMessage.includes('could not reach the desktop')
    || normalizedMessage.includes('desktop is offline')
    || normalizedMessage.includes('sharing is off')
    || normalizedMessage.includes('reconnect automatically');
  const body = !isGenericMessage
    ? message
    : savedAt
      ? `Your saved library is available from ${formatOfflineSnapshotTime(savedAt)}. Downloaded titles can play now; other playback and changes resume when the server reconnects. LoomTV will keep trying automatically.`
      : 'The LoomTV server is unavailable. Check that it is running and reachable from this device. LoomTV will keep trying automatically.';

  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={styles.offlineNotice}
    >
      <View style={styles.offlineNoticeHeader}>
        <View style={styles.offlineNoticeIcon}>
          <Ionicons name="cloud-offline-outline" size={19} color={accent} />
        </View>
        <View style={styles.offlineNoticeCopy}>
          <Text style={styles.offlineNoticeTitle}>{savedAt ? 'Saved library' : 'Server unavailable'}</Text>
          <Text selectable style={styles.offlineNoticeBody}>{body}</Text>
        </View>
      </View>
      <View style={styles.offlineNoticeActions}>
        <Pressable
          accessibilityLabel={isRetrying ? 'Reconnecting to the server' : 'Reconnect to the server'}
          accessibilityRole="button"
          accessibilityState={{ busy: isRetrying, disabled: isRetrying }}
          disabled={isRetrying}
          onPress={onRetry}
          style={({ pressed }) => [
            styles.offlineNoticeAction,
            styles.offlineNoticeActionPrimary,
            pressed && styles.pressed,
          ]}
        >
          {isRetrying
            ? <ActivityIndicator color={accentForeground} size="small" />
            : <Ionicons name="refresh-outline" size={17} color={accentForeground} />}
          <Text style={[styles.offlineNoticeActionText, styles.offlineNoticeActionTextPrimary]}>
            {isRetrying ? 'Reconnecting…' : 'Reconnect'}
          </Text>
        </Pressable>
        {onOpenSettings ? (
          <Pressable
            accessibilityLabel="Open connection settings"
            accessibilityRole="button"
            onPress={onOpenSettings}
            style={({ pressed }) => [styles.offlineNoticeAction, pressed && styles.pressed]}
          >
            <Ionicons name="settings-outline" size={17} color={text} />
            <Text style={styles.offlineNoticeActionText}>Connection settings</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
