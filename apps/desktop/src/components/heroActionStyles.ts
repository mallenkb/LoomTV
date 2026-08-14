export const HERO_ACTION_GROUP_CLASS = 'inline-flex h-14 shrink-0 overflow-hidden rounded-full bg-white/10 backdrop-blur-[12px]';
/* The group is a dark chip in both themes, so hover darkens rather than using
   --loom-active-bg. That token is stone-200 in light mode and is written inline
   on :root, so it both looked wrong here and outranked any stylesheet fix. */
export const HERO_ACTION_SEGMENT_CLASS = 'transition-[background-color,border-radius] hover:!rounded-[8px] hover:!bg-black/40';
export const HERO_ACTION_FIRST_SEGMENT_CLASS = 'rounded-l-[4px] rounded-r-none';
export const HERO_ACTION_MIDDLE_SEGMENT_CLASS = 'rounded-[4px]';
export const HERO_ACTION_LAST_SEGMENT_CLASS = '!rounded-none';
export const HERO_ACTION_DIVIDER_CLASS = 'my-auto inline-block h-7 w-px bg-white/20';
