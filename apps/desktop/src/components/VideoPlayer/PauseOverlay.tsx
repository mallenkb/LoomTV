import { memo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Star } from 'lucide-react';
import { epCode } from './helpers';

type PauseOverlayProps = {
  visible: boolean;
  title: string;
  logoSources: string[];
  hasEpisodes: boolean;
  currentSeason: number;
  currentEpisode: number;
  episodeTitle: string;
  rating: number;
};

function PauseOverlay({
  visible,
  title,
  logoSources,
  hasEpisodes,
  currentSeason,
  currentEpisode,
  episodeTitle,
  rating,
}: PauseOverlayProps) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="pause-overlay"
          className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
          aria-hidden="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        >
          <motion.div
            className="absolute inset-0 bg-black/65"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          />
          <motion.div
            className="absolute bottom-32 left-6 right-6 flex max-w-2xl flex-col items-start text-white sm:bottom-36"
            initial={{ opacity: 0, y: 18, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.995 }}
            transition={{ duration: 0.48, ease: [0.22, 1, 0.36, 1] }}
          >
            {logoSources.length > 0 ? (
              <img
                src={logoSources[0]}
                alt={title}
                className="mb-4 h-40 max-h-[28vh] w-[min(48rem,84vw)] object-contain object-left-bottom drop-shadow-[0_3px_18px_rgba(0,0,0,0.75)]"
                onError={(event) => {
                  event.currentTarget.style.display = 'none';
                }}
              />
            ) : (
              <h2 className="mb-2 max-w-[min(34rem,78vw)] text-4xl font-black uppercase leading-none tracking-normal drop-shadow-[0_3px_18px_rgba(0,0,0,0.75)] sm:text-5xl">
                {title}
              </h2>
            )}
            {(hasEpisodes || episodeTitle) && (
              <div className="flex max-w-3xl min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-white">
                {hasEpisodes && (
                  <span className="shrink-0 text-[24px] font-semibold leading-tight text-white/85">
                    {epCode(currentSeason, currentEpisode)}
                  </span>
                )}
                {episodeTitle && (
                  <span className="min-w-[8rem] flex-1 truncate text-[24px] font-bold leading-tight">
                    {episodeTitle}
                  </span>
                )}
                {rating > 0 && (
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[#f5c451]/15 px-3 py-1 text-sm font-bold leading-none text-[#f5c451] shadow-[0_4px_16px_rgba(0,0,0,0.35)]">
                    <Star className="h-4 w-4 fill-current" />
                    {rating.toFixed(1)}
                  </span>
                )}
              </div>
            )}
            {rating > 0 && !hasEpisodes && !episodeTitle && (
              <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[#f5c451]/15 px-3 py-1 text-sm font-bold text-[#f5c451] shadow-[0_4px_16px_rgba(0,0,0,0.35)]">
                <Star className="h-4 w-4 fill-current" />
                {rating.toFixed(1)}
              </span>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default memo(PauseOverlay);
