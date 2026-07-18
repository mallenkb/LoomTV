import type { MediaSegment, MediaSegmentType } from '@/lib/desktopApi';

interface PlayerMarkerEditorProps {
  editorSegment?: MediaSegment;
  error: string | null;
  markerEnd: string;
  markerStart: string;
  markerType: MediaSegmentType;
  saving: boolean;
  onClose: () => void;
  onMarkerEndChange: (value: string) => void;
  onMarkerStartChange: (value: string) => void;
  onMarkerTypeChange: (value: MediaSegmentType) => void;
  onPreview: () => void;
  onReject: () => void;
  onRestore: () => void;
  canRestore: boolean;
  onReset: () => void;
  onSave: () => void;
  onUndo: () => void;
  onUseCurrentAsEnd: () => void;
  onUseCurrentAsStart: () => void;
}

export default function PlayerMarkerEditor({
  editorSegment,
  error,
  markerEnd,
  markerStart,
  markerType,
  saving,
  onClose,
  onMarkerEndChange,
  onMarkerStartChange,
  onMarkerTypeChange,
  onPreview,
  onReject,
  onRestore,
  canRestore,
  onReset,
  onSave,
  onUndo,
  onUseCurrentAsEnd,
  onUseCurrentAsStart,
}: PlayerMarkerEditorProps) {
  return (
    <div
      className="absolute inset-0 z-50 grid place-items-center bg-black/65 px-6 backdrop-blur-sm"
      onClick={(event) => event.stopPropagation()}
    >
      <section className="w-full max-w-md rounded-xl border border-white/15 bg-zinc-950 p-5 text-white shadow-2xl" role="dialog" aria-modal="true" aria-label="Edit skip marker">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Correct skip timing</h2>
            <p className="mt-1 text-xs text-white/55">Optional file-specific correction for automatic markers.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded px-2 py-1 text-white/65 hover:bg-white/10 hover:text-white" aria-label="Close marker editor">Close</button>
        </div>
        <label className="block text-xs font-medium uppercase tracking-wide text-white/60">
          Segment
          <select value={markerType} onChange={(event) => onMarkerTypeChange(event.target.value as MediaSegmentType)} className="mt-2 w-full rounded-md border border-white/15 bg-black px-3 py-2 text-sm text-white">
            <option value="intro">Intro</option>
            <option value="recap">Recap</option>
            <option value="outro">Outro</option>
            <option value="credits">Credits</option>
            <option value="preview">Preview</option>
          </select>
        </label>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="text-xs font-medium uppercase tracking-wide text-white/60">
            Start (seconds)
            <input value={markerStart} onChange={(event) => onMarkerStartChange(event.target.value)} inputMode="decimal" className="mt-2 w-full rounded-md border border-white/15 bg-black px-3 py-2 text-sm text-white" />
          </label>
          <label className="text-xs font-medium uppercase tracking-wide text-white/60">
            End (seconds)
            <input value={markerEnd} onChange={(event) => onMarkerEndChange(event.target.value)} inputMode="decimal" placeholder="End of video" className="mt-2 w-full rounded-md border border-white/15 bg-black px-3 py-2 text-sm text-white" />
          </label>
        </div>
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={onUseCurrentAsStart} className="rounded-md border border-white/15 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10">Use current as start</button>
          <button type="button" onClick={onUseCurrentAsEnd} className="rounded-md border border-white/15 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10">Use current as end</button>
        </div>
        {editorSegment && (
          <p className="mt-3 text-xs text-white/55">
            Current: {editorSegment.source} · {Math.round(editorSegment.confidence * 100)}% confidence
            {editorSegment.analysisMetadata?.detector ? ` · ${editorSegment.analysisMetadata.detector}` : ''}
            {editorSegment.analysisMetadata?.startSnap && editorSegment.analysisMetadata.startSnap !== 'original' ? ` · start snapped to ${editorSegment.analysisMetadata.startSnap}` : ''}
            {' · '}{new Date(editorSegment.updatedAt).toLocaleString()}
          </p>
        )}
        {error && <p className="mt-3 text-sm text-red-300" role="alert">{error}</p>}
        <div className="mt-5 flex items-center justify-between gap-3">
          <div className="flex gap-1">
            <button type="button" disabled={saving} onClick={onReset} className="rounded-md px-2 py-2 text-xs text-white/65 hover:bg-white/10 hover:text-white disabled:opacity-50">Reset</button>
            <button type="button" disabled={saving} onClick={onUndo} className="rounded-md px-2 py-2 text-xs text-white/65 hover:bg-white/10 hover:text-white disabled:opacity-50">Undo</button>
            {editorSegment?.source !== 'manual' && <button type="button" disabled={saving || !editorSegment} onClick={onReject} className="rounded-md px-2 py-2 text-xs text-red-300 hover:bg-white/10 disabled:opacity-50">Reject</button>}
            {canRestore && <button type="button" disabled={saving} onClick={onRestore} className="rounded-md px-2 py-2 text-xs text-emerald-300 hover:bg-white/10 disabled:opacity-50">Restore</button>}
          </div>
          <div className="flex gap-2">
            <button type="button" disabled={saving || !markerEnd.trim()} onClick={onPreview} className="rounded-md border border-white/15 px-3 py-2 text-sm text-white/80 hover:bg-white/10 disabled:opacity-40">Preview</button>
            <button type="button" disabled={saving} onClick={onSave} className="rounded-md bg-[var(--loom-accent)] px-4 py-2 text-sm font-semibold text-[var(--loom-accent-foreground)] hover:bg-[var(--loom-accent-hover)] disabled:opacity-50">{saving ? 'Saving…' : 'Save marker'}</button>
          </div>
        </div>
      </section>
    </div>
  );
}
