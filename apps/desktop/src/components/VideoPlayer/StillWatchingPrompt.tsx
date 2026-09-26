interface StillWatchingPromptProps {
  title: string;
  onContinue: () => void;
  onStop: () => void;
}

/** Shown instead of starting the next episode after a run with no input. */
export default function StillWatchingPrompt({ title, onContinue, onStop }: StillWatchingPromptProps) {
  return (
    <div
      role="alertdialog"
      aria-labelledby="still-watching-title"
      className="pointer-events-auto absolute inset-0 z-[60] flex items-center justify-center bg-black/70"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className="max-w-md px-6 text-center">
        <h2 id="still-watching-title" className="text-2xl font-semibold text-white">Are you still watching?</h2>
        {title ? <p className="mt-2 text-sm text-white/70">{title}</p> : null}
        <div className="mt-6 flex justify-center gap-3">
          <button
            type="button"
            autoFocus
            onClick={onContinue}
            className="rounded-lg bg-white px-6 py-2.5 text-sm font-bold text-black outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-black"
          >
            Continue watching
          </button>
          <button
            type="button"
            onClick={onStop}
            className="rounded-lg border border-white/30 px-6 py-2.5 text-sm text-white outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white"
          >
            Stop
          </button>
        </div>
      </div>
    </div>
  );
}
