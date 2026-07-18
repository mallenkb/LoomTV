import React, { useId } from 'react';
import { cn } from '@/lib/utils';

export const PROFILE_COLOR_PRESETS: Record<string, [string, string]> = {
  ember: ['#fb923c', '#c2410c'],
  gold: ['#facc15', '#b45309'],
  crimson: ['#f87171', '#991b1b'],
  ocean: ['#38bdf8', '#1d4ed8'],
  violet: ['#a78bfa', '#6d28d9'],
  teal: ['#2dd4bf', '#0f766e'],
  rose: ['#fb7185', '#be185d'],
  slate: ['#94a3b8', '#334155'],
};

export const PROFILE_COLOR_KEYS = Object.keys(PROFILE_COLOR_PRESETS);
export const PROFILE_AVATAR_KEYS = Array.from({ length: 8 }, (_, index) => `weave-0${index + 1}`);

function avatarIndex(avatarKey: string): number {
  const match = /(\d+)$/.exec(avatarKey || '');
  const parsed = match ? Number.parseInt(match[1], 10) : 1;
  return Number.isFinite(parsed) && parsed > 0 ? (parsed - 1) % 8 : 0;
}

/**
 * Original LoomTV avatar art: a circular gradient with a woven-thread pattern
 * whose weave density and angle come from the avatar preset, plus the
 * profile's initial. No licensed artwork involved.
 */
export default function ProfileAvatar({
  name,
  avatarKey,
  colorKey,
  className,
}: {
  name: string;
  avatarKey: string;
  colorKey: string;
  className?: string;
}) {
  const gradientId = useId();
  const clipId = useId();
  const index = avatarIndex(avatarKey);
  const [from, to] = PROFILE_COLOR_PRESETS[colorKey] || PROFILE_COLOR_PRESETS.ember;
  const threadCount = 3 + (index % 4);
  const angle = index * 22.5;
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  const threads = Array.from({ length: threadCount }, (_, thread) => {
    const offset = ((thread + 1) / (threadCount + 1)) * 100;
    return offset;
  });

  return (
    <svg viewBox="0 0 100 100" className={cn('h-full w-full', className)} role="img" aria-label={`${name} avatar`}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={from} />
          <stop offset="100%" stopColor={to} />
        </linearGradient>
        <clipPath id={clipId}>
          <circle cx="50" cy="50" r="50" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <rect width="100" height="100" fill={`url(#${gradientId})`} />
        <g transform={`rotate(${angle} 50 50)`} opacity="0.28">
          {threads.map((offset) => (
            <rect key={`h-${offset}`} x="-20" y={offset - 3.5} width="140" height="7" rx="3.5" fill="#ffffff" />
          ))}
          {threads.map((offset) => (
            <rect key={`v-${offset}`} x={offset - 3.5} y="-20" width="7" height="140" rx="3.5" fill="#000000" opacity="0.35" />
          ))}
        </g>
        <text
          x="50"
          y="50"
          dy="0.36em"
          textAnchor="middle"
          fontSize="44"
          fontWeight="700"
          fill="#ffffff"
          style={{ fontFamily: 'inherit', paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.25)', strokeWidth: 2 }}
        >
          {initial}
        </text>
      </g>
    </svg>
  );
}
