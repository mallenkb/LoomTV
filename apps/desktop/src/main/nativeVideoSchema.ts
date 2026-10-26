import type BetterSqlite3 from 'better-sqlite3';

/** Legacy repository names are projections, never another set of video rows. */
export const nativeVideoTables = [
  'library_folders',
  'media_items',
  'seasons',
  'episodes',
  'episode_files',
  'profiles',
  'profile_preferences',
  'profile_restrictions',
  'profile_library_access',
  'profile_media_lists',
  'playback_progress',
  'playback_track_preferences',
  'device_profile_selections',
  'device_profile_selection_revisions',
] as const;

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const owner = '(SELECT account_id FROM owner_account WHERE singleton=1)';
const parent = "json_extract(c.extension_json,'$.seriesId')";
const movieSourcePredicate = "(c.media_kind!='movie' OR EXISTS(SELECT 1 FROM media_sources movie_source WHERE movie_source.media_id=c.id))";
const legacySeriesParentPredicate = "json_extract(extension_json,'$.seriesId')=c.id";
// Unary + preserves the string ID while removing the column's TEXT affinity.
// That lets SQLite use the JSON expression index for this correlated lookup.
const indexedSeriesParentPredicate = "json_extract(extension_json,'$.seriesId')=+c.id";

/** Upgrade the catalog view in place, retaining media identities and write triggers. */
export function repairNativeMovieProjection(database: BetterSqlite3.Database): void {
  const definition = database.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='native_media_items'").get() as { sql: string } | undefined;
  if (!definition) return;
  let nextSql = definition.sql.replaceAll(legacySeriesParentPredicate, indexedSeriesParentPredicate);
  if (!nextSql.includes(movieSourcePredicate)) nextSql = `${nextSql.replace(/;\s*$/, '')} AND ${movieSourcePredicate}`;
  if (nextSql === definition.sql) return;
  database.transaction(() => {
    const triggers = database.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='native_media_items'").all() as Array<{ sql: string }>;
    database.exec('DROP VIEW native_media_items');
    database.exec(nextSql);
    for (const trigger of triggers) database.exec(trigger.sql);
  })();
}
const restoredSourceState =
  "CASE WHEN media_sources.state='missing' THEN COALESCE(json_extract(media_sources.extension_json,'$.nativePreviousState'),'online') ELSE media_sources.state END";
const markSourcesMissing = (
  where: string,
) => `UPDATE media_sources SET extension_json=json_set(extension_json,'$.nativePreviousState',
  CASE WHEN state='missing' THEN COALESCE(json_extract(extension_json,'$.nativePreviousState'),'online') ELSE state END),state='missing' WHERE ${where};`;
const episodeId = `COALESCE((SELECT id FROM catalog_items WHERE media_kind='episode'
  AND json_extract(extension_json,'$.seriesId')=NEW.media_id AND series_season=NEW.season
  AND series_episode=NEW.number ORDER BY EXISTS(SELECT 1 FROM media_sources WHERE media_id=catalog_items.id) DESC,id LIMIT 1),NEW.media_id||':episode:'||NEW.season||':'||NEW.number)`;

function view(
  database: BetterSqlite3.Database,
  name: string,
  select: string,
  insert: string,
  remove: string,
  update = insert,
): void {
  const target = `native_${name}`;
  database.exec(`CREATE VIEW IF NOT EXISTS ${quote(target)} AS ${select};`);
  for (const [event, body] of [
    ['INSERT', insert],
    ['UPDATE', update],
    ['DELETE', remove],
  ]) {
    if (body)
      database.exec(`CREATE TRIGGER IF NOT EXISTS ${quote(`${target}_${event.toLowerCase()}`)}
      INSTEAD OF ${event} ON ${quote(target)} BEGIN ${body} END;`);
  }
}

/** Called inside the consolidated database's migration transaction. */
export function createNativeVideoSchema(database: BetterSqlite3.Database): void {
  database.exec(`
    CREATE INDEX IF NOT EXISTS catalog_native_episode_key ON catalog_items(json_extract(extension_json,'$.seriesId'),series_season,series_episode);
    CREATE TABLE IF NOT EXISTS video_seasons (
      media_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,title TEXT NOT NULL DEFAULT '',episode_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(media_id,number));
    CREATE TABLE IF NOT EXISTS video_series_locations (
      media_id TEXT PRIMARY KEY REFERENCES catalog_items(id) ON DELETE CASCADE,locator TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_path_grants (
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,folder_path TEXT NOT NULL,
      PRIMARY KEY(profile_id,folder_path));
    CREATE TABLE IF NOT EXISTS native_profile_ui (
      profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,payload_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0,restrictions_updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS native_selection_revisions (
      device_id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS native_progress_locators (
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      media_id TEXT NOT NULL,locator TEXT NOT NULL,PRIMARY KEY(profile_id,media_id));
  `);
  for (const table of ['catalog_items', 'media_sources', 'library_roots', 'video_seasons', 'video_series_locations']) {
    for (const event of ['INSERT', 'UPDATE', 'DELETE'])
      database.exec(`
      CREATE TRIGGER IF NOT EXISTS ${quote(`video_catalog_${table}_${event.toLowerCase()}`)} AFTER ${event} ON ${quote(table)}
      BEGIN INSERT INTO meta(key,value) VALUES('native_catalog_revision',lower(hex(randomblob(16))))
        ON CONFLICT(key) DO UPDATE SET value=excluded.value; END;`);
  }
  view(
    database,
    'library_folders',
    "SELECT locator path,kind,created_at added_at FROM library_roots WHERE state!='removed'",
    `INSERT INTO library_roots(id,locator,kind,state,created_at) VALUES(loom_root_id(NEW.path),NEW.path,NEW.kind,'available',COALESCE(NEW.added_at,0))
      ON CONFLICT(locator) DO UPDATE SET kind=excluded.kind,state=CASE WHEN library_roots.state='removed'
        THEN COALESCE((SELECT value FROM meta WHERE key='native_root_state:'||library_roots.id),'available') ELSE library_roots.state END;`,
    `INSERT INTO meta(key,value) SELECT 'native_root_state:'||id,state FROM library_roots WHERE locator=OLD.path AND state!='removed'
      ON CONFLICT(key) DO UPDATE SET value=excluded.value;
      UPDATE library_roots SET state='removed' WHERE locator=OLD.path;`,
    `UPDATE library_roots SET locator=NEW.path,kind=NEW.kind,created_at=NEW.added_at WHERE locator=OLD.path;`,
  );

  const scalar: Record<string, string> = {
    format: 'format',
    poster: 'poster',
    backdrop: 'backdrop',
    logo: 'logo',
    summary: 'summary',
    content_rating: 'contentRating',
    trailer_url: 'trailerUrl',
    runtime: 'runtime',
  };
  const numeric: Record<string, string> = {
    rating: 'rating',
    season_count: 'seasonCount',
    episode_count: 'episodeCount',
    last_played: 'lastPlayed',
  };
  const json: Record<string, string> = {
    provider_ratings_json: 'providerRatings',
    genres_json: 'genres',
    cast_json: 'cast',
    subtitles_json: 'subtitles',
    local_metadata_json: 'localMetadata',
    provider_ids_json: 'providerIds',
    streaming_providers_json: 'streamingProviders',
    origin_platform_json: 'originPlatform',
    poster_candidates_json: 'posterCandidates',
    backdrop_candidates_json: 'backdropCandidates',
    logo_candidates_json: 'logoCandidates',
    content_ratings_json: 'contentRatings',
  };
  const metadata = (field: string) =>
    ['poster', 'backdrop', 'logo'].includes(field)
      ? `COALESCE(NULLIF(json_extract(c.extension_json,'$.metadata.${field}'),''),json_extract(c.extension_json,'$.artwork.${field}'))`
      : field === 'localMetadata'
        ? `COALESCE(json_extract(c.extension_json,'$.metadata.localMetadata'),(SELECT COALESCE(json_extract(s.extension_json,'$.nativeLocalMetadata'),s.probe_json)
        FROM media_sources s WHERE s.media_id=c.id ORDER BY s.state='online' DESC,s.indexed_at DESC LIMIT 1))`
        : ['summary', 'rating', 'genres', 'providerIds', 'contentRatings'].includes(field)
          ? `COALESCE(json_extract(c.extension_json,'$.${field}'),json_extract(c.extension_json,'$.metadata.${field}'))`
          : `json_extract(c.extension_json,'$.metadata.${field}')`;
  const itemColumns = [
    ...Object.entries(scalar).map(([column, field]) => `COALESCE(${metadata(field)},'') ${column}`),
    ...Object.entries(numeric).map(
      ([column, field]) => `${column === 'rating' ? `COALESCE(${metadata(field)},0)` : metadata(field)} ${column}`,
    ),
    ...Object.entries(json).map(
      ([column, field]) =>
        `COALESCE(${metadata(field)},'${['genres', 'cast', 'subtitles', 'streamingProviders', 'posterCandidates', 'backdropCandidates', 'logoCandidates'].includes(field) ? '[]' : '{}'}') ${column}`,
    ),
  ];
  const metadataPairs = [
    ...Object.entries(scalar).flatMap(([column, field]) => [`'${field}'`, `COALESCE(NEW.${column},'')`]),
    ...Object.entries(numeric).flatMap(([column, field]) => [`'${field}'`, `NEW.${column}`]),
    ...Object.entries(json).flatMap(([column, field]) => [`'${field}'`, `json(COALESCE(NEW.${column},'null'))`]),
  ];
  const artwork = `json_patch(COALESCE((SELECT json_extract(extension_json,'$.artwork') FROM catalog_items WHERE id=NEW.id),'{}'),
    (SELECT json_group_object(key,value) FROM (SELECT 'poster' key,NEW.poster value UNION ALL SELECT 'backdrop',NEW.backdrop UNION ALL SELECT 'logo',NEW.logo)
      WHERE length(COALESCE(value,''))>0))`;
  const itemInsert = `
    SELECT CASE WHEN EXISTS(SELECT 1 FROM catalog_items WHERE id=NEW.id AND media_kind NOT IN ('movie','series'))
      THEN RAISE(ABORT,'Native item identity belongs to another catalog kind') END;
    SELECT CASE WHEN NEW.type='movie' AND EXISTS(SELECT 1 FROM media_sources WHERE locator=NEW.file_path AND media_id!=NEW.id)
      THEN RAISE(ABORT,'Native movie path belongs to another media identity') END;
    INSERT INTO catalog_items(id,media_type,media_kind,title,year,anime_likely,extension_json,created_at,updated_at)
      VALUES(NEW.id,CASE WHEN NEW.type='movie' THEN 'movie' ELSE 'tv' END,CASE WHEN NEW.type='movie' THEN 'movie' ELSE 'series' END,
        NEW.title,NULLIF(NEW.year,0),NEW.type='anime',json_object('nativeRemoved',json('false'),'metadata',json_object(${metadataPairs.join(',')}),'artwork',${artwork},
          'summary',COALESCE(NEW.summary,''),'rating',COALESCE(NEW.rating,0),'genres',json(COALESCE(NEW.genres_json,'[]')),
          'providerIds',json(COALESCE(NEW.provider_ids_json,'{}')),'contentRatings',json(COALESCE(NEW.content_ratings_json,'{}'))),
        COALESCE(NEW.added_at,0),COALESCE(NEW.updated_at,0))
      ON CONFLICT(id) DO UPDATE SET media_type=excluded.media_type,media_kind=excluded.media_kind,title=excluded.title,
        year=excluded.year,anime_likely=excluded.anime_likely,
        extension_json=json_patch(catalog_items.extension_json,excluded.extension_json),created_at=excluded.created_at,updated_at=excluded.updated_at;
    INSERT INTO video_series_locations(media_id,locator) SELECT NEW.id,NEW.file_path WHERE NEW.type!='movie'
      ON CONFLICT(media_id) DO UPDATE SET locator=excluded.locator;
    INSERT INTO media_sources(id,media_id,root_id,relative_path,locator,state,file_extension,size_bytes,indexed_at,last_seen_at,extension_json)
      SELECT COALESCE((SELECT id FROM media_sources WHERE locator=NEW.file_path),NEW.id||':source:'||loom_root_id(NEW.file_path)),NEW.id,
        (SELECT id FROM library_roots WHERE state!='removed' AND loom_contains(locator,NEW.file_path) ORDER BY length(locator) DESC LIMIT 1),
        loom_relative(COALESCE((SELECT locator FROM library_roots WHERE state!='removed' AND loom_contains(locator,NEW.file_path) ORDER BY length(locator) DESC LIMIT 1),NEW.file_path),NEW.file_path),
        NEW.file_path,'online',loom_extension(NEW.file_path),NEW.file_size,COALESCE(NEW.updated_at,0),COALESCE(NEW.updated_at,0),
        json_object('nativeLocalMetadata',json(COALESCE(NEW.local_metadata_json,'null')))
      WHERE NEW.type='movie' AND length(NEW.file_path)>0
      ON CONFLICT(id) DO UPDATE SET media_id=excluded.media_id,root_id=excluded.root_id,relative_path=excluded.relative_path,
        locator=excluded.locator,state=${restoredSourceState},file_extension=excluded.file_extension,size_bytes=excluded.size_bytes,
        indexed_at=excluded.indexed_at,last_seen_at=excluded.last_seen_at,extension_json=json_patch(media_sources.extension_json,excluded.extension_json);
  `;
  view(
    database,
    'media_items',
    `SELECT c.id,CASE WHEN c.anime_likely=1 THEN 'anime' WHEN c.media_kind='movie' THEN 'movie' ELSE 'tv' END type,
      c.title,COALESCE(c.year,0) year,${itemColumns.join(',')},
      COALESCE((SELECT s.locator FROM media_sources s JOIN library_roots r ON r.id=s.root_id AND r.state!='removed'
        WHERE s.media_id=c.id ORDER BY s.state='online' DESC,s.indexed_at DESC LIMIT 1),
        (SELECT locator FROM video_series_locations WHERE media_id=c.id),'') file_path,
      (SELECT s.size_bytes FROM media_sources s JOIN library_roots r ON r.id=s.root_id AND r.state!='removed'
        WHERE s.media_id=c.id ORDER BY s.state='online' DESC,s.indexed_at DESC LIMIT 1) file_size,
      c.created_at added_at,c.updated_at FROM catalog_items c WHERE c.media_kind IN ('movie','series')
        AND COALESCE(json_extract(c.extension_json,'$.nativeRemoved'),0)=0
        AND ${movieSourcePredicate}
        AND ((NOT EXISTS(SELECT 1 FROM media_sources WHERE media_id=c.id
          OR media_id IN(SELECT id FROM catalog_items WHERE ${indexedSeriesParentPredicate}))
          AND NOT EXISTS(SELECT 1 FROM video_series_locations WHERE media_id=c.id))
          OR EXISTS(SELECT 1 FROM media_sources s JOIN library_roots r ON r.id=s.root_id
            WHERE (s.media_id=c.id OR s.media_id IN(SELECT id FROM catalog_items WHERE ${indexedSeriesParentPredicate}))
              AND r.state!='removed')
          OR (c.media_kind='series' AND NOT EXISTS(SELECT 1 FROM media_sources WHERE media_id=c.id
            OR media_id IN(SELECT id FROM catalog_items WHERE ${indexedSeriesParentPredicate}))
            AND EXISTS(SELECT 1 FROM video_series_locations l JOIN library_roots r
            ON loom_contains(r.locator,l.locator) WHERE l.media_id=c.id AND r.state!='removed')))`,
    itemInsert,
    `${markSourcesMissing("media_id=OLD.id OR media_id IN (SELECT id FROM catalog_items WHERE json_extract(extension_json,'$.seriesId')=OLD.id)")}
      UPDATE catalog_items SET extension_json=json_set(extension_json,'$.nativeRemoved',json('true'))
        WHERE id=OLD.id OR json_extract(extension_json,'$.seriesId')=OLD.id;`,
  );

  const requireSeries = `SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM catalog_items WHERE id=NEW.media_id AND media_kind='series')
    THEN RAISE(ABORT,'Native episode parent must be a series') END;`;
  view(
    database,
    'seasons',
    'SELECT media_id,number,title,episode_count FROM video_seasons',
    `${requireSeries} INSERT INTO video_seasons(media_id,number,title,episode_count) VALUES(NEW.media_id,NEW.number,COALESCE(NEW.title,''),COALESCE(NEW.episode_count,0))
      ON CONFLICT(media_id,number) DO UPDATE SET title=excluded.title,episode_count=excluded.episode_count;`,
    'DELETE FROM video_seasons WHERE media_id=OLD.media_id AND number=OLD.number;',
    `${requireSeries} UPDATE video_seasons SET media_id=NEW.media_id,number=NEW.number,title=NEW.title,episode_count=NEW.episode_count
      WHERE media_id=OLD.media_id AND number=OLD.number;`,
  );
  const episodeInsert = `${requireSeries}
    SELECT CASE WHEN EXISTS(SELECT 1 FROM catalog_items WHERE id=${episodeId} AND media_kind!='episode')
      THEN RAISE(ABORT,'Native episode identity belongs to another catalog kind') END;
    INSERT INTO catalog_items(id,media_type,media_kind,title,anime_likely,series_title,series_season,series_episode,extension_json,created_at,updated_at)
    VALUES(${episodeId},'tv','episode',COALESCE(NEW.title,''),COALESCE((SELECT anime_likely FROM catalog_items WHERE id=NEW.media_id),0),
      (SELECT title FROM catalog_items WHERE id=NEW.media_id),NEW.season,NEW.number,
      json_object('seriesId',NEW.media_id,'nativeRemoved',json('false'),'nativeEpisodeHidden',json('false'),
        'summary',COALESCE(NEW.summary,''),'rating',COALESCE(NEW.rating,0),'metadata',json_object('summary',COALESCE(NEW.summary,''),
        'still',COALESCE(NEW.still,''),'rating',COALESCE(NEW.rating,0),'airDate',COALESCE(NEW.air_date,''),'localMetadata',json(COALESCE(NEW.local_metadata_json,'null')))),0,0)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title,series_title=excluded.series_title,series_season=excluded.series_season,
      series_episode=excluded.series_episode,extension_json=json_patch(catalog_items.extension_json,excluded.extension_json);`;
  view(
    database,
    'episodes',
    `SELECT ${parent} media_id,c.series_season season,c.series_episode number,c.title,
      COALESCE(${metadata('summary')},'') summary,COALESCE(${metadata('still')},'') still,COALESCE(${metadata('rating')},0) rating,
      COALESCE(${metadata('airDate')},'') air_date,${metadata('localMetadata')} local_metadata_json
      FROM catalog_items c WHERE c.media_kind='episode' AND ${parent} IS NOT NULL AND COALESCE(json_extract(c.extension_json,'$.nativeEpisodeHidden'),0)=0
        AND COALESCE(json_extract(c.extension_json,'$.nativeRemoved'),0)=0`,
    episodeInsert,
    `UPDATE catalog_items SET extension_json=json_set(extension_json,'$.nativeEpisodeHidden',json('true'))
      WHERE media_kind='episode' AND json_extract(extension_json,'$.seriesId')=OLD.media_id AND series_season=OLD.season AND series_episode=OLD.number;`,
  );
  const destinationEpisodeId = episodeId.replaceAll('NEW.number', 'NEW.episode');
  const fileWrite = (previous = '') => {
    const fileEpisodeId = `COALESCE((SELECT media_id FROM media_sources WHERE locator=NEW.file_path),${previous ? `(SELECT media_id FROM media_sources WHERE locator=OLD.file_path),` : ''}${destinationEpisodeId})`;
    const sourceId = `COALESCE((SELECT id FROM media_sources WHERE locator=NEW.file_path),${fileEpisodeId}||':source:'||loom_root_id(NEW.file_path))`;
    const previousValue = (column: string, fallback = 'NULL') =>
      previous ? `COALESCE((SELECT ${column} FROM media_sources WHERE locator=OLD.file_path),${fallback})` : fallback;
    const sourceMetadata = `json_object('nativeLocalMetadata',json(COALESCE(NEW.local_metadata_json,'null')),
      'subtitles',json(COALESCE(NEW.subtitles_json,'[]')),'title',NEW.title,'thumbnail',NEW.thumbnail,'still',NEW.still)`;
    return `${requireSeries}
      SELECT CASE WHEN EXISTS(SELECT 1 FROM catalog_items WHERE id=${fileEpisodeId} AND media_kind!='episode')
        THEN RAISE(ABORT,'Native episode identity belongs to another catalog kind') END;
      SELECT CASE WHEN EXISTS(SELECT 1 FROM media_sources s JOIN catalog_items c ON c.id=s.media_id
        WHERE s.locator=NEW.file_path AND c.media_kind!='episode')
        THEN RAISE(ABORT,'Native episode source belongs to another catalog kind') END;
      ${
        previous
          ? `SELECT CASE WHEN NEW.file_path!=OLD.file_path AND EXISTS(SELECT 1 FROM media_sources old JOIN media_sources replacement
        ON old.locator=OLD.file_path AND replacement.locator=NEW.file_path WHERE old.media_id!=replacement.media_id)
        THEN RAISE(ABORT,'Replacement episode path belongs to another media identity') END;`
          : ''
      }
      INSERT INTO catalog_items(id,media_type,media_kind,title,anime_likely,series_title,series_season,series_episode,extension_json,created_at,updated_at)
        VALUES(${fileEpisodeId},'tv','episode',COALESCE(NEW.title,''),COALESCE((SELECT anime_likely FROM catalog_items WHERE id=NEW.media_id),0),
          (SELECT title FROM catalog_items WHERE id=NEW.media_id),NEW.season,NEW.episode,json_object('seriesId',NEW.media_id),0,0)
        ON CONFLICT(id) DO NOTHING;
      UPDATE catalog_items SET
        title=COALESCE(NULLIF(title,''),(SELECT title FROM catalog_items WHERE id=${destinationEpisodeId}),COALESCE(NEW.title,'')),
        extension_json=json_patch(COALESCE((SELECT extension_json FROM catalog_items WHERE id=${destinationEpisodeId} AND id!=${fileEpisodeId}),'{}'),extension_json)
        WHERE id=${fileEpisodeId};
      DELETE FROM catalog_items WHERE id=${destinationEpisodeId} AND id!=${fileEpisodeId}
        AND id=NEW.media_id||':episode:'||NEW.season||':'||NEW.episode
        AND NOT EXISTS(SELECT 1 FROM media_sources WHERE media_id=catalog_items.id)
        AND NOT EXISTS(SELECT 1 FROM watch_progress WHERE media_id=catalog_items.id)
        AND NOT EXISTS(SELECT 1 FROM watch_history WHERE media_id=catalog_items.id)
        AND NOT EXISTS(SELECT 1 FROM profile_list_entries WHERE media_id=catalog_items.id)
        AND NOT EXISTS(SELECT 1 FROM media_identity_aliases WHERE media_id=catalog_items.id);
      UPDATE catalog_items SET anime_likely=COALESCE((SELECT anime_likely FROM catalog_items WHERE id=NEW.media_id),anime_likely),
        series_title=(SELECT title FROM catalog_items WHERE id=NEW.media_id),series_season=NEW.season,series_episode=NEW.episode,
        extension_json=json_set(extension_json,'$.seriesId',NEW.media_id,'$.nativeRemoved',json('false'),'$.nativeEpisodeHidden',json('false'))
        WHERE id=${fileEpisodeId};
      ${previous}
      INSERT INTO media_sources(id,media_id,root_id,relative_path,locator,state,file_extension,size_bytes,modified_at_ms,indexed_at,last_seen_at,probe_json,extension_json)
        VALUES(${sourceId},${fileEpisodeId},
          (SELECT id FROM library_roots WHERE state!='removed' AND loom_contains(locator,NEW.file_path) ORDER BY length(locator) DESC LIMIT 1),
          loom_relative(COALESCE((SELECT locator FROM library_roots WHERE state!='removed' AND loom_contains(locator,NEW.file_path) ORDER BY length(locator) DESC LIMIT 1),NEW.file_path),NEW.file_path),
          NEW.file_path,${previousValue("CASE WHEN state='missing' THEN COALESCE(json_extract(extension_json,'$.nativePreviousState'),'online') ELSE state END", "'online'")},
          loom_extension(NEW.file_path),${previousValue('size_bytes')},${previousValue('modified_at_ms')},${previousValue('indexed_at', '0')},${previousValue('last_seen_at')},
          ${previous ? `(SELECT json_set(probe_json,'$.sourceId',${sourceId}) FROM media_sources WHERE locator=OLD.file_path)` : 'NULL'},
          ${previous ? `json_patch(${previousValue('extension_json', "'{}'")},${sourceMetadata})` : sourceMetadata})
        ON CONFLICT(id) DO UPDATE SET media_id=excluded.media_id,root_id=excluded.root_id,relative_path=excluded.relative_path,locator=excluded.locator,
          state=${restoredSourceState},
          extension_json=json_patch(media_sources.extension_json,excluded.extension_json);`;
  };
  view(
    database,
    'episode_files',
    `SELECT ${parent} media_id,c.series_season season,c.series_episode episode,s.locator file_path,
      COALESCE(json_extract(s.extension_json,'$.title'),c.title) title,
      COALESCE(json_extract(s.extension_json,'$.thumbnail'),${metadata('thumbnail')}) thumbnail,
      COALESCE(json_extract(s.extension_json,'$.still'),${metadata('still')}) still,COALESCE(json_extract(s.extension_json,'$.subtitles'),'[]') subtitles_json,
      COALESCE(json_extract(s.extension_json,'$.nativeLocalMetadata'),s.probe_json) local_metadata_json FROM catalog_items c JOIN media_sources s ON s.media_id=c.id
      JOIN library_roots r ON r.id=s.root_id AND r.state!='removed'
      WHERE c.media_kind='episode' AND ${parent} IS NOT NULL AND s.state!='missing' AND COALESCE(json_extract(c.extension_json,'$.nativeRemoved'),0)=0`,
    fileWrite(),
    markSourcesMissing('locator=OLD.file_path'),
    fileWrite(markSourcesMissing('locator=OLD.file_path AND OLD.file_path!=NEW.file_path')),
  );

  const profileInsert = `
    INSERT OR IGNORE INTO devices(id,name,kind,disabled,created_at,updated_at) SELECT NEW.guest_device_id,'Local guest','desktop',1,0,0 WHERE NEW.guest_device_id IS NOT NULL;
    INSERT INTO profiles(id,name,kind,avatar_key,color_key,has_pin,guest_device_id,sort_order,created_at,updated_at,last_used_at)
      VALUES(NEW.id,NEW.name,CASE NEW.profile_type WHEN 'kid' THEN 'child' WHEN 'guest' THEN 'guest' ELSE 'adult' END,
        COALESCE(NEW.avatar_key,'glyph-01'),COALESCE(NEW.color_key,'ember'),NEW.pin_hash IS NOT NULL,NEW.guest_device_id,
        COALESCE(NEW.sort_order,0),COALESCE(NEW.created_at,0),COALESCE(NEW.updated_at,0),NEW.last_used_at)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,avatar_key=excluded.avatar_key,color_key=excluded.color_key,
        has_pin=excluded.has_pin,guest_device_id=excluded.guest_device_id,sort_order=excluded.sort_order,updated_at=excluded.updated_at,last_used_at=excluded.last_used_at;
    INSERT INTO meta(key,value) SELECT 'native_owner_profile',NEW.id WHERE NEW.profile_type='owner' ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    INSERT OR IGNORE INTO profile_assignments(profile_id,account_id,access,created_at) VALUES(NEW.id,${owner},'manage',COALESCE(NEW.created_at,0));
    DELETE FROM profile_credentials WHERE profile_id=NEW.id AND NEW.pin_hash IS NULL;
    INSERT INTO profile_credentials(profile_id,pin_salt,pin_hash,pin_algorithm,updated_at)
      SELECT NEW.id,NEW.pin_salt,NEW.pin_hash,'scrypt',COALESCE(NEW.updated_at,0) WHERE NEW.pin_hash IS NOT NULL AND NEW.pin_salt IS NOT NULL
      ON CONFLICT(profile_id) DO UPDATE SET pin_salt=excluded.pin_salt,pin_hash=excluded.pin_hash,updated_at=excluded.updated_at;`;
  view(
    database,
    'profiles',
    `SELECT p.id,p.name,p.avatar_key,p.color_key,
      CASE WHEN p.id=(SELECT value FROM meta WHERE key='native_owner_profile') THEN 'owner' WHEN p.kind='child' THEN 'kid' WHEN p.kind='guest' THEN 'guest' ELSE 'standard' END profile_type,
      pc.pin_hash,pc.pin_salt,p.created_at,p.updated_at,p.last_used_at,p.sort_order,p.kind='guest' is_guest,p.guest_device_id
      FROM profiles p LEFT JOIN profile_credentials pc ON pc.profile_id=p.id`,
    profileInsert,
    'DELETE FROM profiles WHERE id=OLD.id;',
  );
  view(
    database,
    'profile_preferences',
    `SELECT p.id profile_id,json_patch(COALESCE(n.payload_json,'{}'),loom_preferences(COALESCE(c.payload_json,'{}'),'native')) preferences_json,
      COALESCE(n.revision,0) revision,COALESCE(c.updated_at,n.updated_at,0) updated_at
      FROM profiles p LEFT JOIN native_profile_ui n ON n.profile_id=p.id LEFT JOIN profile_preferences c ON c.profile_id=p.id
      WHERE n.profile_id IS NOT NULL OR c.profile_id IS NOT NULL`,
    `INSERT INTO native_profile_ui(profile_id,payload_json,revision,updated_at) VALUES(NEW.profile_id,NEW.preferences_json,COALESCE(NEW.revision,1),COALESCE(NEW.updated_at,0))
      ON CONFLICT(profile_id) DO UPDATE SET payload_json=excluded.payload_json,revision=MAX(native_profile_ui.revision+1,excluded.revision),updated_at=excluded.updated_at;
      INSERT INTO profile_preferences(profile_id,payload_json,updated_at) VALUES(NEW.profile_id,loom_preferences(NEW.preferences_json,'canonical'),COALESCE(NEW.updated_at,0))
      ON CONFLICT(profile_id) DO UPDATE SET payload_json=json_patch(profile_preferences.payload_json,excluded.payload_json),updated_at=excluded.updated_at;`,
    'DELETE FROM native_profile_ui WHERE profile_id=OLD.profile_id; DELETE FROM profile_preferences WHERE profile_id=OLD.profile_id;',
  );
  view(
    database,
    'profile_restrictions',
    `SELECT profile_id,COALESCE(json_extract(payload_json,'$.country'),'US') country,
      json_extract(payload_json,'$.maximumAge') maximum_age,COALESCE(json_extract(payload_json,'$.allowUnrated'),
        (SELECT kind!='child' FROM profiles WHERE id=profile_restrictions.profile_id),0) allow_unrated,revision,
      COALESCE((SELECT restrictions_updated_at FROM native_profile_ui n WHERE n.profile_id=profile_restrictions.profile_id),0) updated_at FROM profile_restrictions`,
    `INSERT INTO profile_restrictions(profile_id,allowed_root_ids_json,payload_json,revision) VALUES(NEW.profile_id,NULL,
      json_object('country',COALESCE(NEW.country,'US'),'maximumAge',NEW.maximum_age,
        'allowUnrated',json(CASE WHEN COALESCE(NEW.allow_unrated,(SELECT kind!='child' FROM profiles WHERE id=NEW.profile_id),0) THEN 'true' ELSE 'false' END)),COALESCE(NEW.revision,1))
      ON CONFLICT(profile_id) DO UPDATE SET payload_json=excluded.payload_json,revision=MAX(profile_restrictions.revision+1,excluded.revision);
      INSERT INTO native_profile_ui(profile_id,restrictions_updated_at) VALUES(NEW.profile_id,COALESCE(NEW.updated_at,0))
      ON CONFLICT(profile_id) DO UPDATE SET restrictions_updated_at=excluded.restrictions_updated_at;`,
    'DELETE FROM profile_restrictions WHERE profile_id=OLD.profile_id;',
  );
  view(
    database,
    'profile_library_access',
    `SELECT g.profile_id,g.folder_path FROM profile_path_grants g
    LEFT JOIN profile_restrictions p ON p.profile_id=g.profile_id WHERE p.allowed_root_ids_json IS NULL UNION
    SELECT g.profile_id,CASE WHEN loom_contains(r.locator,g.folder_path) THEN g.folder_path ELSE r.locator END folder_path
      FROM profile_path_grants g JOIN profile_restrictions p ON p.profile_id=g.profile_id JOIN library_roots r
      ON r.id IN(SELECT value FROM json_each(p.allowed_root_ids_json)) AND (loom_contains(r.locator,g.folder_path) OR loom_contains(g.folder_path,r.locator)) UNION
    SELECT p.profile_id,r.locator folder_path FROM profile_restrictions p JOIN library_roots r
      ON r.id IN (SELECT value FROM json_each(p.allowed_root_ids_json)) WHERE NOT EXISTS(SELECT 1 FROM profile_path_grants g WHERE g.profile_id=p.profile_id)`,
    'INSERT OR IGNORE INTO profile_path_grants(profile_id,folder_path) VALUES(NEW.profile_id,NEW.folder_path);',
    'DELETE FROM profile_path_grants WHERE profile_id=OLD.profile_id AND folder_path=OLD.folder_path;',
  );
  view(
    database,
    'profile_media_lists',
    'SELECT profile_id,media_id,kind list_kind,created_at FROM profile_list_entries',
    'INSERT OR IGNORE INTO profile_list_entries(profile_id,media_id,kind,created_at) VALUES(NEW.profile_id,NEW.media_id,NEW.list_kind,NEW.created_at);',
    'DELETE FROM profile_list_entries WHERE profile_id=OLD.profile_id AND media_id=OLD.media_id AND kind=OLD.list_kind;',
  );

  const sourceMediaId =
    "COALESCE((SELECT media_id FROM media_sources WHERE locator=NEW.file_path),(SELECT media_id FROM media_identity_aliases WHERE alias=NEW.file_path LIMIT 1),'native-unresolved:'||loom_root_id(NEW.file_path))";
  view(
    database,
    'playback_progress',
    `SELECT p.profile_id,COALESCE(s.locator,l.locator,p.media_id) file_path,
      p.position_seconds position,p.duration_seconds duration,p.watched,p.updated_at FROM watch_progress p
      LEFT JOIN media_sources s ON s.id=(SELECT id FROM media_sources WHERE media_id=p.media_id ORDER BY state='online' DESC,indexed_at DESC LIMIT 1)
      LEFT JOIN native_progress_locators l ON l.profile_id=p.profile_id AND l.media_id=p.media_id`,
    `INSERT INTO native_progress_locators(profile_id,media_id,locator) VALUES(NEW.profile_id,${sourceMediaId},NEW.file_path)
      ON CONFLICT(profile_id,media_id) DO UPDATE SET locator=excluded.locator;
      INSERT OR IGNORE INTO watch_history(id,profile_id,media_id,event,position_seconds,occurred_at)
        VALUES('native:'||loom_root_id(NEW.profile_id||':'||NEW.file_path||':'||NEW.updated_at),NEW.profile_id,${sourceMediaId},
          CASE WHEN NEW.watched THEN 'completed' WHEN NEW.position=0 AND EXISTS(SELECT 1 FROM watch_progress WHERE profile_id=NEW.profile_id AND media_id=${sourceMediaId} AND watched=1)
            THEN 'unwatched' WHEN NEW.position=0 THEN 'started' ELSE 'progressed' END,MAX(0,NEW.position),NEW.updated_at);
      DELETE FROM watch_history WHERE id IN(SELECT id FROM watch_history WHERE profile_id=NEW.profile_id ORDER BY occurred_at DESC LIMIT -1 OFFSET 10000);
      INSERT INTO watch_progress(profile_id,media_id,position_seconds,duration_seconds,watched,updated_at)
      VALUES(NEW.profile_id,${sourceMediaId},MAX(0,NEW.position),MAX(0,NEW.duration),COALESCE(NEW.watched,0),NEW.updated_at)
      ON CONFLICT(profile_id,media_id) DO UPDATE SET position_seconds=excluded.position_seconds,duration_seconds=excluded.duration_seconds,watched=excluded.watched,updated_at=excluded.updated_at;`,
    `DELETE FROM watch_progress WHERE profile_id=OLD.profile_id AND media_id=COALESCE((SELECT media_id FROM media_sources WHERE locator=OLD.file_path),
      (SELECT media_id FROM native_progress_locators WHERE profile_id=OLD.profile_id AND locator=OLD.file_path),OLD.file_path);`,
  );
  view(
    database,
    'playback_track_preferences',
    'SELECT profile_id,scope,payload_json preferences_json,updated_at FROM track_preferences',
    `INSERT INTO track_preferences(profile_id,scope,payload_json,updated_at) VALUES(NEW.profile_id,NEW.scope,NEW.preferences_json,NEW.updated_at)
      ON CONFLICT(profile_id,scope) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at;`,
    'DELETE FROM track_preferences WHERE profile_id=OLD.profile_id AND scope=OLD.scope;',
  );
  view(
    database,
    'device_profile_selection_revisions',
    `SELECT device_id,MAX(revision) revision FROM (
      SELECT device_id,revision FROM native_selection_revisions UNION ALL
      SELECT device_id,revision FROM profile_selections WHERE account_id=${owner}) GROUP BY device_id`,
    `INSERT INTO native_selection_revisions(device_id,revision) VALUES(NEW.device_id,NEW.revision)
      ON CONFLICT(device_id) DO UPDATE SET revision=excluded.revision;`,
    'DELETE FROM native_selection_revisions WHERE device_id=OLD.device_id;',
  );
  view(
    database,
    'device_profile_selections',
    `SELECT device_id,profile_id,selected_at,automatic_sign_in,revision selection_revision FROM profile_selections
      WHERE account_id=${owner} AND profile_id IS NOT NULL`,
    `INSERT INTO profile_selections(account_id,device_id,profile_id,revision,automatic_sign_in,selected_at)
      VALUES(${owner},NEW.device_id,NEW.profile_id,COALESCE(NEW.selection_revision,0),COALESCE(NEW.automatic_sign_in,0),NEW.selected_at)
      ON CONFLICT(account_id,device_id) DO UPDATE SET profile_id=excluded.profile_id,revision=excluded.revision,
        automatic_sign_in=CASE WHEN profile_selections.profile_id=excluded.profile_id THEN profile_selections.automatic_sign_in ELSE excluded.automatic_sign_in END,
        selected_at=excluded.selected_at;`,
    `UPDATE profile_selections SET profile_id=NULL,automatic_sign_in=0,revision=revision+1
      WHERE account_id=${owner} AND device_id=OLD.device_id;`,
    `UPDATE profile_selections SET profile_id=NEW.profile_id,revision=NEW.selection_revision,
      automatic_sign_in=NEW.automatic_sign_in,selected_at=NEW.selected_at WHERE account_id=${owner} AND device_id=OLD.device_id;`,
  );
}

/** Translate repository table references without changing SQL data or comments. */
export function nativeVideoSql(sql: string): string {
  const names = new Set<string>(nativeVideoTables);
  const tokens = [
    ...sql.matchAll(
      /--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[:@$][A-Za-z_][A-Za-z_0-9]*|[A-Za-z_][A-Za-z_0-9]*|[^\s]/g,
    ),
  ]
    .map((match) => ({ value: match[0], start: match.index, end: match.index + match[0].length }))
    .filter((token) => !token.value.startsWith('--') && !token.value.startsWith('/*'));
  const tokenAt = (index: number) => {
    const token = tokens[index];
    if (!token) throw new Error('SQL token index is out of bounds.');
    return token;
  };
  const identifier = (value: string) => {
    if (value.startsWith('"')) return value.slice(1, -1).replaceAll('""', '"');
    if (value.startsWith('`')) return value.slice(1, -1).replaceAll('``', '`');
    if (value.startsWith('[')) return value.slice(1, -1);
    return /^[A-Za-z_][A-Za-z_0-9]*$/.test(value) ? value : '';
  };
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const relations = new Set<number>();
  const aliases = new Set<string>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokenAt(index);
    // Keywords are unquoted. Names after these keywords are relation names,
    // while names before a dot are table qualifiers used by repository joins.
    if (/^(FROM|JOIN|INTO|UPDATE)$/i.test(token.value)) {
      let relation = index + 1;
      // SQLite puts its conflict clause before the target table. Rename
      // operations use UPDATE OR IGNORE for progress and track preferences.
      if (/^UPDATE$/i.test(token.value) && /^OR$/i.test(tokens[relation]?.value || '')
        && /^(ROLLBACK|ABORT|FAIL|IGNORE|REPLACE)$/i.test(tokens[relation + 1]?.value || '')) relation += 2;
      if (tokens[relation + 1]?.value === '.') relation += 2;
      if (names.has(identifier(tokens[relation]?.value || '').toLowerCase())) relations.add(relation);
      const alias = /^AS$/i.test(tokens[relation + 1]?.value || '') ? relation + 2 : relation + 1;
      const aliasName = identifier(tokens[alias]?.value || '').toLowerCase();
      if (names.has(aliasName)) aliases.add(aliasName);
    }
  }
  for (let index = 0; index < tokens.length; index++) {
    const name = identifier(tokenAt(index).value).toLowerCase();
    if (tokens[index + 1]?.value === '.' && names.has(name) && !aliases.has(name)) relations.add(index);
  }
  for (const index of relations) {
    const token = tokenAt(index);
    edits.push({ ...token, value: quote(`native_${identifier(token.value).toLowerCase()}`) });
  }
  // Views reject UPSERT. Their INSERT triggers handle repository conflicts,
  // and plain INSERT prevents an outer REPLACE policy deleting related rows.
  for (let index = 0; index < tokens.length; index++) {
    if (!/^INSERT$/i.test(tokenAt(index).value)) continue;
    let into = index + 1;
    const conflict = /^OR$/i.test(tokens[into]?.value || '');
    if (conflict) into += 2;
    if (!/^INTO$/i.test(tokens[into]?.value || '')) continue;
    let relation = into + 1;
    if (tokens[relation + 1]?.value === '.') relation += 2;
    if (!relations.has(relation)) continue;
    if (conflict && /^REPLACE$/i.test(tokens[index + 2]?.value || '')) {
      edits.push({ start: tokenAt(index + 1).start, end: tokenAt(index + 2).end, value: '' });
    }
    let depth = 0;
    for (let next = relation + 1; next < tokens.length && tokenAt(next).value !== ';'; next++) {
      const token = tokenAt(next);
      if (token.value === '(') depth++;
      if (token.value === ')') depth--;
      if (depth !== 0 || !/^ON$/i.test(token.value) || !/^CONFLICT$/i.test(tokens[next + 1]?.value || '')) continue;
      let end = next + 2;
      for (; end < tokens.length; end++) {
        const part = tokenAt(end);
        if (part.value === '(') depth++;
        if (part.value === ')') depth--;
        if (depth === 0 && (part.value === ';' || /^RETURNING$/i.test(part.value))) break;
      }
      edits.push({ start: token.start, end: tokens[end]?.start ?? sql.length, value: '' });
      break;
    }
  }
  // An UPSERT body can itself contain a translated qualifier. Ignore edits
  // within removed bodies, then apply from the end so offsets stay valid.
  const removed = edits.filter((edit) => edit.value === '' && edit.end > edit.start);
  const kept = edits.filter(
    (edit) => !removed.some((range) => range !== edit && edit.start >= range.start && edit.end <= range.end),
  );
  return kept
    .sort((left, right) => right.start - left.start)
    .reduce((value, edit) => value.slice(0, edit.start) + edit.value + value.slice(edit.end), sql);
}
