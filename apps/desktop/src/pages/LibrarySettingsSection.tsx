import LibrarySettingsPanel, { type LibrarySettingsSectionProps } from '@/components/library-settings/LibrarySettingsPanel';

export type { LibrarySettingsSectionProps };

export default function LibrarySettingsSection(props: LibrarySettingsSectionProps) {
  return <LibrarySettingsPanel {...props} />;
}
