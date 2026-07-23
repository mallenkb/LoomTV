import { SETTINGS_SECTIONS, type SettingsSection } from './Settings.helpers';

type SettingsTabsProps = {
  activeSection: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  sections?: typeof SETTINGS_SECTIONS;
};

export default function SettingsTabs({ activeSection, onSelect, sections = SETTINGS_SECTIONS }: SettingsTabsProps) {
  return (
    <div
      className="loom-settings-tabs loom-no-drag fixed left-[max(calc(12rem+1.5rem),calc(12rem+((100vw-12rem-64rem)/2)))] top-6 z-40 inline-flex rounded-[12px] border border-[var(--loom-panel-border)] bg-[var(--loom-panel)] p-1 backdrop-blur-md"
      style={{ borderRadius: 12 }}
    >
      {sections.map((section) => {
        const isActive = activeSection === section.id;
        return (
          <button
            key={section.id}
            type="button"
            onClick={() => onSelect(section.id)}
            aria-pressed={isActive}
            className={`relative h-9 whitespace-nowrap rounded-[8px] px-4 text-sm font-medium transition-colors ${
              isActive
                ? 'text-[var(--loom-active-text)]'
                : 'text-[var(--loom-muted)] hover:text-[var(--loom-text)]'
            }`}
            style={{ borderRadius: 8 }}
          >
            {isActive && (
              <span
                className="absolute inset-0 rounded-[8px] bg-[var(--loom-active-bg)]"
                style={{ borderRadius: 8 }}
              />
            )}
            <span className="relative z-10 whitespace-nowrap">{section.label}</span>
          </button>
        );
      })}
    </div>
  );
}
