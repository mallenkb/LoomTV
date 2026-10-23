import SafeArtwork from './SafeArtwork';

/** Shared by local and add-on movie and television detail pages. */
export default function DetailCastRail({ cast }: {
  cast: readonly { name: string; character?: string; image?: string }[];
}) {
  return (
    <div className="flex gap-4 overflow-x-auto pb-2">
      {cast.slice(0, 12).map((actor, index) => (
        <div key={`${actor.name}:${index}`} className="w-20 flex-shrink-0 text-center">
          <SafeArtwork
            src={actor.image || ''}
            alt={actor.name}
            className="mx-auto mb-2 h-16 w-16 overflow-hidden rounded-full"
            imgClassName="object-cover"
            fallback={<div className="flex h-full w-full items-center justify-center bg-[var(--loom-surface-3)] text-xs text-[var(--loom-text)]">{actor.name.charAt(0)}</div>}
          />
          <p className="truncate text-xs text-[var(--loom-text)]" title={actor.name}>{actor.name}</p>
          <p className="truncate text-xs text-[var(--loom-muted)]" title={actor.character}>{actor.character}</p>
        </div>
      ))}
    </div>
  );
}
