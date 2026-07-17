import { useState } from 'react';
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
  onAnalysisAction: (action: 'run' | 'pause' | 'resume' | 'cancel' | 'cleanup' | 'rebuild', scope?: { mediaId?: string; season?: number }) => void;
  onSave: () => void | Promise<void>;
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
  const [scopeMediaId, setScopeMediaId] = useState('');
  const [scopeSeason, setScopeSeason] = useState('');
  const update = (patch: Partial<SkipAnalysisSettings>) => onSkipAnalysisChange({ ...skipAnalysis, ...patch });
  const manuallyScan = async (scope?: { mediaId?: string; season?: number }) => {
    await onSave();
    onAnalysisAction('run', scope);
  };
  const statusText = !analysisStatus
    ? 'Checking local analysis helpers…'
    : `${STATE_LABELS[analysisStatus.state] || analysisStatus.state}${analysisStatus.pendingCount ? ` · ${analysisStatus.pendingCount} pending` : ''}`;

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
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-[var(--loom-border)] bg-black/15 p-4">
            <label className="flex items-center gap-3 text-sm font-medium text-white">
              <input
                type="checkbox"
                checked={skipAnalysis.enabled}
                onChange={(event) => update(event.target.checked
                  ? { enabled: true, analyzeNewMedia: true }
                  : { enabled: false })}
                className="h-5 w-5 accent-[var(--loom-accent)]"
              />
              Automatically detect and mark intros &amp; outros
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={() => void manuallyScan()}>Scan library now</Button>
              <Button type="button" variant="outline" onClick={onSave}>Save</Button>
            </div>
          </div>

          <div className="text-xs text-[var(--loom-muted)]">
            <p>{statusText}</p>
            {analysisStatus?.currentJob && <p className="mt-1">{analysisStatus.currentJob.detail}</p>}
            {analysisStatus?.lastError && <p role="alert" className="mt-1 text-red-300">{analysisStatus.lastError}</p>}
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((value) => !value)}
              className="text-xs font-medium text-[var(--loom-muted)] underline-offset-2 hover:text-white hover:underline"
            >
              {showAdvanced ? 'Hide advanced options' : 'Show advanced options'}
            </button>
          </div>

          {showAdvanced && (
            <div className="space-y-5 rounded-lg border border-[var(--loom-border)] bg-black/10 p-4">
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

              <div className="rounded-lg border border-[var(--loom-border)] bg-black/15 p-4">
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
                  <Button type="button" variant="outline" disabled={!scopeMediaId.trim()} onClick={() => void manuallyScan({ mediaId: scopeMediaId.trim(), season: Math.max(0, Number(scopeSeason) || 0) })}>Save &amp; scan season</Button>
                </div>
                {!!analysisStatus?.recentJobs?.length && <div className="mt-4 max-h-36 overflow-y-auto rounded-md border border-white/10"><table className="w-full text-left text-xs text-[var(--loom-muted)]"><thead><tr><th className="px-2 py-1">State</th><th className="px-2 py-1">Media</th><th className="px-2 py-1">Detail</th></tr></thead><tbody>{analysisStatus.recentJobs.map((job) => <tr key={job.jobKey} className="border-t border-white/10"><td className="px-2 py-1">{job.state}</td><td className="px-2 py-1">{job.mediaId} S{job.season}E{job.episode}</td><td className="px-2 py-1">{job.detail}</td></tr>)}</tbody></table></div>}
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
  return <section className="rounded-lg border border-[var(--loom-border)] bg-black/15 p-4"><h4 className="text-sm font-semibold text-white">{title}</h4><p className="mt-1 text-xs text-[var(--loom-muted)]">{description}</p><div className="mt-3 space-y-3">{types.map((type) => <div key={type} className="rounded-md border border-white/10 p-3"><div className="flex items-center justify-between gap-3"><Toggle label={type[0].toUpperCase() + type.slice(1)} checked={settings.enabledTypes[type]} onChange={(checked) => update({ enabledTypes: { ...settings.enabledTypes, [type]: checked } })} /><Toggle label="Show skip prompt" checked={settings.promptTypes[type]} onChange={(checked) => update({ promptTypes: { ...settings.promptTypes, [type]: checked } })} /></div><div className="mt-3 grid grid-cols-2 gap-2"><NumberField label="Min seconds" value={settings.durationLimits[type].minSeconds} onChange={(minSeconds) => update({ durationLimits: { ...settings.durationLimits, [type]: { ...settings.durationLimits[type], minSeconds } } })} /><NumberField label="Max seconds" value={settings.durationLimits[type].maxSeconds} onChange={(maxSeconds) => update({ durationLimits: { ...settings.durationLimits, [type]: { ...settings.durationLimits[type], maxSeconds } } })} /></div></div>)}</div></section>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
