import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  FolderOpen,
} from '@phosphor-icons/react';
import { ArrowLeft, ArrowRight, Loader2, Plus, X } from 'lucide-react';
import { useLibrary, type LibraryFolderKind } from '@/contexts/LibraryContext';
import { desktopApi } from '@/lib/desktopApi';
import { Button } from '@/components/ui/button';
import { useModalLayer } from '@/components/ui/dialog';
import { LibraryTypeIcon } from '@/components/library-settings/librarySettingsModel';

type SetupStep = 'types' | 'folders' | 'review';
type SetupKind = LibraryFolderKind;

type LibraryOption = {
  id: SetupKind;
  label: string;
  description: string;
  formats: string;
};

const LIBRARY_OPTIONS: LibraryOption[] = [
  { id: 'movies', label: 'Movies', description: 'Feature films and personal videos', formats: 'MP4, MKV, AVI and more' },
  { id: 'tvShows', label: 'TV Shows', description: 'Series organized by season', formats: 'Episodes and season folders' },
  { id: 'anime', label: 'Anime', description: 'Anime series and films', formats: 'Series and movie folders' },
  { id: 'others', label: 'Other videos', description: 'Mixed video folders and custom collections', formats: 'Detected by Loom' },
];

export default function FirstRunLibrarySetup({ onComplete, onSkip }: { onComplete: () => void; onSkip: () => void }) {
  const { addLibraryFolderPath, removeLibraryFolder } = useLibrary();
  const [step, setStep] = useState<SetupStep>('types');
  const [selected, setSelected] = useState<SetupKind[]>(['movies', 'tvShows']);
  const [folders, setFolders] = useState<Partial<Record<SetupKind, string[]>>>({});
  const [busyKind, setBusyKind] = useState<SetupKind | null>(null);
  const [isFinishing, setIsFinishing] = useState(false);
  const [message, setMessage] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useModalLayer({
    contentRef: dialogRef,
    onEscape: () => { if (!busyKind && !isFinishing) onSkip(); },
    initialFocusRef: headingRef,
  });

  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const selectedOptions = useMemo(
    () => LIBRARY_OPTIONS.filter((option) => selected.includes(option.id)),
    [selected],
  );
  const folderCount = Object.values(folders).reduce((total, paths) => total + (paths?.length || 0), 0);

  const toggleType = (kind: SetupKind) => {
    if (selected.includes(kind) && (folders[kind]?.length || 0) > 0) {
      setMessage('Remove this library\'s folders before deselecting it.');
      return;
    }
    setSelected((current) => current.includes(kind)
      ? current.filter((entry) => entry !== kind)
      : [...current, kind]);
    setMessage('');
  };

  const applyStarter = (kinds: SetupKind[]) => {
    const configuredKinds = LIBRARY_OPTIONS
      .map((option) => option.id)
      .filter((kind) => (folders[kind]?.length || 0) > 0);
    setSelected([...new Set([...kinds, ...configuredKinds])]);
    setMessage('');
  };

  const recordFolder = (kind: SetupKind, path: string) => {
    setFolders((current) => {
      const existing = current[kind] || [];
      if (existing.includes(path)) return current;
      return { ...current, [kind]: [...existing, path] };
    });
    window.dispatchEvent(new Event('loomtv:library-roots-changed'));
  };

  const addFolder = async (kind: SetupKind) => {
    if (busyKind || isFinishing) return;
    setBusyKind(kind);
    setMessage('');
    try {
      const path = await desktopApi.pickLibraryFolder();
      if (!path) {
        setMessage('No folder was selected. Your choices are still here.');
        return;
      }
      await addLibraryFolderPath(kind, path);
      recordFolder(kind, path);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Loom could not add that folder.');
    } finally {
      setBusyKind(null);
    }
  };

  const removeDraftFolder = async (kind: SetupKind, path: string) => {
    if (busyKind || isFinishing) return;
    setBusyKind(kind);
    setMessage('');
    try {
      await removeLibraryFolder(path);
      setFolders((current) => ({
        ...current,
        [kind]: (current[kind] || []).filter((entry) => entry !== path),
      }));
      window.dispatchEvent(new Event('loomtv:library-roots-changed'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Loom could not remove that folder.');
    } finally {
      setBusyKind(null);
    }
  };

  const finish = async () => {
    if (folderCount === 0) {
      setMessage('Add at least one folder before finishing setup.');
      setStep('folders');
      return;
    }
    if (busyKind || isFinishing) return;
    setIsFinishing(true);
    setMessage('');
    try {
      onComplete();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Loom could not finish scanning your libraries.');
    } finally {
      setIsFinishing(false);
    }
  };

  return (
    <div ref={dialogRef} tabIndex={-1} className="fixed inset-0 z-[120] overflow-y-auto bg-[var(--loom-bg)] text-[var(--loom-text)]" role="dialog" aria-modal="true" aria-labelledby="first-library-setup-heading" aria-busy={busyKind !== null || isFinishing}>
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-6 py-8 sm:px-10">
        <header className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--loom-accent)]">Library setup</p>
            <p className="mt-1 text-sm text-[var(--loom-muted)]">Step {step === 'types' ? 1 : step === 'folders' ? 2 : 3} of 3</p>
          </div>
          <button
            type="button"
            onClick={onSkip}
            disabled={busyKind !== null || isFinishing}
            className="rounded-lg px-3 py-2 text-sm text-[var(--loom-muted)] transition hover:bg-[var(--loom-surface-2)] hover:text-[var(--loom-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] disabled:opacity-50"
          >
            Set up later
          </button>
        </header>

        <div className="mt-6 flex gap-2" aria-hidden="true">
          {(['types', 'folders', 'review'] as const).map((entry) => {
            const steps = ['types', 'folders', 'review'] as const;
            const active = steps.indexOf(entry) <= steps.indexOf(step);
            return <span key={entry} className={`h-1 flex-1 rounded-full ${active ? 'bg-[var(--loom-accent)]' : 'bg-[var(--loom-surface-3)]'}`} />;
          })}
        </div>

        {step === 'types' && (
          <main className="py-10">
            <h1 id="first-library-setup-heading" ref={headingRef} tabIndex={-1} className="text-3xl font-bold tracking-tight outline-none">Choose your libraries</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--loom-muted)]">Pick what you keep on this server. You can add more libraries or folders in Settings at any time.</p>
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-[var(--loom-muted)]">Quick picks</span>
              <Button type="button" variant="outline" size="sm" onClick={() => applyStarter(['movies', 'tvShows', 'anime'])}>Video</Button>
              <Button type="button" variant="outline" size="sm" onClick={() => applyStarter(LIBRARY_OPTIONS.map((option) => option.id))}>Everything</Button>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" role="group" aria-label="Library types">
              {LIBRARY_OPTIONS.map(({ id, label, description, formats }) => {
                const active = selected.includes(id);
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleType(id)}
                    className={`flex min-h-28 items-start gap-3 rounded-2xl border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${active ? 'border-[var(--loom-active-border)] bg-[var(--loom-active-bg)]' : 'border-[var(--loom-border)] bg-[var(--loom-surface)] hover:bg-[var(--loom-surface-2)]'}`}
                  >
                    <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${active ? 'bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]' : 'bg-[var(--loom-surface-3)] text-[var(--loom-muted)]'}`}>
                      <LibraryTypeIcon kind={id} active={active} className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2 text-sm font-semibold">{label}{active && <Check className="h-4 w-4 text-[var(--loom-accent)]" />}</span>
                      <span className="mt-1 block text-xs leading-5 text-[var(--loom-muted)]">{description}</span>
                      <span className="mt-2 block text-[11px] text-[var(--loom-muted)]/75">{formats}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {message && <p role="status" className="mt-4 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-4 py-3 text-sm text-[var(--loom-muted)]">{message}</p>}
          </main>
        )}

        {step === 'folders' && (
          <main className="py-10">
            <h1 id="first-library-setup-heading" ref={headingRef} tabIndex={-1} className="text-3xl font-bold tracking-tight outline-none">Add folders</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--loom-muted)]">Each library can use one or several local or mounted network folders. Loom leaves the original files in place.</p>
            <div className="mt-6 space-y-3">
              {selectedOptions.map(({ id, label }) => (
                <section key={id} className="rounded-2xl border border-[var(--loom-border)] bg-[var(--loom-surface)] p-4">
                  <div className="flex items-center gap-3">
                    <span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--loom-surface-3)] text-[var(--loom-accent)]"><LibraryTypeIcon kind={id} className="h-5 w-5" /></span>
                    <div className="min-w-0 flex-1">
                      <h2 className="text-sm font-semibold">{label}</h2>
                      <p className="text-xs text-[var(--loom-muted)]">{folders[id]?.length || 0} folders added</p>
                    </div>
                      <Button type="button" variant="outline" size="sm" onClick={() => void addFolder(id)} disabled={busyKind !== null || isFinishing} className="gap-2">
                      {busyKind === id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                      Add folder
                    </Button>
                  </div>
                  {(folders[id]?.length || 0) > 0 && (
                    <div className="mt-3 space-y-2 border-t border-[var(--loom-border)] pt-3">
                      {folders[id]?.map((path) => (
                        <div key={path} className="flex items-center gap-3 rounded-lg bg-[var(--loom-bg)] px-3 py-2">
                          <FolderOpen className="h-4 w-4 shrink-0 text-[var(--loom-muted)]" />
                          <code className="min-w-0 flex-1 truncate text-xs text-[var(--loom-text)]">{path}</code>
                          <Button type="button" variant="outline" size="icon" onClick={() => void removeDraftFolder(id, path)} disabled={busyKind !== null || isFinishing} className="h-8 w-8 border-red-500/30 bg-red-500/10 text-red-200 hover:border-red-400/50 hover:bg-red-500/20 hover:text-red-50" aria-label={`Remove ${path} from ${label}`}><X className="h-4 w-4" /></Button>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              ))}
            </div>
            {message && <p role="status" className="mt-4 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-4 py-3 text-sm text-[var(--loom-muted)]">{message}</p>}
          </main>
        )}

        {step === 'review' && (
          <main className="py-10">
            <h1 id="first-library-setup-heading" ref={headingRef} tabIndex={-1} className="text-3xl font-bold tracking-tight outline-none">Review your libraries</h1>
            <p className="mt-2 text-sm leading-6 text-[var(--loom-muted)]">You selected {selected.length} {selected.length === 1 ? 'library' : 'libraries'} with {folderCount} {folderCount === 1 ? 'folder' : 'folders'}.</p>
            <div className="mt-6 overflow-hidden rounded-2xl border border-[var(--loom-border)] bg-[var(--loom-surface)]">
              {selectedOptions.map(({ id, label }, index) => (
                <div key={id} className={`flex items-center gap-3 px-4 py-3 ${index ? 'border-t border-[var(--loom-border)]' : ''}`}>
                  <LibraryTypeIcon kind={id} active className="h-5 w-5 shrink-0 text-[var(--loom-accent)]" />
                  <span className="min-w-0 flex-1 text-sm font-medium">{label}</span>
                  <span className="text-xs text-[var(--loom-muted)]">{folders[id]?.length || 0} folders</span>
                </div>
              ))}
            </div>

          </main>
        )}

        <footer className="mt-auto flex items-center justify-between gap-3 border-t border-[var(--loom-border)] pt-5">
          <Button type="button" variant="outline" onClick={() => setStep(step === 'review' ? 'folders' : 'types')} className="gap-2" disabled={step === 'types' || busyKind !== null || isFinishing}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          {step === 'types' && <Button type="button" onClick={() => setStep('folders')} disabled={selected.length === 0 || busyKind !== null || isFinishing} className="gap-2">Choose folders <ArrowRight className="h-4 w-4" /></Button>}
          {step === 'folders' && <Button type="button" onClick={() => setStep('review')} disabled={busyKind !== null || isFinishing || folderCount === 0} className="gap-2">Review <ArrowRight className="h-4 w-4" /></Button>}
          {step === 'review' && <Button type="button" onClick={() => void finish()} disabled={busyKind !== null || isFinishing || folderCount === 0}>{isFinishing ? 'Scanning…' : 'Finish setup'}</Button>}
        </footer>
      </div>
    </div>
  );
}
