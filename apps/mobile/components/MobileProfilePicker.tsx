import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import { LoomLogo } from './LoomIcons';
import { type MobileProfilePickerMode } from '../useMobileConnectionSessionController';
import { useMobileModalLayer } from '../mobileModalStack';
import { useMobileTheme } from '../mobileThemeContext';
import type { MobileProfile } from '../mobileDomain';
import { SubpageBackButton, mobileProfileAvatarUri } from './SharedUi';

export function MobileProfilePicker({
  activeProfile,
  error,
  mode,
  onSelect,
  onClose,
  pin,
  pinTarget,
  profiles,
  setPin,
  setPinTarget,
}: {
  activeProfile: MobileProfile | null;
  error: string;
  mode: MobileProfilePickerMode;
  onSelect: (profile: MobileProfile, pin?: string) => void | Promise<void>;
  onClose?: () => void;
  pin: string;
  pinTarget: MobileProfile | null;
  profiles: MobileProfile[];
  setPin: (value: string) => void;
  setPinTarget: (profile: MobileProfile | null) => void;
}) {
  const { colors } = useMobileTheme();
  const insets = useSafeAreaInsets();
  const isDismissible = mode === 'voluntary';
  const [pendingProfileId, setPendingProfileId] = useState<string | null>(null);
  const chooseProfile = (profile: MobileProfile, selectedPin?: string) => {
    if (pendingProfileId) return;
    if (profile.hasPin && selectedPin === undefined) {
      setPinTarget(profile);
      setPin('');
      return;
    }
    setPendingProfileId(profile.id);
    void Promise.resolve()
      .then(() => onSelect(profile, selectedPin))
      .finally(() => setPendingProfileId(null));
  };
  useMobileModalLayer({
    priority: 70,
    onBack: () => {
      if (pinTarget) {
        setPinTarget(null);
        setPin('');
        return;
      }
      if (isDismissible) onClose?.();
    },
  });
  if (pinTarget) {
    const append = (digit: string) => {
      const next = `${pin}${digit}`.slice(0, 4);
      setPin(next);
      if (next.length === 4) chooseProfile(pinTarget, next);
    };
    return (
      <View
        accessibilityViewIsModal
        importantForAccessibility="yes"
        style={[mobileProfileStyles.screen, { backgroundColor: colors.bg }]}
      >
        <SubpageBackButton
          accessibilityLabel="Back to profiles"
          onPress={() => {
            setPinTarget(null);
            setPin('');
          }}
          style={[mobileProfileStyles.pinBackButton, { top: insets.top + 12 }]}
        />
        <Text style={[mobileProfileStyles.title, { color: colors.text }]}>Enter PIN</Text>
        <Text style={{ color: colors.muted }}>Unlock {pinTarget.name}</Text>
        <View
          accessible
          accessibilityLabel={`${pin.length} of 4 PIN digits entered`}
          accessibilityLiveRegion="polite"
          style={mobileProfileStyles.dots}
        >
          {[0, 1, 2, 3].map((index) => <View key={index} style={[mobileProfileStyles.dot, { backgroundColor: index < pin.length ? colors.text : colors.border }]} />)}
        </View>
        <View style={mobileProfileStyles.pinGrid}>
          {'123456789'.split('').map((digit) => (
            <Pressable accessibilityLabel={`Digit ${digit}`} accessibilityRole="button" disabled={Boolean(pendingProfileId)} key={digit} onPress={() => append(digit)} style={[mobileProfileStyles.pinKey, { backgroundColor: colors.panel }]}>
              <Text style={[mobileProfileStyles.pinText, { color: colors.text }]}>{digit}</Text>
            </Pressable>
          ))}
          <View style={mobileProfileStyles.pinKey} />
          <Pressable accessibilityLabel="Digit 0" accessibilityRole="button" disabled={Boolean(pendingProfileId)} onPress={() => append('0')} style={[mobileProfileStyles.pinKey, { backgroundColor: colors.panel }]}><Text style={[mobileProfileStyles.pinText, { color: colors.text }]}>0</Text></Pressable>
          <Pressable accessibilityLabel="Delete last digit" accessibilityRole="button" disabled={Boolean(pendingProfileId)} onPress={() => setPin(pin.slice(0, -1))} style={mobileProfileStyles.pinKey}><Text style={{ color: colors.muted }}>Delete</Text></Pressable>
        </View>
        {pendingProfileId ? <ActivityIndicator color={colors.accent} size="small" /> : null}
        {error ? <Text accessibilityLiveRegion="assertive" role="alert" style={mobileProfileStyles.error}>{error}</Text> : null}
      </View>
    );
  }

  return (
    <ScrollView
      accessibilityViewIsModal
      importantForAccessibility="yes"
      contentContainerStyle={[mobileProfileStyles.screen, { backgroundColor: colors.bg }]}
    >
      <LoomLogo width={132} height={44} wordColor={colors.text} />
      <Text style={[mobileProfileStyles.title, { color: colors.text }]}>Who’s watching?</Text>
      {isDismissible ? null : (
        <Text accessibilityRole="text" style={{ color: colors.muted, textAlign: 'center' }}>
          Choose a profile to continue.
        </Text>
      )}
      {pendingProfileId ? <Text accessibilityRole="text" style={{ color: colors.muted, textAlign: 'center' }}>Opening profile…</Text> : null}
      <View style={mobileProfileStyles.grid}>
        {profiles.map((profile) => (
          <Pressable
            disabled={Boolean(pendingProfileId)}
            hitSlop={14}
            key={profile.id}
            accessibilityRole="button"
            accessibilityLabel={`${profile.name}${profile.hasPin ? ', PIN protected' : ''}`}
            accessibilityState={{
              busy: pendingProfileId === profile.id,
              disabled: Boolean(pendingProfileId),
              selected: profile.id === activeProfile?.id,
            }}
            onPress={() => chooseProfile(profile)}
            style={({ pressed }) => [mobileProfileStyles.card, pressed && mobileProfileStyles.cardPressed]}
          >
            <View style={[
              mobileProfileStyles.avatar,
              { backgroundColor: colors.panel, borderColor: colors.border },
            ]}>
              <ExpoImage
        cachePolicy="memory-disk" source={{ uri: mobileProfileAvatarUri(profile) }} style={mobileProfileStyles.avatarImage} contentFit="cover" />
            </View>
            <Text numberOfLines={1} style={[mobileProfileStyles.name, { color: colors.text }]}>{profile.name}</Text>
            {pendingProfileId === profile.id ? <ActivityIndicator color={colors.accent} size="small" /> : profile.id === activeProfile?.id ? (
              <Text style={[mobileProfileStyles.activeProfileLabel, { color: colors.accent }]}>Active</Text>
            ) : null}
            {profile.hasPin ? <Text style={{ color: colors.muted, fontSize: 11 }}>PIN protected</Text> : null}
          </Pressable>
        ))}
      </View>
      {error ? <Text style={mobileProfileStyles.error}>{error}</Text> : null}
    </ScrollView>
  );
}

const mobileProfileStyles = StyleSheet.create({
  screen: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 56, gap: 12 },
  title: { fontSize: 30, fontWeight: '800', marginTop: 24 },
  grid: { width: '100%', maxWidth: 560, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 22, marginTop: 28 },
  card: { width: 116, alignItems: 'center', gap: 8 },
  cardPressed: { opacity: 0.72, transform: [{ scale: 0.96 }] },
  avatar: { width: 104, height: 104, borderRadius: 52, borderWidth: 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarImage: { width: '100%', height: '100%', borderRadius: 52 },
  avatarText: { fontSize: 42, fontWeight: '800' },
  name: { maxWidth: 116, fontSize: 15, fontWeight: '700' },
  activeProfileLabel: { fontSize: 12, fontWeight: '700', marginTop: -5 },
  pinBackButton: { left: 16, position: 'absolute' },
  dots: { flexDirection: 'row', gap: 14, marginVertical: 20 },
  dot: { width: 14, height: 14, borderRadius: 7 },
  pinGrid: { width: 276, flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  pinKey: { width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center' },
  pinText: { fontSize: 28, fontWeight: '700' },
  error: { color: '#f87171', textAlign: 'center', marginTop: 8 },
  settingsActions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  settingsAction: { borderWidth: 1, borderRadius: 10, minHeight: 42, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  autoSignInRow: { width: '100%', maxWidth: 340, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, paddingHorizontal: 12 },
});
