import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SettingsActions, SettingsDisclosure, SettingsField, SettingsGroup, SettingsNote, SettingsPageHeader, SettingsRow, SettingsSelect, SettingsStatus, SettingsSwitch } from '@/components/settings/SettingsLayout';
import type { LibVlcAvailability, LocalSegmentAnalysisStatus, MpvAvailability, SkipAnalysisSettings } from '@/lib/desktopApi';
import SkipTimestampManager from './SkipTimestampManager';

type PlaybackSettingsSectionProps = {
  showServerControls?: boolean;
  rewindOnResumeSeconds: number;
  skipBackSeconds: number;
  skipForwardSeconds: number;
  displaySleepTimeoutMinutes: number;
  /** Seek and resume choices save as soon as they change. */
  onPlaybackPreferenceChange: (key: 'skipBackSeconds' | 'skipForwardSeconds' | 'rewindOnResumeSeconds', value: number) => void;
  onDisplaySleepTimeoutChange: (minutes: number) => void;
  displaySleepSettingsAvailable: boolean;
  skipAnalysis: SkipAnalysisSettings;
  /** Draft change, saved by Save or a scan. Used for typed fields. */
  onSkipAnalysisChange: (value: SkipAnalysisSettings) => void;
  /** Immediate change and save. Used for switches. */
  onSkipAnalysisCommit: (value: SkipAnalysisSettings) => void;
  analysisStatus: LocalSegmentAnalysisStatus | null;
  onAnalysisAction: (
    action: 'run' | 'pause' | 'resume' | 'cancel' | 'cancel-manual' | 'cleanup' | 'rebuild',
    scope?: { mediaId?: string; season?: number; mode?: 'quick' | 'full' },
  ) => Promise<{ queued: number } | undefined> | void;
  onSave: () => void | boolean | Promise<void | boolean>;
  libvlcAvailability?: LibVlcAvailability | null;
  mpvAvailability?: MpvAvailability | null;
  ffmpegStatus?: { available: boolean; path: string | null } | null;
  onLibvlcRefresh?: () => void | Promise<void>;
  onMpvRefresh?: () => void | Promise<void>;
  onFfmpegRefresh?: () => void | Promise<void>;
};

const INTRO_TYPES = ['intro', 'recap'] as const;
const OUTRO_TYPES = ['outro', 'credits', 'preview'] as const;

const STATE_LABELS: Record<string, string> = {
  idle: 'Idle, markers up to date',
  queued: 'Queued',
  running: 'Analyzing…',
  paused: 'Paused',
  disabled: 'Off',
  unavailable: 'Unavailable',
  error: 'Needs attention',
};

export default function PlaybackSettingsSection({
  showServerControls = true,
  rewindOnResumeSeconds,
  skipBackSeconds,
  skipForwardSeconds,
  displaySleepTimeoutMinutes,
  onPlaybackPreferenceChange,
  onDisplaySleepTimeoutChange,
  displaySleepSettingsAvailable,
  skipAnalysis,
  onSkipAnalysisChange,
  onSkipAnalysisCommit,
  analysisStatus,
  onAnalysisAction,
  onSave,
  libvlcAvailability = null,
  mpvAvailability = null,
  ffmpegStatus = null,
  onLibvlcRefresh,
  onMpvRefresh,
  onFfmpegRefresh,
}: PlaybackSettingsSectionProps) {
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
  const commit = (patch: Partial<SkipAnalysisSettings>) => onSkipAnalysisCommit({ ...skipAnalysis, ...patch });
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
          : 'Everything is already analyzed. Nothing new to scan.'
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

  const engines = [
    { name: 'LibVLC', available: libvlcAvailability?.available, checking: libvlcAvailability === null, refresh: onLibvlcRefresh },
    { name: 'libmpv', available: mpvAvailability?.available, checking: mpvAvailability === null, refresh: onMpvRefresh },
    { name: 'FFmpeg', available: ffmpegStatus?.available, checking: ffmpegStatus === null, refresh: onFfmpegRefresh },
  ];
  const missingEngines = engines.filter((engine) => !engine.checking && !engine.available);
  const checkingEngines = engines.some((engine) => engine.checking);

  return (
    <div>
      <SettingsPageHeader title="Playback" description="Seek buttons, resuming, and automatic intro and outro skipping." />
      <SettingsGroup title="Controls">
        <SettingsRow title="Skip back" description="How far the back button and left arrow jump.">
          <SettingsSelect label="Skip back" value={skipBackSeconds} options={secondsOptions(SEEK_CHOICES, skipBackSeconds)} onChange={(value) => onPlaybackPreferenceChange('skipBackSeconds', value)} className="w-32" />
        </SettingsRow>
        <SettingsRow title="Skip forward" description="How far the forward button and right arrow jump.">
          <SettingsSelect label="Skip forward" value={skipForwardSeconds} options={secondsOptions(SEEK_CHOICES, skipForwardSeconds)} onChange={(value) => onPlaybackPreferenceChange('skipForwardSeconds', value)} className="w-32" />
        </SettingsRow>
        <SettingsRow title="Rewind on resume" description="Replay a few seconds when you resume after a pause. Live TV is excluded.">
          <SettingsSelect label="Rewind on resume" value={rewindOnResumeSeconds} options={secondsOptions(REWIND_CHOICES, rewindOnResumeSeconds, 'Off')} onChange={(value) => onPlaybackPreferenceChange('rewindOnResumeSeconds', value)} className="w-32" />
        </SettingsRow>
        {displaySleepSettingsAvailable ? (
          <SettingsRow title="Keep display awake" description="While a video plays. Pausing lets the display sleep.">
            <SettingsSelect
              label="Keep display awake"
              value={displaySleepTimeoutMinutes}
              options={withCurrent(DISPLAY_SLEEP_CHOICES, displaySleepTimeoutMinutes, (minutes) => `${minutes} min`)}
              onChange={onDisplaySleepTimeoutChange}
              className="w-32"
            />
          </SettingsRow>
        ) : null}
      </SettingsGroup>

      {showServerControls ? (
        <SettingsGroup title="Intro and outro skipping">
          <SettingsRow title="Detect intros and outros" description="Find them automatically and show a skip button during playback.">
            <SettingsSwitch
              label="Detect intros and outros"
              checked={skipAnalysis.enabled}
              onChange={(enabled) => commit(enabled ? { enabled: true, analyzeNewMedia: true } : { enabled: false })}
            />
          </SettingsRow>

          {skipAnalysis.enabled ? (
            <>
              {scanActive ? (
                <div className="settings-row space-y-2 px-4 py-3.5" aria-live="polite">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium text-[var(--loom-text)]">
                      {analysisStatus?.paused ? 'Paused' : manualScanActive ? 'Analyzing library…' : 'Automatic analysis running…'}
                    </span>
                    <span className="flex items-center gap-3 text-xs text-[var(--loom-muted)]">
                      {percent}% · {remaining} left
                      {manualScanActive ? <Button type="button" variant="outline" size="sm" onClick={stopScan}>Stop</Button> : null}
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-valuenow={percent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Skip analysis progress"
                    className="h-1.5 overflow-hidden rounded-full bg-[var(--loom-surface-3)]"
                  >
                    <div className="h-full rounded-full bg-[var(--loom-accent)] transition-[width] duration-700 ease-out" style={{ width: `${Math.max(percent, 2)}%` }} />
                  </div>
                  {analysisStatus?.currentJob ? <p className="text-xs text-[var(--loom-muted)]">{analysisStatus.currentJob.detail}</p> : null}
                  {showProgress && phase ? (
                    <p className="text-xs text-[var(--loom-muted)]">Current phase: {phase.completed} of {phase.total} {phase.phase === 'fingerprinting' ? 'fingerprinted' : 'matched'}</p>
                  ) : null}
                  {analysisStatus?.lastError ? <p role="alert" className="settings-status-error text-xs">{analysisStatus.lastError}</p> : null}
                  {analysisStatus?.recentJobs?.length ? (
                    <button
                      type="button"
                      aria-expanded={showProgress}
                      aria-controls="skip-analysis-progress-list"
                      onClick={() => setShowProgress((value) => !value)}
                      className="text-xs font-medium text-[var(--loom-accent)] hover:underline"
                    >
                      {showProgress ? 'Hide items' : 'Show items'}
                    </button>
                  ) : null}
                  {showProgress && analysisStatus?.recentJobs?.length ? <AnalysisProgressList jobs={analysisStatus.recentJobs} /> : null}
                </div>
              ) : (
                <SettingsRow
                  title="Library coverage"
                  description={(
                    <>
                      {coverage
                        ? `${coverage.analyzed} of ${coverage.total} items analyzed${coverageWaiting > 0 ? ` · ${coverageWaiting} waiting for more episodes` : ''}${coverageRemaining > 0 ? ` · ${coverageRemaining} remaining` : coverageWaiting === 0 ? ' · all caught up' : ''}`
                        : statusText}
                      {scanNotice ? <span className="mt-0.5 block settings-status-available">{scanNotice}</span> : null}
                      {analysisStatus?.lastError ? <span role="alert" className="mt-0.5 block settings-status-error">{analysisStatus.lastError}</span> : null}
                      {coordinatorDisabled && manualRemaining > 0 ? <span className="mt-0.5 block">{manualRemaining} unfinished manual item{manualRemaining === 1 ? '' : 's'} will resume when analysis is on.</span> : null}
                    </>
                  )}
                >
                  <Button type="button" variant="outline" size="sm" onClick={() => void manuallyScan({ mode: 'quick' })}>Scan now</Button>
                </SettingsRow>
              )}

              <SettingsRow title="Scan new media automatically" description="Analyze new or changed episodes after each library sync.">
                <SettingsSwitch label="Scan new media automatically" checked={skipAnalysis.analyzeNewMedia} onChange={(analyzeNewMedia) => commit({ analyzeNewMedia })} />
              </SettingsRow>

            </>
          ) : null}
        </SettingsGroup>
      ) : null}

      {showServerControls && skipAnalysis.enabled ? (
        <SettingsGroup
          title="Advanced skipping"
          description="Section types, length limits, exclusions, maintenance, and manual markers."
          collapsible
          storageKey="playback-advanced"
        >
          <SettingsRow title="Analyze Season 0 specials">
            <SettingsSwitch label="Analyze Season 0 specials" checked={skipAnalysis.analyzeSpecials} onChange={(analyzeSpecials) => commit({ analyzeSpecials })} />
          </SettingsRow>
          <SettingsRow title="Skip intro detection on first episodes" description="A season's first episode often has a unique opening.">
            <SettingsSwitch label="Skip intro detection on first episodes" checked={skipAnalysis.suppressFirstEpisodeIntro} onChange={(suppressFirstEpisodeIntro) => commit({ suppressFirstEpisodeIntro })} />
          </SettingsRow>
          <SettingsRow title="Use SkipDB" description="Experimental. Uses community markers when local analysis finds none.">
            <SettingsSwitch label="Use SkipDB" checked={skipAnalysis.experimentalProviders?.skipdb ?? false} onChange={(skipdb) => commit({ experimentalProviders: { ...skipAnalysis.experimentalProviders, skipdb } })} />
          </SettingsRow>

          <SettingsDisclosure title="Section types" description="Which sections to detect, when to show a skip button, and their length limits.">
            <SegmentGroup title="Intro and recap" types={INTRO_TYPES} settings={skipAnalysis} update={update} />
            <SegmentGroup title="Outro, credits, and preview" types={OUTRO_TYPES} settings={skipAnalysis} update={update} />
          </SettingsDisclosure>

          <SettingsDisclosure title="Exclusions" description="Series, movies, seasons, and folders that are never analyzed.">
            <div className="grid gap-3 py-2 lg:grid-cols-2">
              <ListField label="Excluded series IDs" value={skipAnalysis.exclusions.seriesIds} onChange={(seriesIds) => update({ exclusions: { ...skipAnalysis.exclusions, seriesIds } })} />
              <ListField label="Excluded movie IDs" value={skipAnalysis.exclusions.movieIds} onChange={(movieIds) => update({ exclusions: { ...skipAnalysis.exclusions, movieIds } })} />
              <ListField label="Excluded seasons (mediaId:season)" value={skipAnalysis.exclusions.seasons} onChange={(seasons) => update({ exclusions: { ...skipAnalysis.exclusions, seasons } })} />
              <ListField label="Excluded local paths" value={skipAnalysis.exclusions.paths} onChange={(paths) => update({ exclusions: { ...skipAnalysis.exclusions, paths } })} />
            </div>
          </SettingsDisclosure>

          <SettingsDisclosure
            title="Maintenance"
            description={`${(analysisStatus?.fingerprintCount || 0).toLocaleString()} cached fingerprints · ${formatBytes(analysisStatus?.fingerprintCacheBytes || 0)}${analysisStatus?.progress ? ` · ${analysisStatus.progress.complete}/${analysisStatus.progress.total} jobs complete` : ''}`}
          >
            <SettingsRow title="Rescan entire library" description="Analyze every episode again, including ones with markers.">
              <Button type="button" variant="outline" size="sm" disabled={manualScanActive} onClick={() => void manuallyScan({ mode: 'full' })}>Rescan</Button>
            </SettingsRow>
            <SettingsRow title="Scan one season">
              <div className="flex flex-wrap items-end gap-2">
                <SettingsField label="Media ID" value={scopeMediaId} onChange={(event) => setScopeMediaId(event.target.value)} placeholder="Media ID" className="w-48" />
                <SettingsField label="Season" value={scopeSeason} onChange={(event) => setScopeSeason(event.target.value)} type="number" min={0} placeholder="1" className="w-20" />
                <Button type="button" variant="outline" size="sm" disabled={!scopeMediaId.trim()} onClick={() => void manuallyScan({ mediaId: scopeMediaId.trim(), season: Math.max(0, Number(scopeSeason) || 0) })}>Scan season</Button>
              </div>
            </SettingsRow>
            <SettingsRow title={analysisStatus?.paused ? 'Resume analysis' : 'Pause analysis'} description="Queued work waits until you resume.">
              <Button type="button" variant="outline" size="sm" onClick={() => onAnalysisAction(analysisStatus?.paused ? 'resume' : 'pause')}>{analysisStatus?.paused ? 'Resume' : 'Pause'}</Button>
            </SettingsRow>
            <SettingsRow title="Cancel queued analysis">
              <Button type="button" variant="outline" size="sm" onClick={() => onAnalysisAction('cancel')}>Cancel queued</Button>
            </SettingsRow>
            <SettingsRow title="Clear stale cache" description="Remove fingerprints for files that are gone.">
              <Button type="button" variant="outline" size="sm" onClick={() => onAnalysisAction('cleanup')}>Clear</Button>
            </SettingsRow>
            <SettingsRow title="Rebuild automatic markers" description="Discard detected markers and detect them again. Manual markers stay.">
              <Button type="button" variant="outline" size="sm" onClick={() => onAnalysisAction('rebuild')}>Rebuild</Button>
            </SettingsRow>
          </SettingsDisclosure>

          <SettingsDisclosure title="Manual markers" description="Set intro and outro times yourself for a title." onOpenChange={setShowManual}>
            {showManual ? (
              <div id="playback-manual-markers" className="py-2">
                <SkipTimestampManager
                  settings={skipAnalysis}
                  onSettingsChange={onSkipAnalysisChange}
                  onRun={(scope) => onAnalysisAction('run', scope)}
                  onSaveSettings={onSave}
                />
              </div>
            ) : null}
          </SettingsDisclosure>

          <SettingsActions start="Section types and exclusions save when you press Save.">
            <Button type="button" size="sm" onClick={() => void onSave()}>Save</Button>
          </SettingsActions>
        </SettingsGroup>
      ) : null}

      {checkingEngines || missingEngines.length ? (
        <SettingsGroup title="Playback engines">
          {checkingEngines ? <SettingsNote role="status">Checking playback engines…</SettingsNote> : null}
          {missingEngines.map((engine) => (
            <SettingsRow key={engine.name} title={engine.name} description={<SettingsStatus tone="warning">Unavailable</SettingsStatus>}>
              {engine.refresh ? <Button type="button" variant="outline" size="sm" onClick={() => void engine.refresh?.()}>Check again</Button> : null}
            </SettingsRow>
          ))}
        </SettingsGroup>
      ) : null}
    </div>
  );
}

const SEEK_CHOICES = [5, 10, 15, 20, 30, 45, 60];
const REWIND_CHOICES = [0, 1, 2, 3, 5, 10, 15, 20, 30];
const DISPLAY_SLEEP_CHOICES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'Always' },
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 45, label: '45 min' },
  { value: 60, label: '1 hour' },
  { value: 90, label: '1.5 hours' },
  { value: 120, label: '2 hours' },
];

/** Keeps a saved value that is not one of the presets selectable. */
function withCurrent(choices: ReadonlyArray<{ value: number; label: string }>, current: number, label: (value: number) => string) {
  if (choices.some((choice) => choice.value === current)) return choices;
  return [...choices, { value: current, label: label(current) }].sort((left, right) => left.value - right.value);
}

function secondsOptions(choices: number[], current: number, zeroLabel?: string) {
  return withCurrent(
    choices.map((seconds) => ({ value: seconds, label: seconds === 0 && zeroLabel ? zeroLabel : `${seconds} sec` })),
    current,
    (seconds) => `${seconds} sec`,
  );
}

type ProgressJob = NonNullable<LocalSegmentAnalysisStatus['recentJobs']>[number];

function AnalysisProgressList({ jobs }: { jobs: ProgressJob[] }) {
  return (
    <div id="skip-analysis-progress-list" className="mt-3 max-h-52 overflow-y-auto rounded-md border border-[var(--loom-border)]">
      <table className="w-full text-left text-xs text-[var(--loom-muted)]">
        <caption className="sr-only">Completed, remaining, and failed skip-analysis items</caption>
        <thead className="sticky top-0 bg-[var(--loom-settings-card-bg)]">
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

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <SettingsField label={label} type="number" min={1} value={value} onChange={(event) => onChange(Math.max(1, Number(event.target.value) || 1))} className="w-28" />;
}

function ListField({ label, value, onChange }: { label: string; value: string[]; onChange: (value: string[]) => void }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-xs font-medium text-[var(--loom-muted)]">{label}</span>
      <textarea
        value={value.join('\n')}
        onChange={(event) => onChange(event.target.value.split(/\n|,/).map((entry) => entry.trim()).filter(Boolean))}
        rows={3}
        placeholder="One per line"
        className="w-full rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-bg)] px-3 py-2 text-sm text-[var(--loom-text)] outline-none placeholder:text-[var(--loom-faint)] focus:border-[var(--loom-accent)]"
      />
    </label>
  );
}

const SEGMENT_LABELS: Record<'intro' | 'recap' | 'outro' | 'credits' | 'preview', string> = {
  intro: 'Intro',
  recap: 'Recap',
  outro: 'Outro',
  credits: 'Credits',
  preview: 'Preview',
};

function SegmentGroup({
  title,
  types,
  settings,
  update,
}: {
  title: string;
  types: readonly ('intro' | 'recap' | 'outro' | 'credits' | 'preview')[];
  settings: SkipAnalysisSettings;
  update: (patch: Partial<SkipAnalysisSettings>) => void;
}) {
  return (
    <section className="py-2">
      <h3 className="pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--loom-faint)]">{title}</h3>
      <div className="divide-y divide-[var(--loom-settings-divider)]">
        {types.map((type) => (
          <div key={type} className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 py-3">
            <div className="min-w-0 flex-1 basis-40 space-y-2">
              <div className="flex items-center gap-3">
                <SettingsSwitch label={`Detect ${SEGMENT_LABELS[type].toLowerCase()}`} checked={settings.enabledTypes[type]} onChange={(checked) => update({ enabledTypes: { ...settings.enabledTypes, [type]: checked } })} />
                <span className="text-sm font-medium text-[var(--loom-text)]">{SEGMENT_LABELS[type]}</span>
              </div>
              <label className="flex items-center gap-2 text-xs text-[var(--loom-muted)]">
                <input
                  type="checkbox"
                  checked={settings.promptTypes[type]}
                  disabled={!settings.enabledTypes[type]}
                  onChange={(event) => update({ promptTypes: { ...settings.promptTypes, [type]: event.target.checked } })}
                  className="h-3.5 w-3.5 accent-[var(--loom-accent)]"
                />
                Show a skip button
              </label>
            </div>
            <div className="flex gap-2">
              <NumberField label="Min seconds" value={settings.durationLimits[type].minSeconds} onChange={(minSeconds) => update({ durationLimits: { ...settings.durationLimits, [type]: { ...settings.durationLimits[type], minSeconds } } })} />
              <NumberField label="Max seconds" value={settings.durationLimits[type].maxSeconds} onChange={(maxSeconds) => update({ durationLimits: { ...settings.durationLimits, [type]: { ...settings.durationLimits[type], maxSeconds } } })} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
