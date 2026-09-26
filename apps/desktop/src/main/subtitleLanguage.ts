import path from 'node:path';

/**
 * Reads a sidecar subtitle's language from the tags at the end of its name:
 * `Show.S02E01.ITA.ENG.1080p.x265-Pir8.en.srt` is English, not "the" from
 * an earlier `.The.`. Tokens are only accepted when they are real language
 * codes or names, so a title word never becomes a language.
 */

/** Subtitle flags that sit next to the language: `.en.forced.srt`, `.en.sdh.srt`. */
const FLAGS = new Set(['forced', 'sdh', 'cc', 'hi', 'default', 'full', 'signs', 'songs', 'commentary']);

const LANGUAGE_NAMES: Record<string, string> = {
  english: 'en', spanish: 'es', french: 'fr', german: 'de', italian: 'it', portuguese: 'pt',
  japanese: 'ja', korean: 'ko', chinese: 'zh', arabic: 'ar', russian: 'ru', hindi: 'hi',
  dutch: 'nl', swedish: 'sv', norwegian: 'no', danish: 'da', finnish: 'fi', polish: 'pl',
  turkish: 'tr', greek: 'el', hebrew: 'he', thai: 'th', vietnamese: 'vi', indonesian: 'id',
  czech: 'cs', hungarian: 'hu', romanian: 'ro', ukrainian: 'uk', swahili: 'sw',
};

let displayNames: Intl.DisplayNames | null = null;

/** The code when `token` is a real language code or name, otherwise null. */
function asLanguage(token: string): string | null {
  const value = token.replace(/^\[|\]$/g, '').toLowerCase();
  if (LANGUAGE_NAMES[value]) return LANGUAGE_NAMES[value];
  if (!/^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(value) || value === 'und') return null;
  try {
    displayNames ??= new Intl.DisplayNames(['en'], { type: 'language' });
    // Unknown codes come back unchanged ("the" -> "the").
    const name = displayNames.of(value);
    return name && name.toLowerCase() !== value ? value : null;
  } catch {
    return null;
  }
}

/** Language of a sidecar subtitle file; English when the name carries none. */
export function subtitleLanguageFromFileName(fileName: string): string {
  const name = path.basename(fileName);
  const openSubtitles = name.match(/\.opensubtitles\.([a-z]{2,3})\./i);
  if (openSubtitles) return openSubtitles[1].toLowerCase();

  const stem = name.slice(0, name.length - path.extname(name).length)
    .replace(/\.loomtv-clean-(?:signs|dialogue|honorific)$/i, '');
  const tokens = stem.split('.');
  // "hi" is "hearing impaired" beside a language (.en.hi.srt) but Hindi on
  // its own (.hi.srt), so a flag that is also a language is kept as a fallback.
  let flagLanguage: string | null = null;
  for (let index = tokens.length - 1; index > 0; index -= 1) {
    const token = tokens[index].toLowerCase();
    if (FLAGS.has(token)) {
      flagLanguage ??= asLanguage(token);
      continue;
    }
    const language = asLanguage(token);
    if (language) return language;
    break;
  }
  if (flagLanguage) return flagLanguage;
  // "[en]" style tags anywhere in the name, as the scanner has always read.
  for (const match of name.matchAll(/\[(\w{2,3})\]/g)) {
    const language = asLanguage(match[1]);
    if (language) return language;
  }
  return 'en';
}
