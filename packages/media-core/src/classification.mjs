/**
 * Filename and folder-structure classification shared by the desktop and
 * headless runtimes. Everything here is pure string work: online metadata
 * providers stay runtime-specific, but both scanners must agree on what a
 * file *is* (movie vs episode, series title, season/episode numbers) so a
 * library mounted by either runtime produces the same catalog structure.
 *
 * The heuristics are ported from the desktop scanner
 * (apps/desktop/src/main/scanClassification.ts and metadata/helpers.ts) so
 * the two runtimes cannot drift.
 */

const RELEASE_TAGS = /\b(480p|720p|1080p|2160p|4k|uhd|hdr10|hdr|dv|dolby|vision|bluray|blu-ray|brrip|webrip|web-rip|web-dl|webdl|hdtv|remux|proper|repack|extended|directors?|cut|imax|x264|x265|h264|h265|hevc|av1|aac|ac3|eac3|dts|truehd|atmos)\b/gi;
const RELEASE_GROUPS = /\b(yts|rarbg|ettv|eztv|tgx|galaxyrg|psa|pahe|ntb|successfulcrab)\b/gi;

/**
 * Derive a display title and release year from a file or folder name,
 * stripping quality tags, release-group names, and separator noise.
 */
export function cleanMediaTitle(name) {
  const source = String(name || '');
  const withoutExt = source.replace(/\.(3gp|avi|divx|flv|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|mts|mxf|ogm|ogv|ts|vob|webm|wmv|vtt|srt|ass|ssa)$/i, '');
  const yearMatches = [...withoutExt.matchAll(/\b(19\d{2}|20\d{2})\b/g)];
  const maxReleaseYear = new Date().getFullYear() + 1;
  const releaseYearMatch =
    yearMatches.find((match) => match.index !== undefined && match.index > 0 && parseInt(match[1], 10) <= maxReleaseYear)
    || yearMatches.find((match) => parseInt(match[1], 10) <= maxReleaseYear);
  const titleSource = releaseYearMatch?.index && releaseYearMatch.index > 0
    ? withoutExt.slice(0, releaseYearMatch.index).replace(/[\s([._-]+$/, ' ')
    : withoutExt;
  const title = titleSource
    .replace(/\[.*?\]|\(.*?\)/g, ' ')
    .replace(/[._-]+/g, ' ')
    .replace(RELEASE_TAGS, ' ')
    .replace(RELEASE_GROUPS, ' ')
    .replace(/\b(19\d{2}|20\d{2})\b/g, ' ')
    .replace(/\s+[Ss]\d{1,2}[Ee]\d{1,3}.*$/, '')
    .replace(/\s+[Ss]\d{1,2}\s*$/, '')
    .replace(/\s+season\s+\d{1,2}\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    title: title || withoutExt.trim() || source,
    year: releaseYearMatch ? parseInt(releaseYearMatch[1], 10) : 0,
  };
}

/** True when a bare file name looks like a TV episode. */
export function isLikelyEpisodeFileName(name) {
  return /[Ss]\d{1,2}[Ee]\d{1,3}/.test(name)
    || /(?:episode|ep)\s*\d{1,3}\b/i.test(name)
    || /(?:^|[\s._-])[Ee]\s*\d{1,3}\b/i.test(name);
}

/**
 * Parse season and episode numbers out of an episode file name.
 * `aggressive` additionally accepts bare trailing/leading numbers
 * ("Episode Title - 07.mkv"); only enable it when surrounding folder
 * structure has already established a TV context, because bare numbers are
 * common in movie names ("Rocky 3").
 */
export function parseEpisodeFileName(fileName, fallbackSeason, { aggressive = false } = {}) {
  const withoutExt = String(fileName || '').replace(/\.[^.]+$/, '');
  const seasonEpisode = withoutExt.match(/[Ss]\s*0*(\d{1,2})\s*[._ -]*[Ee]\s*0*(\d{1,3})/);
  if (seasonEpisode) {
    return { season: parseInt(seasonEpisode[1], 10), episode: parseInt(seasonEpisode[2], 10) };
  }

  const namedEpisode = withoutExt.match(/(?:episode|ep|e)\s*0*(\d{1,3})\b/i);
  if (namedEpisode) return { season: fallbackSeason, episode: parseInt(namedEpisode[1], 10) };
  if (!aggressive) return null;

  const trailingNumber = withoutExt.match(/[-–_\s]+0*(\d{1,3})\s*$/);
  if (trailingNumber) return { season: fallbackSeason, episode: parseInt(trailingNumber[1], 10) };

  const leadingNumber = withoutExt.match(/^\s*0*(\d{1,3})(?:\D|$)/);
  return leadingNumber
    ? { season: fallbackSeason, episode: parseInt(leadingNumber[1], 10) }
    : null;
}

/** Series title embedded in an "Show.Name.S01E02..." style file name. */
export function seriesTitleFromEpisodeName(fileName) {
  const withoutExt = String(fileName || '').replace(/\.[^.]+$/, '');
  const match = withoutExt.match(/^(.+?)[._ -]+[Ss]\s*\d{1,2}\s*[._ -]*[Ee]\s*\d{1,3}\b/);
  if (!match) return null;
  const title = cleanMediaTitle(match[1]).title;
  return title && !/^(season|series|episode|ep)$/i.test(title) ? title : null;
}

/** Path or fansub-group cues that suggest anime content. */
export function isLikelyAnimePath(filePath, title = '') {
  const value = `${filePath} ${title}`.toLowerCase();
  return /(^|[\\/._ -])(anime|animes|donghua|ova|ona)([\\/._ -]|$)/i.test(value)
    || /\b(horriblesubs|subsplease|erai-raws|judas|ember|commie|hakat[a]? ramen)\b/i.test(value);
}

function seasonNumberFromDirectoryName(name) {
  const match = String(name || '').match(/^season[\s._-]*0*(\d{1,2})$/i) || String(name || '').match(/^s0*(\d{1,2})$/i);
  return match ? parseInt(match[1], 10) : null;
}

const GENERIC_DIRECTORY_NAMES = /^(movies?|films?|tv|tv\s*shows?|series|anime|animes|video|videos|media|downloads?|extras?|specials?)$/i;

function seriesTitleFromDirectory(name) {
  if (!name || GENERIC_DIRECTORY_NAMES.test(name)) return null;
  const title = cleanMediaTitle(name).title;
  return title && !GENERIC_DIRECTORY_NAMES.test(title) ? title : null;
}

/**
 * Classify one video file from its root-relative path.
 *
 * Returns `{ kind, title, year, animeLikely }` plus, for episodes,
 * `series: { title, season, episode }`. Classification is intentionally
 * conservative for loose files: a bare trailing number only counts as an
 * episode number once a season folder or episode-styled sibling name has
 * established a TV context.
 */
export function classifyVideoFile(relativePath) {
  const segments = String(relativePath || '').split(/[\\/]/).filter(Boolean);
  const fileName = segments[segments.length - 1] || '';
  const parentName = segments.length > 1 ? segments[segments.length - 2] : '';
  const grandparentName = segments.length > 2 ? segments[segments.length - 3] : '';

  const seasonFromParent = seasonNumberFromDirectoryName(parentName);
  const insideSeasonDir = seasonFromParent !== null;
  const fallbackSeason = seasonFromParent ?? 1;
  const episodeStyledName = isLikelyEpisodeFileName(fileName);

  const parsed = parseEpisodeFileName(fileName, fallbackSeason, { aggressive: insideSeasonDir });
  const isEpisode = episodeStyledName || (insideSeasonDir && parsed !== null);

  const cleaned = cleanMediaTitle(fileName);
  const animeLikely = isLikelyAnimePath(relativePath, cleaned.title);

  if (!isEpisode) {
    return {
      kind: 'movie',
      title: cleaned.title,
      year: cleaned.year || undefined,
      animeLikely,
    };
  }

  const seriesTitle = (insideSeasonDir ? seriesTitleFromDirectory(grandparentName) : null)
    || seriesTitleFromEpisodeName(fileName)
    || seriesTitleFromDirectory(insideSeasonDir ? grandparentName : parentName)
    || cleaned.title;

  return {
    kind: 'episode',
    title: cleaned.title,
    year: cleaned.year || undefined,
    animeLikely,
    series: {
      title: seriesTitle,
      season: parsed?.season ?? fallbackSeason,
      episode: parsed?.episode ?? null,
    },
  };
}
