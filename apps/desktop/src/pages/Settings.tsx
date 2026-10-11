import { useCallback, useEffect, useMemo, useState } from 'react';
import { SettingsAccordionScope, openSettingsGroup } from '@/components/settings/SettingsLayout';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import SharedListHighlight from '@/components/SharedListHighlight';
import { nextSettingsSection } from '@/lib/settingsTabs';
import {
  SETTINGS_SECTION_STORAGE_KEY,
  isSettingsSection,
  type SettingsSection,
} from './Settings.helpers';
import CompactSettingsSection from './CompactSettingsSection';
import SettingsSearch from './SettingsSearch';
import SettingsTabs from './SettingsTabs';
import type { SettingsSearchEntry } from './settingsSearchIndex';
import { SETTINGS_GROUPS, SETTINGS_PAGES } from './settingsModel';
import { useSettingsController } from './useSettingsController';

export default function Settings() {
  const [activeSection, setActiveSection] = useState<SettingsSection>(() => {
    const savedSection = localStorage.getItem(SETTINGS_SECTION_STORAGE_KEY);
    return isSettingsSection(savedSection) ? savedSection : 'library';
  });
  const [isMobileSettingsMenuOpen, setIsMobileSettingsMenuOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTarget, setSearchTarget] = useState<string | null>(null);
  const controller = useSettingsController(activeSection);
  const { visibleSettingsSections, settingsPersistenceError } = controller;
  const orderedVisibleSections = useMemo(() => {
    const visibleIds = new Set(visibleSettingsSections.map((section) => section.id));
    return SETTINGS_GROUPS.flatMap((group) => group.pages.flatMap((id) => (
      visibleIds.has(id) ? [{ id, label: SETTINGS_PAGES[id].label }] : []
    )));
  }, [visibleSettingsSections]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_SECTION_STORAGE_KEY, activeSection);
  }, [activeSection]);

  const handleSectionSelect = useCallback((sectionId: SettingsSection) => {
    setActiveSection((current) => nextSettingsSection(current, sectionId));
    setIsMobileSettingsMenuOpen(false);
  }, []);

  useEffect(() => {
    if (!orderedVisibleSections.some((section) => section.id === activeSection)) setActiveSection('profiles');
  }, [activeSection, orderedVisibleSections]);

  // Cmd/Ctrl+F opens settings search.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const openSearchResult = useCallback((entry: SettingsSearchEntry) => {
    if (entry.group) openSettingsGroup(entry.group);
    setActiveSection(entry.section);
    setIsMobileSettingsMenuOpen(false);
    setSearchTarget(entry.title);
  }, []);

  // Scroll to the chosen setting once its tab has rendered, and flash it.
  useEffect(() => {
    if (!searchTarget) return undefined;
    let attempts = 0;
    let timer = 0;
    let flashed: HTMLElement | null = null;
    const find = () => {
      const match = document.querySelector<HTMLElement>(`.loom-settings-sections [data-settings-title="${CSS.escape(searchTarget)}"]`);
      if (match) {
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        match.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
        match.classList.add('loom-settings-found');
        flashed = match;
        timer = window.setTimeout(() => {
          match.classList.remove('loom-settings-found');
          setSearchTarget(null);
        }, 1900);
      } else if (++attempts < 20) {
        timer = window.setTimeout(find, 100);
      } else {
        setSearchTarget(null);
      }
    };
    timer = window.setTimeout(find, 60);
    return () => {
      window.clearTimeout(timer);
      flashed?.classList.remove('loom-settings-found');
    };
  }, [activeSection, searchTarget]);

  const activeSectionLabel = orderedVisibleSections.find((section) => section.id === activeSection)?.label || 'Settings';

  return (
    <div className={`loom-page loom-settings-page h-full overflow-y-auto ${isMobileSettingsMenuOpen ? 'loom-settings-menu-open' : 'loom-settings-detail-open'}`}>
      <div className="loom-frame page-bottom-safe pt-6">
        <div className="loom-settings-content mx-auto max-w-[var(--loom-frame-max-width)] pt-16">
          <SettingsTabs activeSection={activeSection} onSelect={handleSectionSelect} sections={orderedVisibleSections} onSearch={() => setSearchOpen(true)} />
          <SettingsSearch open={searchOpen} onOpenChange={setSearchOpen} visibleSections={orderedVisibleSections.map((section) => section.id)} onSelect={openSearchResult} onOpenSection={handleSectionSelect} />

          <div className="loom-settings-mobile-menu">
            <div className="loom-settings-mobile-profile">
              <div className="loom-settings-mobile-logo">LT</div>
              <h1>Loom</h1>
              <p>Manage your libraries, playback, network, metadata, theme, and app details.</p>
            </div>
            <SharedListHighlight activeId={activeSection} className="loom-settings-mobile-list loom-shared-highlight-list">
              {orderedVisibleSections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => handleSectionSelect(section.id)}
                  aria-current={section.id === activeSection ? 'page' : undefined}
                  data-shared-highlight-item
                  data-shared-highlight-id={section.id}
                  className="relative z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--loom-accent)]"
                >
                  <span className="whitespace-nowrap">{section.label}</span>
                  <ChevronRight className="h-5 w-5" />
                </button>
              ))}
            </SharedListHighlight>
          </div>

          <div className="loom-settings-mobile-detail-bar">
            <button type="button" onClick={() => setIsMobileSettingsMenuOpen(true)} aria-label="Back to settings">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <h1>{activeSectionLabel}</h1>
          </div>

          <div className="loom-settings-sections space-y-6 pb-16">
              {settingsPersistenceError && (
                <div role="alert" className="settings-status-error rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm">
                  {settingsPersistenceError}
                </div>
              )}
              <SettingsAccordionScope key={activeSection}>
                <CompactSettingsSection section={activeSection} controller={controller} />
              </SettingsAccordionScope>
          </div>
        </div>
      </div>
    </div>
  );
}
