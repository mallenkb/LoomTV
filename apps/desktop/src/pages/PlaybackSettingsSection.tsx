import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type PlaybackSettingsSectionProps = {
  skipBackSeconds: number;
  skipForwardSeconds: number;
  onSkipBackChange: (value: number) => void;
  onSkipForwardChange: (value: number) => void;
  localSkipAnalysisEnabled: boolean;
  onLocalSkipAnalysisChange: (value: boolean) => void;
  localAnalysisStatus: string;
  onSave: () => void;
};

export default function PlaybackSettingsSection({
  skipBackSeconds,
  skipForwardSeconds,
  onSkipBackChange,
  onSkipForwardChange,
  localSkipAnalysisEnabled,
  onLocalSkipAnalysisChange,
  localAnalysisStatus,
  onSave,
}: PlaybackSettingsSectionProps) {
  return (
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
            <input
              type="number"
              min={1}
              step={1}
              value={skipBackSeconds}
              onChange={(event) => onSkipBackChange(Number(event.target.value))}
              className="w-full rounded-lg border border-[var(--loom-border)] bg-[var(--loom-bg)] px-3 py-2 text-sm text-white outline-none"
            />
          </label>
          <label className="space-y-2">
            <span className="text-sm font-medium text-white">Forward skip seconds</span>
            <input
              type="number"
              min={1}
              step={1}
              value={skipForwardSeconds}
              onChange={(event) => onSkipForwardChange(Number(event.target.value))}
              className="w-full rounded-lg border border-[var(--loom-border)] bg-[var(--loom-bg)] px-3 py-2 text-sm text-white outline-none"
            />
          </label>
        </div>
        <div className="mt-5 rounded-lg border border-[var(--loom-border)] bg-black/15 p-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={localSkipAnalysisEnabled}
              onChange={(event) => onLocalSkipAnalysisChange(event.target.checked)}
              className="mt-1 h-4 w-4 accent-[var(--loom-accent)]"
            />
            <span>
              <span className="block text-sm font-medium text-white">Automatic local intro and credits analysis</span>
              <span className="mt-1 block text-xs leading-5 text-[var(--loom-muted)]">
                Fills provider gaps after library scans. One bounded background worker runs only while idle on AC power and pauses for playback or transcoding.
              </span>
            </span>
          </label>
          <p className="mt-3 break-all text-xs text-[var(--loom-muted)]">{localAnalysisStatus}</p>
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={onSave}>Save playback settings</Button>
        </div>
      </CardContent>
    </Card>
  );
}
