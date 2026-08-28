import type { ComponentType } from 'react';
import {
  Broadcast,
  Church,
  CloudSun,
  CookingPot,
  FilmSlate,
  FilmStrip,
  Flask,
  GraduationCap,
  Heart,
  AirplaneTilt,
  MusicNotes,
  Newspaper,
  Smiley,
  SoccerBall,
  Television,
  VideoCamera,
} from '@phosphor-icons/react';
import type { IptvSourceIconId } from '@/shared/desktopProtocol';

type SourceIconComponent = ComponentType<{ className?: string }>;
type PhosphorIconComponent = typeof Broadcast;

function weightedVersion(Icon: PhosphorIconComponent, weight: 'regular' | 'fill'): SourceIconComponent {
  return function WeightedLiveTvSourceIcon({ className }) {
    return <Icon className={className} weight={weight} aria-hidden="true" />;
  };
}

const definitions: Array<{ id: IptvSourceIconId; label: string; icon: PhosphorIconComponent }> = [
  { id: 'general', label: 'General', icon: Broadcast },
  { id: 'entertainment', label: 'Entertainment', icon: Television },
  { id: 'news', label: 'News', icon: Newspaper },
  { id: 'sports', label: 'Sports', icon: SoccerBall },
  { id: 'movies', label: 'Movies', icon: FilmSlate },
  { id: 'series', label: 'Series', icon: FilmStrip },
  { id: 'music', label: 'Music', icon: MusicNotes },
  { id: 'kids', label: 'Kids', icon: Smiley },
  { id: 'documentary', label: 'Documentary', icon: VideoCamera },
  { id: 'education', label: 'Education', icon: GraduationCap },
  { id: 'lifestyle', label: 'Lifestyle', icon: Heart },
  { id: 'travel', label: 'Travel', icon: AirplaneTilt },
  { id: 'cooking', label: 'Cooking', icon: CookingPot },
  { id: 'science', label: 'Science', icon: Flask },
  { id: 'religious', label: 'Religious', icon: Church },
  { id: 'weather', label: 'Weather', icon: CloudSun },
];

export const LIVE_TV_SOURCE_ICON_OPTIONS = definitions.map((definition) => ({
  id: definition.id,
  label: definition.label,
  outline: weightedVersion(definition.icon, 'regular'),
  solid: weightedVersion(definition.icon, 'fill'),
}));

export function normalizeLiveTvSourceIcon(value: unknown): IptvSourceIconId {
  return LIVE_TV_SOURCE_ICON_OPTIONS.some((option) => option.id === value)
    ? value as IptvSourceIconId
    : 'general';
}

export function liveTvSourceIconPair(value: unknown): { outline: SourceIconComponent; solid: SourceIconComponent } {
  const selected = LIVE_TV_SOURCE_ICON_OPTIONS.find((option) => option.id === normalizeLiveTvSourceIcon(value))
    || LIVE_TV_SOURCE_ICON_OPTIONS[0];
  return { outline: selected.outline, solid: selected.solid };
}
