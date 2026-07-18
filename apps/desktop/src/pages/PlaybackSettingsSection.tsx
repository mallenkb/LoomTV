import { useEffect, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { LocalSegmentAnalysisStatus, SkipAnalysisSettings } from '@/lib/desktopApi';
import SkipTimestampManager from './SkipTimestampManager';

type PlaybackSettingsSectionProps = {
  skipBackSeconds: number;
  skipForwardSeconds: number;
  onSkipBackChange: (value: number) => void;
  onSkipForwardChange: (value: number) => void;
  skipAnalysis: SkipAnalysisSettings;
  onSkipAnalysisChange: (value: SkipAnalysisSettings) => void;
  analysisStatus: LocalSegmentAnalysisStatus | null;
  onAnalysisAction: (
    action: 'run' | 'pause' | 'resume' | 'cancel' | 'cancel-manual' | 'cleanup' | 'rebuild',
    scope?: { mediaId?: string; season?: number; mode?: 'quick' | 'full' },
  ) => Promise<{ queued: number } | undefined> | void;
  onSave: () => void | boolean | Promise<void | boolean>;
};

const INTRO_TYPES = ['intro', 'recap'] as const;
const OUTRO_TYPES = ['credits', 'preview'] as const;

const STATE_LABELS: Record<string, string> = {
  idle: 'Idle — markers up to date',
  queued: 'Queued',
  running: 'Analyzing…',
  paused: 'Paused',
  disabled: 'Off',
  unavailable: 'Unavailable',
  error: 'Needs attention',
};

export default function PlaybackSettingsSection({
  skipBackSeconds,
  skipForwardSeconds,
  onSkipBackChange,
  onSkipForwardChange,
  skipAnalysis,
  onSkipAnalysisChange,
  analysisStatus,
  onAnalysisAction,
  onSave,
}: PlaybackSettingsSectionProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [scopeMediaId, setScopeMediaId] = useState('');
  const [scopeSeason, setScopeSeason] = useState('');
  // The status poll reports how many jobs remain, not how many a scan started
  // with. Remember the largest remaining count seen during the active run so
  // the bar can show honest progress through that batch.
  const [batchSize, setBatchSize] = useState(0);
  const manualRemaining = (analysisStatus?.manualPendingCount || 0) + (analysisStatus?.manualRunningCount || 0);
  // The checkbox is an unsaved draft. Only persisted coordinator status may
  // hide an active run; otherwise unchecking before Save would hide Stop.
  const coordinatorDisabled = analysisStatus?.state === 'disabled';
  const manualScanActive = !coordinatorDisabled && manualRemaining > 0;
  const running = analysisStatus?.runningCount || 0;
  const remaining = manualScanActive ? manualRemaining : running;
  const waiting = analysisStatus?.waitingCount || 0;
  const scanActive = remaining > 0;
  useEffect(() => {
    if (!scanActive) {
      setBatchSize(0);
      return;
    }
    setBatchSize((size) => Math.max(size, remaining));
  }, [remaining, scanActive]);
  const percent = scanActive && batchSize > 0
    ? Math.min(99, Math.round(((batchSize - remaining) / batchSize) * 100))
    : 0;
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const update = (patch: Partial<SkipAnalysisSettings>) => onSkipAnalysisChange({ ...skipAnalysis, ...patch });
  const manuallyScan = async (scope?: { mediaId?: string; season?: number; mode?: 'quick' | 'full' }) => {
    setScanNotice(null);
    if (!skipAnalysis.enabled) {
      setScanNotice('Enable automatic intro and outro detection before starting a scan.');
      return;
    }
    // Scans always persist the current settings first; a failed save must not
    // start a run against the stale configuration.
    const saved = await onSave();
    if (saved === false) return;
    const result = await onAnalysisAction('run', scope);
    if (result && result.queued > 0) setBatchSize(result.queued);
    if (result && result.queued === 0) {
      setScanNotice(scope?.mode === 'quick'
        ? waiting > 0
          ? `No new items to analyze. ${waiting} item${waiting === 1 ? ' is' : 's are'} waiting for more episodes.`
          : 'Everything is already analyzed and up to date — nothing new to scan.'
        : 'No analyzable content found in that scope.');
    }
  };
  const stopScan = () => {
    setScanNotice('Scan stopped. Already-marked content keeps its markers.');
    void onAnalysisAction('cancel-manual');
  };
  const statusText = !analysisStatus
    ? 'Checking local analysis helpers…'
    : `${STATE_LABELS[analysisStatus.state] || analysisStatus.state}${analysisStatus.pendingCount ? ` · ${analysisStatus.pendingCount} pending` : ''}${waiting ? ` · ${waiting} waiting for more episodes` : ''}`;
  const coverage = analysisStatus?.library;
  const coverageWaiting = coverage?.waiting || 0;
  const coverageRemaining = coverage ? Math.max(0, coverage.total - coverage.analyzed - coverageWaiting) : 0;
  const phase = analysisStatus?.phaseProgress;

  return (
    <div className="space-y-6">
      <Card className="settings-panel">
        <CardHeader>
          <CardTitle className="text-white">Playback</CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            Adjust the default seek distances used by the player controls and keyboard shortcuts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-2">
              <span className="text-sm font-medium text-white">Back skip seconds</span>
              <input type="number" min={1} step={1} value={skipBackSeconds} onChange={(event) => onSkipBackChange(Number(event.target.value))} className="w-full rounded-lg border border-[var(--loom-border)] bg-[var(--loom-bg)] px-3 py-2 text-sm text-white outline-none" />
            </label>
            <label className="space-y-2">
              <span className="text-sm font-medium text-white">Forward skip seconds</span>
              <input type="number" min={1} step={1} value={skipForwardSeconds} onChange={(event) => onSkipForwardChange(Number(event.target.value))} className="w-full rounded-lg border border-[var(--loom-border)] bg-[var(--loom-bg)] px-3 py-2 text-sm text-white outline-none" />
            </label>
          </div>
        </CardContent>
      </Card>

      <Card className="settings-panel">
        <CardHeader>
          <CardTitle className="text-white">Intro &amp; Outro Skipping</CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            LoomTV finds intros and outros automatically — from online databases, embedded chapters, and local audio analysis — and shows a skip button during playback. Media files are never modified.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-[var(--loom-panel-border)] bg-[var(--loom-surface-2)] p-4">
            <label className="flex items-center gap-3 text-sm font-medium text-white">
              <span className="relative grid h-5 w-5 shrink-0 place-items-center">
                <input
                  type="checkbox"
                  checked={skipAnalysis.enabled}
                  onChange={(event) => update(event.target.checked
                    ? { enabled: true, analyzeNewMedia: true }
                    : { enabled: false })}
                  className="peer h-5 w-5 cursor-pointer appearance-none rounded border bg-[var(--loom-bg)] transition-colors checked:bg-[var(--loom-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-focus-glow)]"
                />
                <Check className="pointer-events-none absolute h-3.5 w-3.5 text-[var(--loom-accent-foreground)] opacity-0 transition-opacity peer-checked:opacity-100" strokeWidth={3} />
              </span>
              Automatically detect and mark intros &amp; outros
            </label>
            <div className="flex flex-wrap items-center gap-2">
              {manualScanActive ? (
                <Button type="button" onClick={stopScan}>Stop scan</Button>
              ) : (
                <Button type="button" disabled={!skipAnalysis.enabled} onClick={() => void manuallyScan({ mode: 'quick' })}>Quick scan</Button>
              )}
              <Button type="button" variant="outline" disabled={manualScanActive || !skipAnalysis.enabled} onClick={() => void manuallyScan({ mode: 'full' })}>Full scan</Button>
              <Button type="button" variant="outline" onClick={onSave}>Save</Button>
            </div>
          </div>

          <p className="text-xs text-[var(--loom-muted)]">
            Quick scan only analyzes items that aren&apos;t up to date yet. Full scan re-analyzes the entire library.
            Scans save your settings automatically, and stopping keeps everything already completed — only the rest stays remaining.
          </p>
          {scanNotice && !scanActive && <p className="settings-status-available text-xs">{scanNotice}</p>}

          {scanActive ? (
            <div className="rounded-lg bg-[var(--loom-surface-2)] p-4" aria-live="polite">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="font-medium text-white">
                  {analysisStatus?.paused ? 'Paused' : manualScanActive ? 'Analyzing library…' : 'Automatic analysis running…'}
                </span>
                <span className="text-[var(--loom-muted)]">
                  {percent}% · {remaining} item{remaining === 1 ? '' : 's'} left
                </span>
              </div>
              <div
                role="progressbar"
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Skip analysis progress"
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--loom-surface-3)]"
              >
                <div
                  className="h-full rounded-full bg-[var(--loom-accent)] transition-[width] duration-700 ease-out"
                  style={{ width: `${Math.max(percent, 2)}%` }}
                />
              </div>
              {analysisStatus?.currentJob && (
                <p className="mt-2 text-xs text-[var(--loom-muted)]">{analysisStatus.currentJob.detail}</p>
              )}
              {phase && (
                <p className="mt-1 text-xs text-[var(--loom-muted)]">
                  Current phase: {phase.completed} of {phase.total} {phase.phase === 'fingerprinting' ? 'fingerprinted' : 'matched'}
                </p>
              )}
              {coverage && (
                <p className="mt-1 text-xs text-[var(--loom-muted)]">
                  {coverage.analyzed} of {coverage.total} library items analyzed
                  {coverageWaiting > 0 ? ` · ${coverageWaiting} waiting for more episodes` : ''}
                  {coverageRemaining > 0 ? ` · ${coverageRemaining} remaining` : ''}
                </p>
              )}
              {analysisStatus?.lastError && <p role="alert" className="settings-status-error mt-1 text-xs">{analysisStatus.lastError}</p>}
              {!!analysisStatus?.recentJobs?.length && (
                <div className="mt-3">
                  <Button
                    type="button"
                    variant="outline"
                    aria-expanded={showProgress}
                    aria-controls="skip-analysis-progress-list"
                    onClick={() => setShowProgress((value) => !value)}
                  >
                    {showProgress ? 'Hide progress' : 'Show progress'}
                  </Button>
                  {showProgress && <AnalysisProgressList jobs={analysisStatus.recentJobs} />}
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-[var(--loom-muted)]">
              <p>{statusText}</p>
              {coverage && (
                <p className="mt-1">
                  {coverage.analyzed} of {coverage.total} library items analyzed
                  {coverageWaiting > 0 ? ` · ${coverageWaiting} waiting for more episodes` : ''}
                  {coverageRemaining > 0 ? ` · ${coverageRemaining} remaining` : coverageWaiting === 0 ? ' — all caught up' : ''}
                </p>
              )}
              {analysisStatus?.lastError && <p role="alert" className="settings-status-error mt-1">{analysisStatus.lastError}</p>}
              {waiting > 0 && <p className="mt-1">{waiting} item{waiting === 1 ? '' : 's'} waiting for enough peer episodes; this does not keep the scanner active.</p>}
              {coordinatorDisabled && manualRemaining > 0 && (
                <p className="mt-1">{manualRemaining} unfinished manual item{manualRemaining === 1 ? '' : 's'} retained and ready to resume when analysis is enabled.</p>
              )}
            </div>
          )}

          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((value) => !value)}
              aria-expanded={showAdvanced}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--loom-control-border)] bg-[var(--loom-surface-2)] px-3 py-2 text-xs font-semibold text-[var(--loom-accent)] transition-colors hover:bg-[var(--loom-active-bg)]"
            >
              {showAdvanced ? 'Hide advanced options' : 'Show advanced options'}
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
            </button>
          </div>

          {showAdvanced && (
            <div className="space-y-5 rounded-lg bg-[var(--loom-surface-2)] p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Toggle label="Auto-scan new or changed media" checked={skipAnalysis.analyzeNewMedia} onChange={(analyzeNewMedia) => update({ analyzeNewMedia })} />
                <Toggle label="Analyze Season 0 specials" checked={skipAnalysis.analyzeSpecials} onChange={(analyzeSpecials) => update({ analyzeSpecials })} />
                <Toggle label="Suppress first-episode intros" checked={skipAnalysis.suppressFirstEpisodeIntro} onChange={(suppressFirstEpisodeIntro) => update({ suppressFirstEpisodeIntro })} />
              </div>

              <div>
                <h3 className="text-sm font-medium text-white">Skip sections</h3>
                <div className="mt-3 grid gap-4 lg:grid-cols-2">
                  <SegmentGroup title="Intro & recap" description="Opening sequences and previous-episode summaries." types={INTRO_TYPES} settings={skipAnalysis} update={update} />
                  <SegmentGroup title="Outro & next preview" description="End credits and upcoming-episode previews." types={OUTRO_TYPES} settings={skipAnalysis} update={update} />
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <ListField label="Excluded series IDs" value={skipAnalysis.exclusions.seriesIds} onChange={(seriesIds) => update({ exclusions: { ...skipAnalysis.exclusions, seriesIds } })} />
                <ListField label="Excluded movie IDs" value={skipAnalysis.exclusions.movieIds} onChange={(movieIds) => update({ exclusions: { ...skipAnalysis.exclusions, movieIds } })} />
                <ListField label="Excluded seasons (mediaId:season)" value={skipAnalysis.exclusions.seasons} onChange={(seasons) => update({ exclusions: { ...skipAnalysis.exclusions, seasons } })} />
                <ListField label="Excluded local paths" value={skipAnalysis.exclusions.paths} onChange={(paths) => update({ exclusions: { ...skipAnalysis.exclusions, paths } })} />
              </div>

              <div className="rounded-lg bg-[var(--loom-surface-2)] p-4">
                <p className="text-sm font-medium text-white">Maintenance</p>
                <p className="mt-1 text-xs text-[var(--loom-muted)]">{analysisStatus?.fingerprintCount || 0} cached fingerprints · {formatBytes(analysisStatus?.fingerprintCacheBytes || 0)}{analysisStatus?.helperPath ? ` · ${analysisStatus.helperPath}` : ''}</p>
                {analysisStatus?.progress && <p className="mt-1 text-xs text-[var(--loom-muted)]">Job history: {analysisStatus.progress.complete}/{analysisStatus.progress.total} complete</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button type="button" variant="outline" onClick={() => onAnalysisAction(analysisStatus?.paused ? 'resume' : 'pause')}>{analysisStatus?.paused ? 'Resume' : 'Pause'}</Button>
                  <Button type="button" variant="outline" onClick={() => onAnalysisAction('cancel')}>Cancel queued</Button>
                  <Button type="button" variant="outline" onClick={() => onAnalysisAction('cleanup')}>Clear stale cache</Button>
                  <Button type="button" variant="outline" onClick={() => onAnalysisAction('rebuild')}>Rebuild all automatic markers</Button>
                </div>
                <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_110px_auto]">
                  <input value={scopeMediaId} onChange={(event) => setScopeMediaId(event.target.value)} placeholder="Media ID for season scan" className="rounded-lg border border-[var(--loom-border)] bg-[var(--loom-bg)] px-3 py-2 text-sm text-white" />
                  <input value={scopeSeason} onChange={(event) => setScopeSeason(event.target.value)} type="number" min={0} placeholder="Season" className="rounded-lg border border-[var(--loom-border)] bg-[var(--loom-bg)] px-3 py-2 text-sm text-white" />
                  <Button type="button" variant="outline" disabled={!skipAnalysis.enabled || !scopeMediaId.trim()} onClick={() => void manuallyScan({ mediaId: scopeMediaId.trim(), season: Math.max(0, Number(scopeSeason) || 0) })}>Save &amp; scan season</Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="settings-panel">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-white">Manual markers</CardTitle>
              <CardDescription className="text-[var(--loom-muted)]">
                Review, correct, or add intro and outro timestamps by hand. Manual markers always override automatic detection.
              </CardDescription>
            </div>
            <Button type="button" variant="outline" onClick={() => setShowManual((value) => !value)}>
              {showManual ? 'Hide timestamp manager' : 'Open timestamp manager'}
            </Button>
          </div>
        </CardHeader>
        {showManual && (
          <CardContent>
            <SkipTimestampManager
              settings={skipAnalysis}
              onSettingsChange={onSkipAnalysisChange}
              onRun={(scope) => onAnalysisAction('run', scope)}
              onSaveSettings={onSave}
            />
          </CardContent>
        )}
      </Card>
    </div>
  );
}

type ProgressJob = NonNullable<LocalSegmentAnalysisStatus['recentJobs']>[number];

function AnalysisProgressList({ jobs }: { jobs: ProgressJob[] }) {
  return (
    <div id="skip-analysis-progress-list" className="mt-3 max-h-52 overflow-y-auto rounded-md border border-[var(--loom-border)]">
      <table className="w-full text-left text-xs text-[var(--loom-muted)]">
        <caption className="sr-only">Completed, remaining, and failed skip-analysis items</caption>
        <thead className="sticky top-0 bg-[var(--loom-bg)]">
          <tr><th className="px-2 py-1">State</th><th className="px-2 py-1">Media</th><th className="px-2 py-1">Detail</th></tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const stateLabel = job.state === 'complete'
              ? 'completed'
              : job.state === 'error'
                ? 'failed'
                : job.state === 'pending'
                  ? 'remaining'
                  : job.state;
            return (
              <tr key={job.jobKey} className="border-t border-[var(--loom-border)]">
                <td className={`px-2 py-1 font-semibold ${
                  job.state === 'complete'
                    ? 'settings-status-available'
                    : job.state === 'error'
                      ? 'settings-status-error'
                      : ''
                }`}>{stateLabel}</td>
                <td className="px-2 py-1">{job.mediaId} S{job.season}E{job.episode}</td>
                <td className="px-2 py-1">{job.detail}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="flex items-center gap-2 text-sm text-white"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 accent-[var(--loom-accent)]" />{label}</label>;
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label className="text-xs text-[var(--loom-muted)]">{label}<input type="number" min={1} value={value} onChange={(event) => onChange(Math.max(1, Number(event.target.value) || 1))} className="mt-1 w-full rounded-md border border-[var(--loom-border)] bg-[var(--loom-bg)] px-2 py-1.5 text-sm text-white" /></label>;
}

function ListField({ label, value, onChange }: { label: string; value: string[]; onChange: (value: string[]) => void }) {
  return <label className="block text-xs text-[var(--loom-muted)]">{label}<textarea value={value.join('\n')} onChange={(event) => onChange(event.target.value.split(/\n|,/).map((entry) => entry.trim()).filter(Boolean))} rows={3} className="mt-1 w-full rounded-md border border-[var(--loom-border)] bg-[var(--loom-bg)] px-3 py-2 text-sm text-white" /></label>;
}

function SegmentGroup({
  title,
  description,
  types,
  settings,
  update,
}: {
  title: string;
  description: string;
  types: readonly ('intro' | 'recap' | 'credits' | 'preview')[];
  settings: SkipAnalysisSettings;
  update: (patch: Partial<SkipAnalysisSettings>) => void;
}) {
  return <section className="rounded-lg bg-[var(--loom-surface-2)] p-4"><h4 className="text-sm font-semibold text-[var(--loom-text)]">{title}</h4><p className="mt-1 text-xs text-[var(--loom-muted)]">{description}</p><div className="mt-3 space-y-3">{types.map((type) => <div key={type} className="rounded-md border border-[var(--loom-border)] p-3"><div className="flex items-center justify-between gap-3"><Toggle label={type[0].toUpperCase() + type.slice(1)} checked={settings.enabledTypes[type]} onChange={(checked) => update({ enabledTypes: { ...settings.enabledTypes, [type]: checked } })} /><Toggle label="Show skip prompt" checked={settings.promptTypes[type]} onChange={(checked) => update({ promptTypes: { ...settings.promptTypes, [type]: checked } })} /></div><div className="mt-3 grid grid-cols-2 gap-2"><NumberField label="Min seconds" value={settings.durationLimits[type].minSeconds} onChange={(minSeconds) => update({ durationLimits: { ...settings.durationLimits, [type]: { ...settings.durationLimits[type], minSeconds } } })} /><NumberField label="Max seconds" value={settings.durationLimits[type].maxSeconds} onChange={(maxSeconds) => update({ durationLimits: { ...settings.durationLimits, [type]: { ...settings.durationLimits[type], maxSeconds } } })} /></div></div>)}</div></section>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
