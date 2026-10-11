import type { SettingsSection } from './Settings.helpers';
import type { SettingsController } from './useSettingsController';

/** Every tab renders the main settings sections built on SettingsLayout. */
export default function CompactSettingsSection({ section, controller }: {
  section: SettingsSection;
  controller: SettingsController;
}) {
  return <>{controller.renderSection(section)}</>;
}
