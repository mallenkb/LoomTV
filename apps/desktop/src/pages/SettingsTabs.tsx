import { Search } from 'lucide-react';
import { SETTINGS_SECTIONS, type SettingsSection } from './Settings.helpers';
import SharedListHighlight from '@/components/SharedListHighlight';

type SettingsTabsProps = {
  activeSection: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  sections?: typeof SETTINGS_SECTIONS;
  onSearch?: () => void;
};

export default function SettingsTabs({ activeSection, onSelect, sections = SETTINGS_SECTIONS, onSearch }: SettingsTabsProps) {
  return (
    <div
      className="loom-settings-tabs-positioner pointer-events-none fixed top-6 z-40"
    >
      <div className="loom-frame">
        <div className="loom-settings-tabs-frame mx-auto flex max-w-[var(--loom-frame-max-width)] items-center gap-2">
          <SharedListHighlight
            activeId={activeSection}
            followPointer={false}
            className="loom-settings-tabs loom-shared-highlight-tabs loom-no-drag pointer-events-auto inline-flex rounded-[12px] border border-[var(--loom-panel-border)] bg-[var(--loom-panel)] p-1 backdrop-blur-md"
          >
            {sections.map((section) => {
              const isActive = activeSection === section.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => onSelect(section.id)}
                  aria-pressed={isActive}
                  data-shared-highlight-item
                  data-shared-highlight-id={section.id}
                  className={`relative z-10 h-9 whitespace-nowrap rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--loom-accent)] ${
                    isActive
                      ? 'text-[var(--loom-active-text)]'
                      : 'text-[var(--loom-muted)] hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-text)]'
                  }`}
                >
                  <span className="relative z-10 whitespace-nowrap">{section.label}</span>
                </button>
              );
            })}
          </SharedListHighlight>
          {onSearch ? (
            <button
              type="button"
              onClick={onSearch}
              aria-label="Search settings"
              title="Search settings (⌘F)"
              aria-keyshortcuts="Meta+F Control+F"
              className="loom-settings-search-button loom-no-drag pointer-events-auto grid h-[46px] w-[46px] shrink-0 place-items-center rounded-[var(--loom-control-radius)] border border-[var(--loom-panel-border)] bg-[var(--loom-panel)] text-[var(--loom-muted)] backdrop-blur-md transition-colors hover:text-[var(--loom-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
            >
              <Search className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
