import { memo } from 'react';
import { ChevronLeft, X } from 'lucide-react';

type TopPlayerControlsProps = {
  visible: boolean;
  label: string;
  onBack: () => void;
  onClose: () => void;
};

function TopPlayerControls({ visible, label, onBack, onClose }: TopPlayerControlsProps) {
  const visibilityClass = visible ? 'opacity-100' : 'pointer-events-none opacity-0';

  return (
    <>
      <button
        onClick={(event) => {
          event.stopPropagation();
          onBack();
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        className={`loom-no-drag loom-player-top-control absolute left-6 z-40 flex h-10 items-center gap-2 rounded-lg border border-white/20 bg-black/55 px-3 text-sm text-white shadow-lg backdrop-blur-md transition-opacity duration-200 hover:bg-white/10 hover:text-[var(--loom-accent)] ${visibilityClass}`}
        aria-label="Back"
      >
        <ChevronLeft className="w-4 h-4" />
        Back
      </button>

      <div className={`loom-no-drag loom-player-top-control pointer-events-none absolute left-1/2 z-40 max-w-[60%] -translate-x-1/2 rounded-full border border-white/10 bg-black/35 px-4 py-1.5 text-center text-xs font-medium text-white/80 shadow-lg backdrop-blur-md transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`}>
        <span className="block truncate">{label}</span>
      </div>

      <button
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        className={`loom-no-drag loom-player-top-control absolute right-6 z-40 grid h-10 w-10 place-items-center rounded-lg border border-white/20 bg-black/55 text-white shadow-lg backdrop-blur-md transition-opacity duration-200 hover:bg-white/10 hover:text-[var(--loom-accent)] ${visibilityClass}`}
        title="Close player"
        aria-label="Close player"
      >
        <X className="h-4 w-4" />
      </button>
    </>
  );
}

export default memo(TopPlayerControls);
