import { useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  Pressable,
  type PressableProps,
  Share,
  StyleSheet,
  Switch,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import {
  AutoThemeIcon,
  ChevronRightIcon,
  FolderIcon,
  MoonIcon,
  SunIcon,
  navIcons,
  type IconProps,
} from './LoomIcons';
import {
  clearMobileDiagnostics,
  exportMobileDiagnostics,
  listMobileDiagnostics,
  reportNonFatal,
  type MobileDiagnosticEvent,
} from '../mobileDiagnostics';
import { settingsContentMaxWidth } from '../mobileStyles';
import { captureMobileFocus } from '../mobileModalStack';
import { useMobileTheme } from '../mobileThemeContext';
import {
  MOBILE_THEME_COLOR_OPTIONS,
  type MobileThemeColor,
  type MobileThemeMode,
} from '../mobileTheme';
import type { Connection, MobileProfile, SettingsSection } from '../mobileDomain';
import { SubpageBackButton, mobileProfileAvatarUri } from './SharedUi';

type LibraryMetric = {
  key: string;
  label: string;
  value: number;
  Icon: (props: IconProps) => ReactElement;
};

const settingsPageHorizontalPadding = 32;
const settingsCardHorizontalPadding = 32;

// Coupang Play-style top category tabs shown under the logo on library pages.
// The bottom nav shrinks to Home / Search / Settings; these tabs carry the
// library kinds instead.
export const settingsSections: { id: SettingsSection; label: string; description: string }[] = [
  { id: 'library', label: 'Library', description: 'Refresh and review the connected server library.' },
  { id: 'network', label: 'Network', description: 'Pairing status and server connection details.' },
  { id: 'appearance', label: 'Appearance', description: 'Choose a light or dark theme for this device.' },
  { id: 'about', label: 'About', description: 'App information and third-party attribution.' },
];

const MOBILE_OPEN_SOURCE_NOTICES = [
  { name: 'Expo', license: 'MIT' },
  { name: '@expo/vector-icons', license: 'MIT' },
  { name: 'expo-blur', license: 'MIT' },
  { name: 'expo-brightness', license: 'MIT' },
  { name: 'expo-build-properties', license: 'MIT' },
  { name: 'expo-dev-client', license: 'MIT' },
  { name: 'expo-device', license: 'MIT' },
  { name: 'expo-file-system', license: 'MIT' },
  { name: 'expo-image', license: 'MIT' },
  { name: 'expo-screen-orientation', license: 'MIT' },
  { name: 'expo-secure-store', license: 'MIT' },
  { name: 'expo-sqlite', license: 'MIT' },
  { name: 'expo-status-bar', license: 'MIT' },
  { name: 'expo-video', license: 'MIT' },
  { name: 'React', license: 'MIT' },
  { name: 'React Native', license: 'MIT' },
  { name: 'react-native-safe-area-context', license: 'MIT' },
  { name: 'react-native-svg', license: 'MIT' },
  { name: 'react-native-zeroconf', license: 'MIT' },
  { name: 'Zod', license: 'MIT' },
] as const;

export function SettingsScreen({
  activeProfile,
  automaticProfileSignIn,
  activeSection,
  connection,
  counts,
  isTablet,
  isRefreshing,
  mobileThemeColor,
  mobileThemeMode,
  onLockProfile,
  onSetAutomaticSignIn,
  onSwitchProfile,
  onDisconnect,
  onRefresh,
  onSelectTheme,
  onSelectThemeColor,
  showDetailHeader,
  setActiveSection,
}: {
  activeProfile: MobileProfile | null;
  automaticProfileSignIn: boolean;
  activeSection: SettingsSection | null;
  connection: Connection;
  counts: Record<'anime' | 'tv' | 'movies' | 'others', number>;
  isTablet: boolean;
  isRefreshing: boolean;
  mobileThemeColor: MobileThemeColor;
  mobileThemeMode: MobileThemeMode;
  onLockProfile: () => void;
  onSetAutomaticSignIn: (enabled: boolean) => void;
  onSwitchProfile: () => void;
  onDisconnect: () => void;
  onRefresh: () => void;
  onSelectTheme: (mode: MobileThemeMode) => void;
  onSelectThemeColor: (color: MobileThemeColor) => void;
  showDetailHeader: boolean;
  setActiveSection: (section: SettingsSection | null) => void;
}) {
  const { colors: { accent, muted, panel }, styles } = useMobileTheme();
  const active = settingsSections.find((section) => section.id === activeSection);

  if (active) {
    return (
      <View style={styles.settingsPage}>
        {showDetailHeader ? (
          <SettingsDetailHeader label={active.label} onBack={() => setActiveSection(null)} />
        ) : null}
        <SettingsDetail
          section={active}
          connection={connection}
          counts={counts}
          isTablet={isTablet}
          isRefreshing={isRefreshing}
          mobileThemeColor={mobileThemeColor}
          mobileThemeMode={mobileThemeMode}
          onRefresh={onRefresh}
          onSelectTheme={onSelectTheme}
          onSelectThemeColor={onSelectThemeColor}
        />
      </View>
    );
  }

  const themeModeLabel = mobileThemeMode === 'auto' ? 'Auto' : mobileThemeMode === 'light' ? 'Light' : 'Dark';
  const themeColorLabel = MOBILE_THEME_COLOR_OPTIONS.find((option) => option.value === mobileThemeColor)?.label;
  const showAutomaticSignIn = Boolean(activeProfile && !activeProfile.hasPin && !activeProfile.isGuest);

  return (
    <View style={styles.settingsPage}>
      <View style={styles.settingsProfile}>
        <View style={styles.settingsAvatar}>
          {activeProfile ? (
            <ExpoImage
        cachePolicy="memory-disk" source={{ uri: mobileProfileAvatarUri(activeProfile) }} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <Text style={styles.settingsAvatarText}>LT</Text>
          )}
        </View>
        <Text selectable style={styles.settingsProfileTitle}>{activeProfile?.name || 'LoomTV profile'}</Text>
        <Text selectable style={styles.settingsProfileCopy}>
          {activeProfile?.type === 'owner' ? 'Owner profile' : activeProfile?.type === 'kid' ? 'Kids profile' : 'Personal profile'}
        </Text>
      </View>

      <View>
        <Text selectable style={styles.settingsGroupTitle}>Profile</Text>
        <View style={styles.settingsGroup}>
          <SettingsRow label="Switch profile" onPress={onSwitchProfile} />
          {showAutomaticSignIn && (
            <SettingsRow
              label="Automatic sign-in"
              right={(
                <Switch
                  accessibilityLabel="Automatic sign-in"
                  value={automaticProfileSignIn}
                  onValueChange={onSetAutomaticSignIn}
                  ios_backgroundColor={muted}
                  thumbColor={automaticProfileSignIn ? '#ffffff' : panel}
                  trackColor={{ false: muted, true: accent }}
                  style={{ transform: [{ translateY: 4 }] }}
                />
              )}
            />
          )}
          <SettingsRow label="Lock profile" onPress={onLockProfile} last />
        </View>
      </View>

      <View>
        <Text selectable style={styles.settingsGroupTitle}>Server</Text>
        <View style={styles.settingsGroup}>
          <SettingsRow label="Library" onPress={() => setActiveSection('library')} />
          <SettingsRow label="Network" onPress={() => setActiveSection('network')} last />
        </View>
      </View>

      <View>
        <Text selectable style={styles.settingsGroupTitle}>Appearance</Text>
        <View style={styles.settingsGroup}>
          <SettingsRow
            label="Theme"
            value={themeColorLabel ? `${themeModeLabel} · ${themeColorLabel}` : themeModeLabel}
            onPress={() => setActiveSection('appearance')}
            last
          />
        </View>
      </View>

      <View style={styles.settingsGroup}>
        <SettingsRow label="About" onPress={() => setActiveSection('about')} />
        <SettingsRow label="Disconnect device" onPress={onDisconnect} danger last />
      </View>
    </View>
  );
}

function SettingsRow({
  label,
  value,
  right,
  onPress,
  danger,
  last,
}: {
  label: string;
  value?: string;
  right?: ReactElement;
  onPress?: PressableProps['onPress'];
  danger?: boolean;
  last?: boolean;
}) {
  const { colors: { muted }, styles } = useMobileTheme();
  const content = (
    <>
      {danger
        ? <Text style={styles.settingsRowDangerText}>{label}</Text>
        : <Text selectable style={styles.settingsListText}>{label}</Text>}
      {value ? <Text selectable style={styles.settingsListValue}>{value}</Text> : null}
      {right}
      {onPress && !danger ? <ChevronRightIcon size={20} color={muted} /> : null}
    </>
  );

  if (!onPress) {
    return <View style={[styles.settingsGroupRow, last && styles.settingsGroupRowLast]}>{content}</View>;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={(event) => {
        if (label === 'Switch profile') captureMobileFocus(event);
        onPress(event);
      }}
      style={({ pressed }) => [styles.settingsGroupRow, last && styles.settingsGroupRowLast, pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  );
}

function MobileThemePicker({
  color,
  mode,
  onSelectColor,
  onSelectTheme,
}: {
  color: MobileThemeColor;
  mode: MobileThemeMode;
  onSelectColor: (color: MobileThemeColor) => void;
  onSelectTheme: (mode: MobileThemeMode) => void;
}) {
  const { colors: { accent, muted }, styles } = useMobileTheme();
  const options: { value: MobileThemeMode; label: string; Icon: (props: IconProps) => ReactElement }[] = [
    { value: 'auto', label: 'Auto', Icon: AutoThemeIcon },
    { value: 'light', label: 'Light mode', Icon: SunIcon },
    { value: 'dark', label: 'Dark mode', Icon: MoonIcon },
  ];

  return (
    <View style={styles.settingsThemePicker}>
      <View style={styles.settingsThemeOptions}>
        {options.map((option) => {
          const selected = mode === option.value;
          const Icon = option.Icon;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityLabel={`${option.label} theme`}
              accessibilityState={{ selected }}
              onPress={() => onSelectTheme(option.value)}
              style={({ pressed }) => [
                styles.settingsThemeOption,
                selected && styles.settingsThemeOptionActive,
                pressed && styles.pressed,
              ]}
            >
              <Icon size={24} color={selected ? accent : muted} />
              <Text selectable style={[styles.settingsThemeOptionText, selected && styles.settingsThemeOptionTextActive]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.settingsThemeDivider} />
      <Text selectable style={styles.settingsThemeColorTitle}>Theme</Text>
      <View style={styles.settingsThemeColorOptions}>
        {MOBILE_THEME_COLOR_OPTIONS.map((option) => {
          const selected = color === option.value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityLabel={`${option.label} theme color`}
              accessibilityState={{ selected }}
              onPress={() => onSelectColor(option.value)}
              style={({ pressed }) => [
                styles.settingsThemeColorOption,
                selected && styles.settingsThemeColorOptionActive,
                pressed && styles.pressed,
              ]}
            >
              <View style={[styles.settingsThemeColorSwatch, { backgroundColor: option.color }]} />
              <Text selectable style={styles.settingsThemeColorLabel}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function SettingsDetailHeader({
  label,
  onBack,
  sticky = false,
}: {
  label: string;
  onBack: () => void;
  sticky?: boolean;
}) {
  const { styles } = useMobileTheme();

  return (
    <View style={[styles.settingsDetailHeader, sticky && styles.settingsDetailHeaderSticky]}>
      <SubpageBackButton accessibilityLabel="Back to settings" onPress={onBack} />
      <Text selectable numberOfLines={1} style={styles.settingsDetailTitle}>{label}</Text>
    </View>
  );
}

function SettingsDetail({
  section,
  connection,
  counts,
  isTablet,
  isRefreshing,
  mobileThemeColor,
  mobileThemeMode,
  onRefresh,
  onSelectTheme,
  onSelectThemeColor,
}: {
  section: { id: SettingsSection; label: string; description: string };
  connection: Connection;
  counts: Record<'anime' | 'tv' | 'movies' | 'others', number>;
  isTablet: boolean;
  isRefreshing: boolean;
  mobileThemeColor: MobileThemeColor;
  mobileThemeMode: MobileThemeMode;
  onRefresh: () => void;
  onSelectTheme: (mode: MobileThemeMode) => void;
  onSelectThemeColor: (color: MobileThemeColor) => void;
}) {
  const { styles } = useMobileTheme();
  const { width, fontScale } = useWindowDimensions();
  const [diagnostics, setDiagnostics] = useState<MobileDiagnosticEvent[]>([]);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const refreshDiagnostics = useCallback(() => {
    void listMobileDiagnostics()
      .then(setDiagnostics)
      .catch((error) => reportNonFatal('diagnostics.list', error));
  }, []);

  useEffect(() => {
    if (section.id === 'about') refreshDiagnostics();
  }, [refreshDiagnostics, section.id]);
  const availableSettingsWidth = Math.min(
    settingsContentMaxWidth,
    Math.max(0, width - (isTablet ? 220 : 0) - settingsPageHorizontalPadding),
  );
  const cardInnerWidth = Math.max(0, availableSettingsWidth - settingsCardHorizontalPadding);
  const metricColumns = cardInnerWidth < 260 || fontScale >= 1.5
    ? 1
    : cardInnerWidth >= 560 && fontScale < 1.2
      ? 4
      : 2;
  const libraryMetrics: LibraryMetric[] = [
    { key: 'anime', label: 'Anime', value: counts.anime, Icon: navIcons.anime },
    { key: 'tv', label: 'TV Shows', value: counts.tv, Icon: navIcons.tv },
    { key: 'movies', label: 'Movies', value: counts.movies, Icon: navIcons.movies },
    { key: 'others', label: 'Others', value: counts.others, Icon: FolderIcon },
  ];
  const metricRows = Array.from({ length: Math.ceil(libraryMetrics.length / metricColumns) }, (_, index) =>
    libraryMetrics.slice(index * metricColumns, index * metricColumns + metricColumns));

  if (section.id === 'library') {
    return (
      <View style={styles.settingsCards}>
        <View style={styles.settingsCard}>
          <Text selectable style={styles.settingsCardTitle}>Library</Text>
          <Text selectable style={styles.settingsCardCopy}>Synced from {connection.hostDeviceName}.</Text>
          <View style={styles.settingsMetricRows}>
            {metricRows.map((row) => (
              <View key={row.map((metric) => metric.key).join('-')} style={styles.settingsMetricRow}>
                {row.map((metric) => (
                  <SettingsMetric key={metric.key} metric={metric} />
                ))}
              </View>
            ))}
          </View>
          <Pressable style={[styles.settingsPrimaryButton, isRefreshing && styles.disabledButton]} onPress={onRefresh} disabled={isRefreshing}>
            <Text style={styles.settingsPrimaryButtonText}>{isRefreshing ? 'Refreshing...' : 'Refresh library'}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (section.id === 'network') {
    return (
      <View style={styles.settingsCards}>
        <View style={styles.settingsCard}>
          <Text selectable style={styles.settingsCardTitle}>Paired Desktop</Text>
          <Text selectable style={styles.settingsCardCopy}>{connection.hostDeviceName}</Text>
          <Text selectable style={styles.settingsValue}>{connection.baseUrl}</Text>
        </View>
      </View>
    );
  }

  if (section.id === 'appearance') {
    return (
      <View style={styles.settingsCards}>
        <View style={styles.settingsCard}>
          <MobileThemePicker
            color={mobileThemeColor}
            mode={mobileThemeMode}
            onSelectColor={onSelectThemeColor}
            onSelectTheme={onSelectTheme}
          />
        </View>
      </View>
    );
  }

  if (section.id === 'about') {
    return (
      <View style={styles.settingsCards}>
        <View style={styles.settingsCard}>
          <Text selectable style={styles.settingsCardTitle}>Avatar attribution</Text>
          <Text selectable style={styles.settingsCardCopy}>
            DiceBear Glyphs remixes “Abstract Avatars for All Creative Profile Use” by Matt Houser, licensed under CC BY 4.0.
          </Text>
          <Text selectable style={styles.settingsValue}>dicebear.com/styles/glyphs</Text>
        </View>
        <View style={styles.settingsCard}>
          <Text selectable style={styles.settingsCardTitle}>Diagnostics</Text>
          <Text selectable style={styles.settingsCardCopy}>
            LoomTV keeps up to 100 sanitized diagnostic events for seven days. Credentials and private paths are removed.
          </Text>
          <Text selectable style={styles.settingsValue}>
            {diagnostics.length === 1 ? '1 recent event' : `${diagnostics.length} recent events`}
          </Text>
          {diagnostics.slice(0, 5).map((event) => (
            <Text key={event.id} selectable numberOfLines={2} style={styles.settingsValue}>
              {event.scope} · {event.name}: {event.message}
            </Text>
          ))}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Export diagnostics"
              disabled={diagnosticsBusy || diagnostics.length === 0}
              style={[{ minHeight: 44, minWidth: 96, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 10, paddingHorizontal: 16 }, { borderColor: 'rgba(255,255,255,0.2)' }, (diagnosticsBusy || diagnostics.length === 0) && styles.disabledButton]}
              onPress={() => {
                setDiagnosticsBusy(true);
                void exportMobileDiagnostics()
                  .then((message) => Share.share({ title: 'LoomTV diagnostics', message }))
                  .catch((error) => reportNonFatal('diagnostics.export', error))
                  .finally(() => setDiagnosticsBusy(false));
              }}
            >
              <Text style={styles.settingsValue}>Export</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear diagnostics"
              disabled={diagnosticsBusy || diagnostics.length === 0}
              style={[{ minHeight: 44, minWidth: 96, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 10, paddingHorizontal: 16 }, { borderColor: 'rgba(255,255,255,0.2)' }, (diagnosticsBusy || diagnostics.length === 0) && styles.disabledButton]}
              onPress={() => {
                setDiagnosticsBusy(true);
                void clearMobileDiagnostics()
                  .then(() => setDiagnostics([]))
                  .catch((error) => reportNonFatal('diagnostics.clear', error))
                  .finally(() => setDiagnosticsBusy(false));
              }}
            >
              <Text style={styles.settingsValue}>Clear</Text>
            </Pressable>
          </View>
        </View>
        <View style={styles.settingsCard}>
          <Text selectable style={styles.settingsCardTitle}>Open-source notices</Text>
          <Text selectable style={styles.settingsCardCopy}>
            LoomTV Mobile includes the following runtime components.
          </Text>
          <View style={{ gap: 6 }}>
            {MOBILE_OPEN_SOURCE_NOTICES.map((notice) => (
              <Text key={notice.name} selectable style={styles.settingsValue}>
                {notice.name} · {notice.license}
              </Text>
            ))}
          </View>
        </View>
      </View>
    );
  }

  return null;
}

function SettingsMetric({ metric }: { metric: LibraryMetric }) {
  const { colors: { accent }, styles } = useMobileTheme();
  const Icon = metric.Icon;
  return (
    <View style={styles.settingsMetric}>
      <View style={styles.settingsMetricIcon}>
        <Icon size={19} color={accent} />
      </View>
      <View style={styles.settingsMetricCopy}>
        <Text selectable style={styles.settingsMetricValue}>{metric.value}</Text>
        <Text selectable numberOfLines={1} style={styles.settingsMetricLabel}>{metric.label}</Text>
      </View>
    </View>
  );
}
