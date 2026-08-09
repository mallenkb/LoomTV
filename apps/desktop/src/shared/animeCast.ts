/**
 * AniList/Jikan expose character-first credits, while older TMDB/TVMaze
 * records are actor-first (`name` is the person and `character` is the role).
 * Keep the UI and persisted library data on one canonical shape so those
 * provider-specific representations cannot be mixed up.
 */
export type AnimeCastLike = {
  name?: string | null;
  character?: string | null;
  image?: string | null;
  characterName?: string | null;
  characterRole?: string | null;
  characterImage?: string | null;
  voiceActorName?: string | null;
  voiceActorImage?: string | null;
  voiceActorLanguage?: string | null;
};

export type NormalizedAnimeCast = {
  name: string;
  character: string;
  image: string;
  characterName: string;
  characterRole: string;
  characterImage: string;
  voiceActorName: string;
  voiceActorImage: string;
  voiceActorLanguage: string;
};

const VOICE_SUFFIX = /\s+\((?:voice|voiced by)\)\s*$/i;
const ROLE_VALUES = new Set(['main', 'supporting', 'background', 'character']);

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRole(value: string): boolean {
  return ROLE_VALUES.has(value.trim().toLowerCase());
}

function stripVoiceSuffix(value: string): string {
  return value.replace(VOICE_SUFFIX, '').trim();
}

/**
 * Normalize both canonical anime credits and legacy generic cast records.
 * Character data is always placed in the first half of the record and voice
 * actor data in the second half; missing character artwork is intentionally
 * left empty so the UI can render its placeholder.
 */
export function normalizeAnimeCast(cast: readonly AnimeCastLike[] | null | undefined): NormalizedAnimeCast[] {
  return (cast || []).map((credit) => {
    const rawName = text(credit.name);
    const rawCharacter = text(credit.character);
    const explicitCharacterName = text(credit.characterName);
    const explicitCharacterRole = text(credit.characterRole);
    const explicitCharacterImage = text(credit.characterImage);
    const explicitVoiceActorName = text(credit.voiceActorName);
    const explicitVoiceActorImage = text(credit.voiceActorImage);
    const explicitVoiceActorLanguage = text(credit.voiceActorLanguage);

    // Canonical AniList/Jikan records carry character fields explicitly. In
    // no-voice records, `name` is still the character name, so never infer an
    // actor from it when the canonical character fields are present.
    const hasCanonicalCharacter = Boolean(
      explicitCharacterName || explicitCharacterRole || explicitCharacterImage,
    );

    let characterName: string;
    let characterRole: string;
    let characterImage: string;
    let voiceActorName: string;
    let voiceActorImage: string;

    if (hasCanonicalCharacter) {
      characterName = explicitCharacterName || rawName || 'Unknown character';
      characterRole = explicitCharacterRole || (isRole(rawCharacter) ? rawCharacter : 'Character');
      characterImage = explicitCharacterImage;
      voiceActorName = explicitVoiceActorName;
      voiceActorImage = explicitVoiceActorImage;
    } else if (isRole(rawCharacter)) {
      // Older AniList-shaped records used `name`/`image` for the character
      // and stored the role in `character`, without the explicit fields.
      characterName = rawName || 'Unknown character';
      characterRole = rawCharacter;
      characterImage = text(credit.image);
      voiceActorName = '';
      voiceActorImage = '';
    } else {
      // Generic TMDB/TVMaze records are actor-first. The character image is
      // unavailable in this shape, but the actor photo remains useful below.
      characterName = stripVoiceSuffix(rawCharacter) || 'Unknown character';
      characterRole = 'Character';
      characterImage = '';
      voiceActorName = rawName;
      voiceActorImage = text(credit.image);
    }

    return {
      name: characterName,
      character: characterRole,
      image: characterImage,
      characterName,
      characterRole,
      characterImage,
      voiceActorName,
      voiceActorImage,
      voiceActorLanguage: explicitVoiceActorLanguage,
    };
  });
}
