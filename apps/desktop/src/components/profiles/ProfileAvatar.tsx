import { cn } from '@/lib/utils';

export const PROFILE_COLOR_PRESETS: Record<string, string> = {
  ember: '#f97316',
  gold: '#f59e0b',
  crimson: '#dc3f4f',
  ocean: '#207ce5',
  violet: '#8551dc',
  teal: '#24a9a1',
  rose: '#de3d72',
  slate: '#64748b',
};

export const PROFILE_COLOR_KEYS = Object.keys(PROFILE_COLOR_PRESETS);
export const PROFILE_AVATAR_KEYS = Array.from({ length: 12 }, (_, index) => `glyph-${String(index + 1).padStart(2, '0')}`);

function glyphVariant(avatarKey: string): number {
  const match = /(?:glyph|weave)-(\d+)$/.exec(avatarKey);
  const parsed = match ? Number.parseInt(match[1], 10) : 1;
  return Number.isFinite(parsed) && parsed > 0 ? ((parsed - 1) % 12) + 1 : 1;
}

export function profileAvatarUrl(avatarKey: string, colorKey = 'ember'): string {
  if (avatarKey.startsWith('data:image/')) return avatarKey;
  const variant = String(glyphVariant(avatarKey)).padStart(2, '0');
  const color = PROFILE_COLOR_PRESETS[colorKey] || PROFILE_COLOR_PRESETS.ember;
  const params = new URLSearchParams({
    seed: `loomtv-glyph-${variant}`,
    shapeVariant: `variant${variant}`,
    backgroundColor: color.slice(1),
    backgroundColorFill: 'solid',
    glyphColor: color.slice(1),
    glyphColorFill: 'solid',
  });
  return `https://api.dicebear.com/10.x/glyphs/svg?${params.toString()}`;
}

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
  const src = avatarKey.startsWith('data:image/')
    ? avatarKey
    : profileAvatarUrl(avatarKey, colorKey);
  return (
    <span className={cn('block h-full w-full shrink-0 overflow-hidden rounded-full', className)}>
      <img
        src={src}
        alt={`${name} avatar`}
        draggable={false}
        className="h-full w-full object-cover"
      />
    </span>
  );
}
