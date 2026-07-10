import {
  ChevronRight,
  Database,
  FolderCog,
  MonitorPlay,
  Palette,
  Share2,
  type LucideIcon,
} from 'lucide-react';
import {
  SETTINGS_GROUP_LABELS,
  SETTINGS_SECTIONS,
  type SettingsSection,
} from './Settings.helpers';

type SettingsTabsProps = {
  activeSection: SettingsSection;
  onSelect: (section: SettingsSection) => void;
};

const SECTION_ICONS: Record<SettingsSection, LucideIcon> = {
  library: FolderCog,
  playback: MonitorPlay,
  metadata: Database,
  network: Share2,
  theme: Palette,
  about: Database,
};

export default function SettingsTabs({ activeSection, onSelect }: SettingsTabsProps) {
  return (
    <nav
      aria-label="Settings sections"
      className="loom-settings-tabs loom-no-drag sticky top-6 rounded-2xl border border-[var(--loom-panel-border)] bg-[var(--loom-panel)] p-3 backdrop-blur-md"
    >
      <div className="border-b border-[var(--loom-panel-border)] px-2 pb-4 pt-1">
        <p className="text-lg font-bold text-white">Settings</p>
        <p className="mt-1 text-xs leading-5 text-[var(--loom-muted)]">
          Choose a task. Related controls stay together.
        </p>
      </div>

      <div className="loom-no-drag space-y-4 pt-4">
        {SETTINGS_SECTIONS.map((section, index) => {
          const isActive = activeSection === section.id;
          const startsGroup = index === 0 || SETTINGS_SECTIONS[index - 1].group !== section.group;
          const Icon = SECTION_ICONS[section.id];

          return (
            <div key={section.id}>
              {startsGroup && (
                <p className="mb-1.5 px-2 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--loom-faint)]">
                  {SETTINGS_GROUP_LABELS[section.group]}
                </p>
              )}
              <button
                type="button"
                onClick={() => onSelect(section.id)}
                aria-pressed={isActive}
                className={`group flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors ${
                  isActive
                    ? 'bg-[var(--loom-surface-3)] text-white ring-1 ring-[var(--loom-accent)]/35'
                    : 'text-[var(--loom-muted)] hover:bg-[var(--loom-surface-2)] hover:text-white'
                }`}
              >
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
                  isActive
                    ? 'bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]'
                    : 'bg-[var(--loom-surface-2)] text-[var(--loom-faint)] group-hover:text-[var(--loom-accent)]'
                }`}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold leading-5">{section.label}</span>
                  <span className="block truncate text-[11px] leading-4 text-[var(--loom-faint)]">
                    {section.description}
                  </span>
                </span>
                <ChevronRight className={`h-4 w-4 shrink-0 ${isActive ? 'text-[var(--loom-accent)]' : 'text-[var(--loom-faint)]'}`} />
              </button>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
