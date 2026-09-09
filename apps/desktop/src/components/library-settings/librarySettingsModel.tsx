import type { ComponentType } from 'react';
import {
  Folder,
} from '@phosphor-icons/react';
import {
  AnimeIcon,
  AnimeSolidIcon,
  FilmNavIcon,
  FilmNavSolidExactIcon,
  TVNavIcon,
  TVNavSolidIcon,
} from '@/components/Sidebar';

export const LIBRARY_KINDS = [
  'movies',
  'tvShows',
  'anime',
  'others',
] as const;

export type LibraryKind = (typeof LIBRARY_KINDS)[number];

export type LibraryIconComponent = ComponentType<{ className?: string }>;

export type LibraryTypeDefinition = {
  kind: LibraryKind;
  label: string;
  description: string;
  route?: string;
  custom?: boolean;
  icons: {
    regular: LibraryIconComponent;
    fill: LibraryIconComponent;
  };
};

type PhosphorIconComponent = typeof Folder;

function weightedIcon(Icon: PhosphorIconComponent, weight: 'regular' | 'fill'): LibraryIconComponent {
  return function WeightedLibraryIcon({ className }) {
    return <Icon className={className} weight={weight} aria-hidden="true" />;
  };
}

function iconPair(Icon: PhosphorIconComponent): LibraryTypeDefinition['icons'] {
  return {
    regular: weightedIcon(Icon, 'regular'),
    fill: weightedIcon(Icon, 'fill'),
  };
}

const iconPairs = {
  movies: { regular: FilmNavIcon, fill: FilmNavSolidExactIcon },
  tvShows: { regular: TVNavIcon, fill: TVNavSolidIcon },
  anime: { regular: AnimeIcon, fill: AnimeSolidIcon },
  others: iconPair(Folder),
} satisfies Record<LibraryKind, LibraryTypeDefinition['icons']>;

export const LIBRARY_TYPE_DEFINITIONS: readonly LibraryTypeDefinition[] = [
  { kind: 'movies', label: 'Movies', description: 'Films and feature length video', route: '/movies', icons: iconPairs.movies },
  { kind: 'tvShows', label: 'TV Shows', description: 'Series and episodic video', route: '/tv', icons: iconPairs.tvShows },
  { kind: 'anime', label: 'Anime', description: 'Anime and animated series', route: '/anime', icons: iconPairs.anime },
  { kind: 'others', label: 'Other folders', description: 'Folders with automatic type detection', custom: true, icons: iconPairs.others },
];

export function libraryTypeDefinition(kind: LibraryKind): LibraryTypeDefinition {
  return LIBRARY_TYPE_DEFINITIONS.find((definition) => definition.kind === kind) || LIBRARY_TYPE_DEFINITIONS[0];
}

export function LibraryTypeIcon({ kind, active = false, className }: { kind: LibraryKind; active?: boolean; className?: string }) {
  const definition = libraryTypeDefinition(kind);
  const Icon = active ? definition.icons.fill : definition.icons.regular;
  return <Icon className={className} />;
}
