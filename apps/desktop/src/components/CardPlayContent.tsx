import { Play } from 'lucide-react';

export const CARD_PLAY_ACTION_CLASS = 'loom-poster-play-action inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-white px-3.5 text-sm font-semibold text-black shadow-xl transition-transform duration-200 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] disabled:cursor-default disabled:opacity-70 motion-reduce:transition-none';
export const CARD_PLAY_OVERLAY_CLASS = 'absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none';

export default function CardPlayContent({ label = 'Play' }: { label?: string }) {
  return <><Play aria-hidden="true" className="h-4 w-4 fill-current" /><span>{label}</span></>;
}
