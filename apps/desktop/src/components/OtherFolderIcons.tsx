import type { ComponentType } from 'react';
import {
  AirplaneTilt,
  Archive,
  Baby,
  Barbell,
  Camera,
  FilmSlate,
  Folder,
  GameController,
  GraduationCap,
  Heart,
  MusicNotes,
  Star,
} from '@phosphor-icons/react';

export const OTHER_FOLDER_ICON_IDS = [
  'folder',
  'archive',
  'clapperboard',
  'gamepad',
  'music',
  'camera',
  'graduation',
  'fitness',
  'travel',
  'family',
  'heart',
  'star',
] as const;

export type OtherFolderIconId = (typeof OTHER_FOLDER_ICON_IDS)[number];
type FolderIconComponent = ComponentType<{ className?: string }>;
type PhosphorIconComponent = typeof Folder;

function weightedVersion(Icon: PhosphorIconComponent, weight: 'regular' | 'fill'): FolderIconComponent {
  return function WeightedOtherFolderIcon({ className }) {
    return <Icon className={className} weight={weight} aria-hidden="true" />;
  };
}

const definitions: Array<{ id: OtherFolderIconId; label: string; icon: PhosphorIconComponent }> = [
  { id: 'folder', label: 'Folder', icon: Folder },
  { id: 'archive', label: 'Archive', icon: Archive },
  { id: 'clapperboard', label: 'Videos', icon: FilmSlate },
  { id: 'gamepad', label: 'Gaming', icon: GameController },
  { id: 'music', label: 'Music', icon: MusicNotes },
  { id: 'camera', label: 'Camera', icon: Camera },
  { id: 'graduation', label: 'Learning', icon: GraduationCap },
  { id: 'fitness', label: 'Fitness', icon: Barbell },
  { id: 'travel', label: 'Travel', icon: AirplaneTilt },
  { id: 'family', label: 'Family', icon: Baby },
  { id: 'heart', label: 'Favorites', icon: Heart },
  { id: 'star', label: 'Featured', icon: Star },
];

export const OTHER_FOLDER_ICON_OPTIONS = definitions.map((definition) => ({
  id: definition.id,
  label: definition.label,
  outline: weightedVersion(definition.icon, 'regular'),
  solid: weightedVersion(definition.icon, 'fill'),
}));

export function normalizeOtherFolderIcon(value: unknown): OtherFolderIconId {
  return OTHER_FOLDER_ICON_IDS.includes(value as OtherFolderIconId) ? value as OtherFolderIconId : 'folder';
}

export function otherFolderIconPair(value: unknown): { outline: FolderIconComponent; solid: FolderIconComponent } {
  const selected = OTHER_FOLDER_ICON_OPTIONS.find((option) => option.id === normalizeOtherFolderIcon(value))
    || OTHER_FOLDER_ICON_OPTIONS[0];
  return { outline: selected.outline, solid: selected.solid };
}

export function otherFolderIconStorageKey(folder: string): string {
  return `__loomtv_other_folder_icon__:${folder}`;
}
