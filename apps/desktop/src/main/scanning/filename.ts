import { cleanMediaTitle } from '../metadata/helpers.ts';
import { parseEpisodeFileName } from '../scanClassification.ts';
import { isSubtitleFileName, subtitleAssociationKeys } from '../fileClassification.ts';
export function filenameHints(name: string) {
  const title = cleanMediaTitle(name);
  const parsed = parseEpisodeFileName(name, 1);
  return { ...title, ...(isSubtitleFileName(name) ? { subtitleKeys: subtitleAssociationKeys(name) } : {}), ...(parsed ? {
    episode: parsed.episode,
    ...(/[Ss]\s*0*(\d{1,2})\s*[._ -]*[Ee]\s*0*(\d{1,3})/.test(name.replace(/\.[^.]+$/, '')) ? { season: parsed.season } : {}),
  } : {}) };
}
