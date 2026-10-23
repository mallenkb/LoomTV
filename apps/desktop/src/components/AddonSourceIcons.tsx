import {
  Archive, Books, Cat, ChartLineUp, CloudArrowDown, Compass, DotsThreeCircle,
  Fan, FilmReel, FilmSlate, FilmStrip, FlowerLotus, GameController, Globe,
  HardDrives, Headphones, Info, ListBullets, Magnet, MagnifyingGlass,
  MonitorPlay, MusicNotes, Newspaper, Palette, PlayCircle, Popcorn, Radio,
  Smiley, SoccerBall, Sparkle, SquaresFour, Star, Subtitles, Television,
  Ticket, VideoCamera,
} from '@phosphor-icons/react';
import { LIVE_TV_SOURCE_ICON_OPTIONS } from '@/components/LiveTvSourceIcons';

const legacyDefinitions = [
  { id: 'cinema', label: 'Cinema', icon: FilmReel },
  { id: 'popcorn', label: 'Popcorn', icon: Popcorn },
  { id: 'tickets', label: 'Tickets', icon: Ticket },
  { id: 'favorites', label: 'Favorites', icon: Star },
  { id: 'gaming', label: 'Gaming', icon: GameController },
  { id: 'audio', label: 'Audio', icon: Headphones },
  { id: 'world', label: 'World', icon: Globe },
  { id: 'books', label: 'Books', icon: Books },
  { id: 'art', label: 'Art', icon: Palette },
  { id: 'explore', label: 'Explore', icon: Compass },
  { id: 'archive', label: 'Archive', icon: Archive },
] as const;

const definitions = [
  { id: 'movies', label: 'Movies', icon: FilmSlate },
  { id: 'series', label: 'Series', icon: FilmStrip },
  { id: 'anime', label: 'Anime', icon: Cat },
  { id: 'asian-drama', label: 'Asian drama', icon: Fan },
  { id: 'bollywood', label: 'Bollywood', icon: FlowerLotus },
  { id: 'entertainment', label: 'Live TV', icon: Television },
  { id: 'sports', label: 'Sports', icon: SoccerBall },
  { id: 'news', label: 'News', icon: Newspaper },
  { id: 'documentary', label: 'Documentaries', icon: VideoCamera },
  { id: 'kids', label: 'Kids', icon: Smiley },
  { id: 'music', label: 'Music', icon: MusicNotes },
  { id: 'radio', label: 'Radio', icon: Radio },
  { id: 'streams', label: 'HTTP streams', icon: PlayCircle },
  { id: 'torrents', label: 'Torrents', icon: Magnet },
  { id: 'usenet', label: 'Usenet', icon: HardDrives },
  { id: 'debrid', label: 'Debrid', icon: CloudArrowDown },
  { id: 'subtitles', label: 'Subtitles', icon: Subtitles },
  { id: 'metadata', label: 'Metadata', icon: Info },
  { id: 'catalogs', label: 'Catalogs', icon: SquaresFour },
  { id: 'tracking', label: 'Tracking', icon: ChartLineUp },
  { id: 'lists', label: 'Lists', icon: ListBullets },
  { id: 'search', label: 'Search', icon: MagnifyingGlass },
  { id: 'recommendations', label: 'Recommendations', icon: Sparkle },
  { id: 'archive', label: 'Archives', icon: Archive },
  { id: 'regional', label: 'Regional content', icon: Globe },
  { id: 'watch-options', label: 'Watch options', icon: MonitorPlay },
  { id: 'miscellaneous', label: 'Miscellaneous', icon: DotsThreeCircle },
] as const;

export type AddonExtraIconId = typeof definitions[number]['id'] | typeof legacyDefinitions[number]['id'];

function iconOptions<T extends string>(items: readonly { id: T; label: string; icon: typeof Archive }[]) {
  return items.map(({ id, label, icon: Icon }) => ({
    id,
    label,
    outline: function AddonOutlineIcon({ className }: { className?: string }) {
      return <Icon className={className} weight="regular" aria-hidden="true" />;
    },
    solid: function AddonSolidIcon({ className }: { className?: string }) {
      return <Icon className={className} weight="fill" aria-hidden="true" />;
    },
  }));
}

// 27 add-on types plus the picker's Default option gives 28 choices.
const mediaOrder = [
  'movies', 'series', 'anime', 'asian-drama', 'bollywood', 'entertainment',
  'sports', 'news', 'documentary', 'kids', 'music', 'radio', 'streams',
  'watch-options', 'regional', 'archive', 'catalogs', 'lists', 'recommendations',
  'search', 'torrents', 'usenet', 'debrid', 'subtitles', 'metadata', 'tracking', 'miscellaneous',
];
export const ADDON_SOURCE_ICON_OPTIONS = iconOptions(definitions)
  .sort((left, right) => mediaOrder.indexOf(left.id) - mediaOrder.indexOf(right.id));
// Keep previously saved icons readable without offering unrelated new choices.
export const ADDON_SUPPORTED_ICON_OPTIONS = [
  ...ADDON_SOURCE_ICON_OPTIONS,
  ...LIVE_TV_SOURCE_ICON_OPTIONS,
  ...iconOptions(legacyDefinitions),
];

export function addonSourceIconPair(value: unknown) {
  const selected = ADDON_SUPPORTED_ICON_OPTIONS.find(option => option.id === value) || ADDON_SOURCE_ICON_OPTIONS[0];
  return { outline: selected.outline, solid: selected.solid };
}
