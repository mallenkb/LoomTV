use crate::content_ratings::normalize as normalized_content_rating;
use crate::{metadata::MetadataProviderGateway, now, Error, Result, Store};
use futures_util::{stream, StreamExt};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::sync::Mutex;
use unicode_normalization::UnicodeNormalization;
mod tvmaze;

const ITEM_CONCURRENCY: usize = 2;
const MAX_ITEMS: usize = 100_000;
const MAX_LOCAL_EPISODES: usize = 5_000;
const MAX_LOCAL_SEASONS: usize = 64;
const MAX_PROVIDER_SEASONS: usize = 15;
const MAX_ARTWORK_CANDIDATES: usize = 32;
const MAX_CAST: usize = 20;
const MAX_STREAMING_PROVIDERS: usize = 64;
const QUICK_RETRY_COOLDOWN_MS: i64 = 10 * 60 * 1_000;

const ANILIST_DETAIL_QUERY: &str = r#"
query ($malId: Int, $search: String) {
  Media(idMal: $malId, search: $search, type: ANIME) {
    idMal
    title { userPreferred english native }
    description(asHtml: false)
    genres
    averageScore
    format
    startDate { year }
    coverImage { extraLarge large medium }
    characters(page: 1, perPage: 20, sort: [ROLE, FAVOURITES_DESC]) {
      edges {
        node { name { full } image { large medium } }
        role
        voiceActors { name { full } image { large medium } languageV2 }
      }
    }
  }
}
"#;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum Category {
    Core,
    Cast,
    Artwork,
    Ratings,
    Episodes,
    StreamingProviders,
}

impl Category {
    const ALL: [Self; 6] = [
        Self::Core,
        Self::Cast,
        Self::Artwork,
        Self::Ratings,
        Self::Episodes,
        Self::StreamingProviders,
    ];

    fn as_str(self) -> &'static str {
        match self {
            Self::Core => "core",
            Self::Cast => "cast",
            Self::Artwork => "artwork",
            Self::Ratings => "ratings",
            Self::Episodes => "episodes",
            Self::StreamingProviders => "streaming-providers",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ScanMode {
    Quick,
    Refresh,
}

impl ScanMode {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "quick" => Ok(Self::Quick),
            "full" | "metadata" => Ok(Self::Refresh),
            _ => Err(Error::new(
                "invalid_scan_mode",
                "Choose a supported library scan mode.",
            )),
        }
    }
}

#[derive(Clone)]
struct ItemSnapshot {
    id: String,
    kind: String,
    title: String,
    year: i64,
    provider_ids: Map<String, Value>,
    local_seasons: Vec<i64>,
    local_episodes: HashSet<(i64, i64)>,
    requested: HashSet<Category>,
}

#[derive(Clone, Default)]
struct EpisodePatch {
    season: i64,
    number: i64,
    title: String,
    summary: String,
    still: String,
    rating: f64,
    air_date: String,
}

#[derive(Clone, Default)]
struct SeasonPatch {
    number: i64,
    title: String,
}

#[derive(Clone, Default)]
struct MetadataPatch {
    title: Option<String>,
    year: Option<i64>,
    format: Option<String>,
    summary: Option<String>,
    rating: Option<f64>,
    content_rating: Option<String>,
    trailer_url: Option<String>,
    runtime: Option<String>,
    season_count: Option<i64>,
    episode_count: Option<i64>,
    genres: Vec<String>,
    cast: Vec<Value>,
    provider_ids: Map<String, Value>,
    provider_ratings: Map<String, Value>,
    content_ratings: Map<String, Value>,
    streaming_providers: Vec<Value>,
    poster: Option<String>,
    backdrop: Option<String>,
    logo: Option<String>,
    poster_candidates: Vec<String>,
    backdrop_candidates: Vec<String>,
    logo_candidates: Vec<String>,
    seasons: Vec<SeasonPatch>,
    episodes: Vec<EpisodePatch>,
}

impl MetadataPatch {
    fn categories(&self) -> HashSet<Category> {
        let mut result = HashSet::new();
        if self.title.is_some()
            || self.year.is_some()
            || self.format.is_some()
            || self.summary.is_some()
            || self.trailer_url.is_some()
            || self.runtime.is_some()
            || self.season_count.is_some()
            || self.episode_count.is_some()
            || !self.genres.is_empty()
            || !self.provider_ids.is_empty()
        {
            result.insert(Category::Core);
        }
        if !self.cast.is_empty() {
            result.insert(Category::Cast);
        }
        if self.poster.is_some()
            || self.backdrop.is_some()
            || self.logo.is_some()
            || !self.poster_candidates.is_empty()
            || !self.backdrop_candidates.is_empty()
            || !self.logo_candidates.is_empty()
        {
            result.insert(Category::Artwork);
        }
        if self.rating.is_some()
            || self.content_rating.is_some()
            || !self.provider_ratings.is_empty()
            || !self.content_ratings.is_empty()
        {
            result.insert(Category::Ratings);
        }
        if !self.seasons.is_empty() || !self.episodes.is_empty() {
            result.insert(Category::Episodes);
        }
        if !self.streaming_providers.is_empty() {
            result.insert(Category::StreamingProviders);
        }
        result
    }

    fn has_values(&self) -> bool {
        !self.categories().is_empty()
    }
}

struct FetchOutcome {
    item: ItemSnapshot,
    patch: MetadataPatch,
    attempted: bool,
    errors: Vec<String>,
    cancelled: bool,
}

/// Enriches the current shared catalog without holding the database mutex across
/// provider requests. Quick mode fills incomplete fields. Full and metadata modes
/// refresh provider-owned display fields while retaining selected artwork and
/// metadata categories locked by the user.
pub async fn enrich_library_metadata(
    store: Arc<Mutex<Store>>,
    gateway: &MetadataProviderGateway,
    expected_profile: &str,
    expected_revision: i64,
    mode: &str,
    emit: Arc<dyn Fn(Value) + Send + Sync>,
    cancelled: Arc<AtomicBool>,
) -> Result<Value> {
    check_cancelled(&cancelled)?;
    let mode = ScanMode::parse(mode)?;
    let (settings, items) = snapshot_items(
        &store,
        expected_profile,
        expected_revision,
        mode,
        None,
        true,
    )
    .await?;

    if settings
        .get("metadataOfflineMode")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        check_cancelled(&cancelled)?;
        return Ok(json!({
            "offline": true,
            "totalItems": items.len(),
            "attemptedItems": 0,
            "updatedItems": 0,
            "failedItems": 0,
            "skippedItems": items.len(),
        }));
    }

    let total = items.len();
    let settings = Arc::new(settings);
    let mut outcomes = stream::iter(items.into_iter().map(|item| {
        let settings = settings.clone();
        let cancelled = cancelled.clone();
        async move { fetch_item(gateway, settings.as_ref(), item, &cancelled).await }
    }))
    .buffer_unordered(ITEM_CONCURRENCY);

    let mut completed = 0usize;
    let mut attempted = 0usize;
    let mut updated = 0usize;
    let mut failed = 0usize;
    let mut skipped = 0usize;
    let mut failures = Vec::new();

    while let Some(outcome) = outcomes.next().await {
        if outcome.cancelled {
            return Err(cancelled_error());
        }
        check_cancelled(&cancelled)?;
        completed += 1;
        if outcome.attempted {
            attempted += 1;
        }

        let patch_categories = outcome.patch.categories();
        let changed = if outcome.patch.has_values() {
            commit_patch(
                MetadataWriteContext {
                    store: &store,
                    expected_profile,
                    expected_revision,
                    owner_required: true,
                },
                mode,
                &outcome.item,
                &outcome.patch,
                &patch_categories,
                outcome.errors.last().map(String::as_str),
                &cancelled,
            )
            .await?
        } else if outcome.attempted {
            let message = outcome
                .errors
                .last()
                .map(String::as_str)
                .unwrap_or("No matching provider metadata was returned.");
            record_attempt(
                MetadataWriteContext {
                    store: &store,
                    expected_profile,
                    expected_revision,
                    owner_required: true,
                },
                &outcome.item.id,
                &outcome.item.requested,
                &HashSet::new(),
                Some(message),
                &cancelled,
            )
            .await?;
            false
        } else {
            false
        };

        if changed {
            updated += 1;
        } else if outcome.attempted && !outcome.patch.has_values() {
            failed += 1;
            if failures.len() < 32 {
                failures.push(json!({
                    "mediaId": outcome.item.id,
                    "error": outcome.errors.last().cloned().unwrap_or_else(|| {
                        "No matching provider metadata was returned.".to_owned()
                    }),
                }));
            }
        } else if !outcome.attempted {
            skipped += 1;
        }

        emit(json!({
            "phase": "metadata",
            "completedItems": completed,
            "totalItems": total,
            "updatedItems": updated,
            "failedItems": failed,
        }));
    }

    Ok(json!({
        "offline": false,
        "totalItems": total,
        "attemptedItems": attempted,
        "updatedItems": updated,
        "failedItems": failed,
        "skippedItems": skipped,
        "failures": failures,
    }))
}

/// Fills incomplete fields for one authorized catalog item. A blank ID, an
/// inaccessible item, offline mode, or an item with no usable provider returns
/// `false` without recording a provider failure.
pub async fn refresh_incomplete_metadata(
    store: Arc<Mutex<Store>>,
    gateway: &MetadataProviderGateway,
    expected_profile: &str,
    expected_revision: i64,
    media_id: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<bool> {
    let media_id = media_id.trim();
    if media_id.is_empty() || media_id.len() > 512 {
        return Ok(false);
    }
    check_cancelled(&cancelled)?;
    let (settings, mut items) = snapshot_items(
        &store,
        expected_profile,
        expected_revision,
        ScanMode::Quick,
        Some(media_id),
        false,
    )
    .await?;
    if settings
        .get("metadataOfflineMode")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(false);
    }
    let Some(item) = items.pop() else {
        return Ok(false);
    };
    let outcome = fetch_item(gateway, &settings, item, &cancelled).await;
    if outcome.cancelled {
        return Err(cancelled_error());
    }
    let patch_categories = outcome.patch.categories();
    if outcome.patch.has_values() {
        return commit_patch(
            MetadataWriteContext {
                store: &store,
                expected_profile,
                expected_revision,
                owner_required: false,
            },
            ScanMode::Quick,
            &outcome.item,
            &outcome.patch,
            &patch_categories,
            outcome.errors.last().map(String::as_str),
            &cancelled,
        )
        .await;
    }
    if outcome.attempted {
        let message = outcome
            .errors
            .last()
            .map(String::as_str)
            .unwrap_or("No matching provider metadata was returned.");
        record_attempt(
            MetadataWriteContext {
                store: &store,
                expected_profile,
                expected_revision,
                owner_required: false,
            },
            &outcome.item.id,
            &outcome.item.requested,
            &HashSet::new(),
            Some(message),
            &cancelled,
        )
        .await?;
    }
    Ok(false)
}

/// Returns the authorized item's cached TMDB providers, or fills the missing
/// list through the metadata gateway when a stored TMDB ID and key are present.
pub async fn streaming_providers(
    store: Arc<Mutex<Store>>,
    gateway: &MetadataProviderGateway,
    expected_profile: &str,
    expected_revision: i64,
    media_id: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<Value> {
    let media_id = media_id.trim();
    if media_id.is_empty() || media_id.len() > 512 {
        return Ok(json!([]));
    }
    check_cancelled(&cancelled)?;
    let (settings, kind, provider_ids, cached, attempted_at, locked) = {
        let store = store.lock().await;
        if !authorize_access(
            &store,
            expected_profile,
            expected_revision,
            Some(media_id),
            false,
        )? {
            return Ok(json!([]));
        }
        let row = store
            .db
            .query_row(
                "SELECT type,provider_ids_json,streaming_providers_json FROM media_items WHERE id=?",
                [media_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((kind, provider_ids, cached)) = row else {
            return Ok(json!([]));
        };
        let state = store
            .db
            .query_row(
                "SELECT attempted_at,locked FROM media_metadata_refresh_state WHERE media_id=? AND category='streaming-providers'",
                [media_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, bool>(1)?)),
            )
            .optional()?
            .unwrap_or((0, false));
        (
            store.metadata_settings()?,
            kind,
            provider_ids.as_deref().map(json_object).unwrap_or_default(),
            sanitized_streaming_providers(cached.as_deref().map(json_array).unwrap_or_default()),
            state.0,
            state.1,
        )
    };

    if !cached.is_empty()
        || locked
        || settings
            .get("metadataOfflineMode")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || !credential_is_configured(&settings, "tmdb", "tmdbApiKey")
        || now().saturating_sub(attempted_at) < 5 * 60 * 1_000
    {
        return Ok(Value::Array(cached));
    }
    let Some(tmdb_id) = provider_ids
        .get("tmdbId")
        .and_then(Value::as_str)
        .filter(|value| valid_numeric_id(value))
    else {
        return Ok(Value::Array(cached));
    };

    check_cancelled(&cancelled)?;
    let media_type = if kind == "movie" { "movie" } else { "tv" };
    let response = gateway
        .request_metadata_provider(
            &json!({
                "provider":"tmdb",
                "path":format!("{media_type}/{tmdb_id}/watch/providers"),
            }),
            &settings,
        )
        .await;
    let requested = HashSet::from([Category::StreamingProviders]);
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            record_attempt(
                MetadataWriteContext {
                    store: &store,
                    expected_profile,
                    expected_revision,
                    owner_required: false,
                },
                media_id,
                &requested,
                &HashSet::new(),
                Some(&error.message),
                &cancelled,
            )
            .await?;
            return Ok(Value::Array(cached));
        }
    };
    let providers = tmdb_streaming_providers_response(&response);
    if providers.is_empty() {
        record_attempt(
            MetadataWriteContext {
                store: &store,
                expected_profile,
                expected_revision,
                owner_required: false,
            },
            media_id,
            &requested,
            &requested,
            None,
            &cancelled,
        )
        .await?;
        return Ok(Value::Array(cached));
    }

    let item = ItemSnapshot {
        id: media_id.to_owned(),
        kind,
        title: String::new(),
        year: 0,
        provider_ids,
        local_seasons: Vec::new(),
        local_episodes: HashSet::new(),
        requested,
    };
    let patch = MetadataPatch {
        streaming_providers: providers.clone(),
        ..MetadataPatch::default()
    };
    let categories = patch.categories();
    commit_patch(
        MetadataWriteContext {
            store: &store,
            expected_profile,
            expected_revision,
            owner_required: false,
        },
        ScanMode::Refresh,
        &item,
        &patch,
        &categories,
        None,
        &cancelled,
    )
    .await?;
    Ok(Value::Array(providers))
}

async fn snapshot_items(
    store: &Arc<Mutex<Store>>,
    expected_profile: &str,
    expected_revision: i64,
    mode: ScanMode,
    media_filter: Option<&str>,
    owner_required: bool,
) -> Result<(Value, Vec<ItemSnapshot>)> {
    let store = store.lock().await;
    if !authorize_access(
        &store,
        expected_profile,
        expected_revision,
        media_filter,
        owner_required,
    )? {
        return Ok((json!({}), Vec::new()));
    }
    let settings = store.metadata_settings()?;
    let mut statement = store.db.prepare(
        "SELECT id,type,format,title,year,summary,rating,content_rating,poster,backdrop,\
         genres_json,cast_json,provider_ratings_json,content_ratings_json,provider_ids_json,\
         streaming_providers_json FROM media_items ORDER BY id LIMIT ?",
    )?;
    let rows = statement
        .query_map([MAX_ITEMS as i64 + 1], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, f64>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, String>(11)?,
                row.get::<_, String>(12)?,
                row.get::<_, String>(13)?,
                row.get::<_, Option<String>>(14)?,
                row.get::<_, Option<String>>(15)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(statement);
    if rows.len() > MAX_ITEMS {
        return Err(Error::new(
            "metadata_scan_limit",
            "The catalog is too large for one metadata pass.",
        ));
    }

    let mut season_statement = store.db.prepare(
        "SELECT DISTINCT season FROM episode_files WHERE media_id=? ORDER BY season LIMIT ?",
    )?;
    let mut episode_statement = store.db.prepare(
        "SELECT DISTINCT season,episode FROM episode_files WHERE media_id=? ORDER BY season,episode LIMIT ?",
    )?;
    let mut state_statement = store.db.prepare(
        "SELECT category,attempted_at,locked FROM media_metadata_refresh_state WHERE media_id=?",
    )?;
    let mut result = Vec::new();
    let current_time = now();

    for row in rows {
        let (
            id,
            kind,
            format,
            title,
            year,
            summary,
            rating,
            content_rating,
            poster,
            backdrop,
            genres_json,
            cast_json,
            provider_ratings_json,
            content_ratings_json,
            provider_ids_json,
            streaming_providers_json,
        ) = row;
        if media_filter.is_some_and(|media_id| media_id != id) {
            continue;
        }
        if format.eq_ignore_ascii_case("image") || title.trim().is_empty() {
            continue;
        }

        let local_seasons = season_statement
            .query_map(params![&id, MAX_LOCAL_SEASONS as i64 + 1], |row| row.get(0))?
            .collect::<std::result::Result<Vec<i64>, _>>()?;
        if local_seasons.len() > MAX_LOCAL_SEASONS {
            continue;
        }
        let local_episode_rows = episode_statement
            .query_map(params![&id, MAX_LOCAL_EPISODES as i64 + 1], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .collect::<std::result::Result<Vec<(i64, i64)>, _>>()?;
        if local_episode_rows.len() > MAX_LOCAL_EPISODES {
            continue;
        }
        let local_episodes = local_episode_rows.into_iter().collect::<HashSet<_>>();

        let mut locked = HashSet::new();
        let mut attempted_at = HashMap::new();
        for state in state_statement
            .query_map([&id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
        {
            if state.2 {
                locked.insert(state.0.clone());
            }
            attempted_at.insert(state.0, state.1);
        }

        let array_empty = |raw: &str| {
            serde_json::from_str::<Value>(raw)
                .ok()
                .and_then(|value| value.as_array().map(Vec::is_empty))
                .unwrap_or(true)
        };
        let object_empty = |raw: &str| {
            serde_json::from_str::<Value>(raw)
                .ok()
                .and_then(|value| value.as_object().map(Map::is_empty))
                .unwrap_or(true)
        };
        let episode_incomplete = if kind == "movie" || local_episodes.is_empty() {
            false
        } else {
            store.db.query_row(
                "SELECT EXISTS(SELECT 1 FROM episode_files f LEFT JOIN episodes e ON \
                 e.media_id=f.media_id AND e.season=f.season AND e.number=f.episode \
                 WHERE f.media_id=? AND (e.media_id IS NULL OR e.title='' OR e.summary='' \
                 OR e.still='' OR e.air_date='' OR e.rating<=0))",
                [&id],
                |row| row.get(0),
            )?
        };

        let mut requested = if mode == ScanMode::Refresh {
            Category::ALL.into_iter().collect::<HashSet<_>>()
        } else {
            let mut missing = HashSet::new();
            if year <= 0 || summary.trim().is_empty() || array_empty(&genres_json) {
                missing.insert(Category::Core);
            }
            if rating <= 0.0
                || (content_rating.trim().is_empty() && object_empty(&content_ratings_json))
                || object_empty(&provider_ratings_json)
            {
                missing.insert(Category::Ratings);
            }
            if poster.trim().is_empty() || backdrop.trim().is_empty() {
                missing.insert(Category::Artwork);
            }
            if array_empty(&cast_json) {
                missing.insert(Category::Cast);
            }
            if episode_incomplete {
                missing.insert(Category::Episodes);
            }
            if array_empty(streaming_providers_json.as_deref().unwrap_or("[]")) {
                missing.insert(Category::StreamingProviders);
            }
            missing
        };
        requested.retain(|category| {
            !locked.contains(category.as_str())
                && (mode == ScanMode::Refresh
                    || attempted_at.get(category.as_str()).is_none_or(|last| {
                        current_time.saturating_sub(*last) >= QUICK_RETRY_COOLDOWN_MS
                    }))
        });
        if requested.is_empty() {
            continue;
        }

        let provider_ids = provider_ids_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        result.push(ItemSnapshot {
            id,
            kind,
            title,
            year,
            provider_ids,
            local_seasons,
            local_episodes,
            requested,
        });
    }
    Ok((settings, result))
}

async fn fetch_item(
    gateway: &MetadataProviderGateway,
    settings: &Value,
    item: ItemSnapshot,
    cancelled: &AtomicBool,
) -> FetchOutcome {
    let mut patch = MetadataPatch::default();
    let mut attempted = false;
    let mut errors = Vec::new();

    if cancelled.load(Ordering::SeqCst) {
        return FetchOutcome {
            item,
            patch,
            attempted,
            errors,
            cancelled: true,
        };
    }

    if credential_is_configured(settings, "tmdb", "tmdbApiKey") {
        attempted = true;
        match fetch_tmdb(gateway, settings, &item, cancelled).await {
            Ok(Some(value)) => merge_patch(&mut patch, value, false),
            Ok(None) => {}
            Err(error) => errors.push(error.message),
        }
    }
    if credential_is_configured(settings, "omdb", "omdbApiKey") {
        if cancelled.load(Ordering::SeqCst) {
            return FetchOutcome {
                item,
                patch,
                attempted,
                errors,
                cancelled: true,
            };
        }
        attempted = true;
        match fetch_omdb(gateway, settings, &item, cancelled).await {
            Ok(Some(value)) => merge_patch(&mut patch, value, false),
            Ok(None) => {}
            Err(error) => errors.push(error.message),
        }
    }
    let has_metadata_key = credential_is_configured(settings, "tmdb", "tmdbApiKey")
        || credential_is_configured(settings, "omdb", "omdbApiKey");
    if item.kind != "movie" && (!has_metadata_key || patch.summary.is_none()) {
        if !cancelled.load(Ordering::SeqCst) {
            attempted = true;
            match tvmaze::fetch(gateway, settings, &item, cancelled).await {
                Ok(Some(value)) => merge_patch(&mut patch, value, false),
                Ok(None) => {},
                Err(error) => errors.push(error.message),
            }
        }
    }
    if item.kind == "anime" && patch.summary.is_none() {
        if cancelled.load(Ordering::SeqCst) {
            return FetchOutcome {
                item,
                patch,
                attempted,
                errors,
                cancelled: true,
            };
        }
        attempted = true;
        match fetch_anilist(gateway, settings, &item, cancelled).await {
            Ok(Some(value)) => merge_patch(&mut patch, value, true),
            Ok(None) => {}
            Err(error) => errors.push(error.message),
        }
    }

    patch.episodes.retain(|episode| {
        item.local_episodes
            .contains(&(episode.season, episode.number))
    });
    patch
        .seasons
        .retain(|season| item.local_seasons.contains(&season.number));

    FetchOutcome {
        item,
        patch,
        attempted,
        errors,
        cancelled: false,
    }
}

fn credential_is_configured(settings: &Value, provider: &str, legacy: &str) -> bool {
    settings
        .get("metadataApiKeys")
        .and_then(Value::as_object)
        .and_then(|keys| keys.get(provider))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
        || settings
            .get(legacy)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
}

async fn fetch_tmdb(
    gateway: &MetadataProviderGateway,
    settings: &Value,
    item: &ItemSnapshot,
    cancelled: &AtomicBool,
) -> Result<Option<MetadataPatch>> {
    check_cancelled(cancelled)?;
    let media_type = if item.kind == "movie" { "movie" } else { "tv" };
    let mut tmdb_id = item
        .provider_ids
        .get("tmdbId")
        .and_then(Value::as_str)
        .filter(|value| valid_numeric_id(value))
        .map(str::to_owned);

    if tmdb_id.is_none() {
        check_cancelled(cancelled)?;
        let mut query = Map::new();
        query.insert("query".into(), json!(item.title));
        if item.year > 0 {
            query.insert(
                if media_type == "movie" {
                    "year"
                } else {
                    "first_air_date_year"
                }
                .into(),
                json!(item.year),
            );
        }
        let response = gateway
            .request_metadata_provider(
                &json!({"provider":"tmdb","path":format!("search/{media_type}"),"query":query}),
                settings,
            )
            .await?;
        tmdb_id = matching_tmdb_hit(&response, media_type, &item.title, item.year)
            .and_then(|hit| hit.get("id"))
            .and_then(value_id);
    }
    let Some(tmdb_id) = tmdb_id else {
        return Ok(None);
    };

    let append = if media_type == "movie" {
        "credits,images,external_ids,release_dates,watch/providers,videos"
    } else {
        "credits,images,external_ids,content_ratings,watch/providers,videos"
    };
    let details = gateway
        .request_metadata_provider(
            &json!({
                "provider":"tmdb",
                "path":format!("{media_type}/{tmdb_id}"),
                "query":{"append_to_response":append},
            }),
            settings,
        )
        .await?;
    let mut patch = tmdb_details(&details, media_type, &tmdb_id);

    if media_type == "tv" && item.requested.contains(&Category::Episodes) {
        for season in item.local_seasons.iter().take(MAX_PROVIDER_SEASONS) {
            check_cancelled(cancelled)?;
            if *season < 0 {
                continue;
            }
            let response = gateway
                .request_metadata_provider(
                    &json!({
                        "provider":"tmdb",
                        "path":format!("tv/{tmdb_id}/season/{season}"),
                    }),
                    settings,
                )
                .await;
            let Ok(response) = response else {
                continue;
            };
            for episode in response
                .get("episodes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .take(MAX_LOCAL_EPISODES)
            {
                let season = integer(episode.get("season_number")).unwrap_or(*season);
                let Some(number) = integer(episode.get("episode_number")) else {
                    continue;
                };
                patch.episodes.push(EpisodePatch {
                    season,
                    number,
                    title: text(episode.get("name")),
                    summary: text(episode.get("overview")),
                    still: tmdb_image(episode.get("still_path"), "w780"),
                    rating: number_value(episode.get("vote_average")).unwrap_or(0.0),
                    air_date: text(episode.get("air_date")),
                });
            }
        }
    }
    Ok(Some(patch))
}

fn matching_tmdb_hit<'a>(
    response: &'a Value,
    media_type: &str,
    local_title: &str,
    local_year: i64,
) -> Option<&'a Value> {
    let normalized = normalize_title(local_title);
    let title_matches = response
        .get("results")?
        .as_array()?
        .iter()
        .take(20)
        .filter(|hit| {
            ["title", "name", "original_title", "original_name"]
                .iter()
                .any(|key| normalize_title(&text(hit.get(*key))) == normalized)
        })
        .collect::<Vec<_>>();
    if local_year > 0 {
        if let Some(exact) = title_matches.iter().find(|hit| {
            let date = if media_type == "movie" {
                hit.get("release_date")
            } else {
                hit.get("first_air_date")
            };
            year_from_date(&text(date)) == Some(local_year)
        }) {
            return Some(*exact);
        }
    }
    title_matches.into_iter().next()
}

fn tmdb_details(details: &Value, media_type: &str, tmdb_id: &str) -> MetadataPatch {
    let mut patch = MetadataPatch {
        title: nonempty(if media_type == "movie" {
            text(details.get("title"))
        } else {
            text(details.get("name"))
        }),
        year: year_from_date(&text(if media_type == "movie" {
            details.get("release_date")
        } else {
            details.get("first_air_date")
        })),
        summary: nonempty(text(details.get("overview"))),
        rating: positive_number(details.get("vote_average")),
        runtime: integer(details.get("runtime"))
            .or_else(|| {
                details
                    .get("episode_run_time")
                    .and_then(Value::as_array)
                    .and_then(|values| values.first())
                    .and_then(|value| integer(Some(value)))
            })
            .filter(|minutes| *minutes > 0)
            .map(|minutes| format!("{minutes}m")),
        season_count: integer(details.get("number_of_seasons")),
        episode_count: integer(details.get("number_of_episodes")),
        trailer_url: tmdb_trailer(details),
        genres: details
            .get("genres")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|genre| nonempty(text(genre.get("name"))))
            .take(64)
            .collect(),
        cast: tmdb_cast(details),
        ..MetadataPatch::default()
    };
    patch.provider_ids.insert("tmdbId".into(), json!(tmdb_id));
    if let Some(value) = details
        .get("imdb_id")
        .or_else(|| details.pointer("/external_ids/imdb_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        patch.provider_ids.insert("imdbId".into(), json!(value));
    }
    if let Some(value) = details.pointer("/external_ids/tvdb_id").and_then(value_id) {
        patch.provider_ids.insert("tvdbId".into(), json!(value));
    }

    patch.poster_candidates = tmdb_artwork_candidates(details, "poster_path", "posters");
    patch.backdrop_candidates = tmdb_artwork_candidates(details, "backdrop_path", "backdrops");
    patch.logo_candidates = tmdb_artwork_candidates(details, "", "logos");
    patch.poster = patch.poster_candidates.first().cloned();
    patch.backdrop = patch.backdrop_candidates.first().cloned();
    patch.logo = patch.logo_candidates.first().cloned();
    patch.content_ratings = tmdb_content_ratings(details);
    patch.content_rating = patch
        .content_ratings
        .get("US")
        .and_then(|value| value.get("code"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    patch.streaming_providers = tmdb_streaming_providers(details);
    patch.seasons = details
        .get("seasons")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|season| {
            let number = integer(season.get("season_number"))?;
            (number >= 0).then(|| SeasonPatch {
                number,
                title: text(season.get("name")),
            })
        })
        .take(MAX_LOCAL_SEASONS)
        .collect();
    patch
}

async fn fetch_omdb(
    gateway: &MetadataProviderGateway,
    settings: &Value,
    item: &ItemSnapshot,
    cancelled: &AtomicBool,
) -> Result<Option<MetadataPatch>> {
    check_cancelled(cancelled)?;
    let imdb_id = item
        .provider_ids
        .get("imdbId")
        .and_then(Value::as_str)
        .filter(|value| value.starts_with("tt") && value.len() <= 32);
    let mut lookups = Vec::new();
    if let Some(imdb_id) = imdb_id {
        lookups.push(json!({"i":imdb_id}));
    }
    if item.year > 0 {
        lookups.push(json!({"t":item.title,"y":item.year}));
    }
    lookups.push(json!({"t":item.title}));
    let mut response = None;
    for lookup in lookups {
        check_cancelled(cancelled)?;
        let mut query = lookup.as_object().cloned().unwrap_or_default();
        query.insert("plot".into(), json!("full"));
        query.insert(
            "type".into(),
            json!(if item.kind == "movie" {
                "movie"
            } else {
                "series"
            }),
        );
        let candidate = gateway
            .request_metadata_provider(&json!({"provider":"omdb","query":query}), settings)
            .await?;
        if candidate.get("Response").and_then(Value::as_str) == Some("False") {
            continue;
        }
        let used_id = candidate
            .get("imdbID")
            .and_then(Value::as_str)
            .is_some_and(|value| imdb_id == Some(value));
        if used_id || normalize_title(&text(candidate.get("Title"))) == normalize_title(&item.title)
        {
            response = Some(candidate);
            break;
        }
    }
    let Some(response) = response else {
        return Ok(None);
    };
    let mut patch = MetadataPatch {
        title: nonempty(text(response.get("Title"))),
        year: text(response.get("Year"))
            .get(0..4)
            .and_then(|year| year.parse::<i64>().ok()),
        summary: valid_omdb_text(response.get("Plot")),
        content_rating: valid_omdb_text(response.get("Rated")),
        runtime: valid_omdb_text(response.get("Runtime")),
        genres: valid_omdb_text(response.get("Genre"))
            .map(|value| {
                value
                    .split(',')
                    .filter_map(|genre| nonempty(genre.trim().to_owned()))
                    .take(64)
                    .collect()
            })
            .unwrap_or_default(),
        poster: secure_url(response.get("Poster").and_then(Value::as_str)),
        ..MetadataPatch::default()
    };
    if let Some(value) = patch.poster.clone() {
        patch.poster_candidates.push(value);
    }
    if let Some(value) = valid_omdb_text(response.get("imdbID")) {
        patch.provider_ids.insert("imdbId".into(), json!(value));
    }
    patch.rating = parse_score(response.get("imdbRating"), 10.0);
    patch.provider_ratings = omdb_provider_ratings(&response);
    if let Some(code) = patch.content_rating.clone() {
        if let Some(rating) = normalized_content_rating("US", &code, "omdb") {
            patch.content_ratings.insert("US".into(), rating);
        }
    }
    Ok(Some(patch))
}

async fn fetch_anilist(
    gateway: &MetadataProviderGateway,
    settings: &Value,
    item: &ItemSnapshot,
    cancelled: &AtomicBool,
) -> Result<Option<MetadataPatch>> {
    check_cancelled(cancelled)?;
    let mal_id = item
        .provider_ids
        .get("malId")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0);
    let mut lookups = Vec::new();
    if let Some(mal_id) = mal_id {
        lookups.push((true, json!({"malId":mal_id})));
    }
    lookups.push((false, json!({"search":item.title})));
    let mut selected = None;
    let mut last_error = None;
    for (trusted_id, variables) in lookups {
        check_cancelled(cancelled)?;
        match gateway
            .request_metadata_provider(
                &json!({"provider":"anilist","query":ANILIST_DETAIL_QUERY,"variables":variables}),
                settings,
            )
            .await
        {
            Ok(response) => {
                let Some(media) = response.pointer("/data/Media") else {
                    continue;
                };
                let matches = trusted_id
                    || ["userPreferred", "english", "native"].iter().any(|key| {
                        media
                            .pointer(&format!("/title/{key}"))
                            .and_then(Value::as_str)
                            .is_some_and(|title| {
                                normalize_title(title) == normalize_title(&item.title)
                            })
                    });
                if matches {
                    selected = Some(media.clone());
                    break;
                }
            }
            Err(error) => last_error = Some(error),
        }
    }
    let Some(media) = selected else {
        return match last_error {
            Some(error) => Err(error),
            None => Ok(None),
        };
    };
    let titles = ["userPreferred", "english", "native"]
        .iter()
        .filter_map(|key| {
            media
                .pointer(&format!("/title/{key}"))
                .and_then(Value::as_str)
        })
        .filter(|title| !title.trim().is_empty())
        .collect::<Vec<_>>();
    let mut patch = MetadataPatch {
        title: titles.first().map(|value| (*value).to_owned()),
        year: integer(media.pointer("/startDate/year")),
        format: nonempty(text(media.get("format"))).map(|value| value.replace('_', " ")),
        summary: nonempty(strip_markup(&text(media.get("description")))),
        rating: positive_number(media.get("averageScore")).map(|value| value / 10.0),
        genres: media
            .get("genres")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|value| value.as_str().and_then(|value| nonempty(value.to_owned())))
            .take(64)
            .collect(),
        poster: ["extraLarge", "large", "medium"].iter().find_map(|key| {
            secure_url(
                media
                    .pointer(&format!("/coverImage/{key}"))
                    .and_then(Value::as_str),
            )
        }),
        ..MetadataPatch::default()
    };
    if let Some(value) = patch.poster.clone() {
        patch.poster_candidates.push(value);
    }
    if let Some(value) = media.get("idMal").and_then(value_id) {
        patch.provider_ids.insert("malId".into(), json!(value));
    }
    patch.cast = anilist_cast(&media);
    Ok(Some(patch))
}

fn merge_patch(target: &mut MetadataPatch, incoming: MetadataPatch, prefer_incoming: bool) {
    let choose = |current: &mut Option<String>, next: Option<String>| {
        if next.is_some() && (prefer_incoming || current.is_none()) {
            *current = next;
        }
    };
    choose(&mut target.title, incoming.title);
    if incoming.year.is_some() && (prefer_incoming || target.year.is_none()) {
        target.year = incoming.year;
    }
    choose(&mut target.format, incoming.format);
    choose(&mut target.summary, incoming.summary);
    if incoming.rating.is_some() && (prefer_incoming || target.rating.is_none()) {
        target.rating = incoming.rating;
    }
    choose(&mut target.content_rating, incoming.content_rating);
    choose(&mut target.trailer_url, incoming.trailer_url);
    choose(&mut target.runtime, incoming.runtime);
    if target.season_count.is_none() {
        target.season_count = incoming.season_count;
    }
    if target.episode_count.is_none() {
        target.episode_count = incoming.episode_count;
    }
    if !incoming.genres.is_empty() && (prefer_incoming || target.genres.is_empty()) {
        target.genres = incoming.genres;
    }
    if !incoming.cast.is_empty() && (prefer_incoming || target.cast.is_empty()) {
        target.cast = incoming.cast;
    }
    merge_objects(&mut target.provider_ids, incoming.provider_ids, false);
    merge_objects(
        &mut target.provider_ratings,
        incoming.provider_ratings,
        prefer_incoming,
    );
    merge_objects(
        &mut target.content_ratings,
        incoming.content_ratings,
        prefer_incoming,
    );
    if !incoming.streaming_providers.is_empty() && target.streaming_providers.is_empty() {
        target.streaming_providers = incoming.streaming_providers;
    }
    choose(&mut target.poster, incoming.poster);
    choose(&mut target.backdrop, incoming.backdrop);
    choose(&mut target.logo, incoming.logo);
    append_unique(
        &mut target.poster_candidates,
        incoming.poster_candidates,
        MAX_ARTWORK_CANDIDATES,
    );
    append_unique(
        &mut target.backdrop_candidates,
        incoming.backdrop_candidates,
        MAX_ARTWORK_CANDIDATES,
    );
    append_unique(
        &mut target.logo_candidates,
        incoming.logo_candidates,
        MAX_ARTWORK_CANDIDATES,
    );
    if target.seasons.is_empty() {
        target.seasons = incoming.seasons;
    }
    if target.episodes.is_empty() {
        target.episodes = incoming.episodes;
    }
}

struct MetadataWriteContext<'a> {
    store: &'a Arc<Mutex<Store>>,
    expected_profile: &'a str,
    expected_revision: i64,
    owner_required: bool,
}

async fn commit_patch(
    context: MetadataWriteContext<'_>,
    mode: ScanMode,
    item: &ItemSnapshot,
    patch: &MetadataPatch,
    patch_categories: &HashSet<Category>,
    partial_error: Option<&str>,
    cancelled: &AtomicBool,
) -> Result<bool> {
    let MetadataWriteContext {
        store,
        expected_profile,
        expected_revision,
        owner_required,
    } = context;
    check_cancelled(cancelled)?;
    let mut store = store.lock().await;
    check_cancelled(cancelled)?;
    if !authorize_access(
        &store,
        expected_profile,
        expected_revision,
        Some(&item.id),
        owner_required,
    )? {
        return Ok(false);
    }
    let transaction = store.db.transaction()?;
    let locked = locked_categories(&transaction, &item.id)?;
    let allowed = patch_categories
        .iter()
        .copied()
        .filter(|category| item.requested.contains(category) && !locked.contains(category))
        .collect::<HashSet<_>>();
    if allowed.is_empty() {
        transaction.commit()?;
        return Ok(false);
    }

    let current = transaction
        .query_row(
            "SELECT format,title,year,poster,backdrop,logo,summary,rating,content_rating,\
             trailer_url,runtime,season_count,episode_count,provider_ratings_json,genres_json,\
             cast_json,provider_ids_json,streaming_providers_json,poster_candidates_json,\
             backdrop_candidates_json,logo_candidates_json,content_ratings_json FROM media_items WHERE id=?",
            [&item.id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?, row.get::<_, f64>(7)?, row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?, row.get::<_, String>(10)?, row.get::<_, Option<i64>>(11)?,
                    row.get::<_, Option<i64>>(12)?, row.get::<_, String>(13)?, row.get::<_, String>(14)?,
                    row.get::<_, String>(15)?, row.get::<_, Option<String>>(16)?, row.get::<_, Option<String>>(17)?,
                    row.get::<_, String>(18)?, row.get::<_, String>(19)?, row.get::<_, String>(20)?,
                    row.get::<_, String>(21)?,
                ))
            },
        )
        .optional()?;
    let Some(current) = current else {
        transaction.commit()?;
        return Ok(false);
    };
    let refresh = mode == ScanMode::Refresh;
    let mut format = current.0;
    let mut title = current.1;
    let mut year = current.2;
    let mut poster = current.3;
    let mut backdrop = current.4;
    let mut logo = current.5;
    let mut summary = current.6;
    let mut rating = current.7;
    let mut content_rating = current.8;
    let mut trailer_url = current.9;
    let mut runtime = current.10;
    let mut season_count = current.11;
    let mut episode_count = current.12;
    let mut provider_ratings = json_object(&current.13);
    let mut genres = json_array_strings(&current.14);
    let mut cast = json_array(&current.15);
    let mut provider_ids = current.16.as_deref().map(json_object).unwrap_or_default();
    let mut streaming_providers = current.17.as_deref().map(json_array).unwrap_or_default();
    let mut poster_candidates = json_array_strings(&current.18);
    let mut backdrop_candidates = json_array_strings(&current.19);
    let mut logo_candidates = json_array_strings(&current.20);
    let mut content_ratings = json_object(&current.21);
    let before_item = json!({
        "format":format,"title":title,"year":year,"poster":poster,"backdrop":backdrop,
        "logo":logo,"summary":summary,"rating":rating,"contentRating":content_rating,
        "trailerUrl":trailer_url,"runtime":runtime,"seasonCount":season_count,
        "episodeCount":episode_count,"providerRatings":provider_ratings,"genres":genres,
        "cast":cast,"providerIds":provider_ids,"streamingProviders":streaming_providers,
        "posterCandidates":poster_candidates,"backdropCandidates":backdrop_candidates,
        "logoCandidates":logo_candidates,"contentRatings":content_ratings,
    });

    if allowed.contains(&Category::Core) {
        if title.trim().is_empty() {
            if let Some(value) = patch.title.clone() {
                title = value;
            }
        }
        if year <= 0 {
            year = patch.year.unwrap_or(year);
        }
        apply_text(&mut format, patch.format.as_ref(), refresh);
        apply_text(&mut summary, patch.summary.as_ref(), refresh);
        apply_text(&mut trailer_url, patch.trailer_url.as_ref(), refresh);
        apply_text(&mut runtime, patch.runtime.as_ref(), refresh);
        if refresh || season_count.is_none() {
            season_count = patch.season_count.or(season_count);
        }
        if refresh || episode_count.is_none() {
            episode_count = patch.episode_count.or(episode_count);
        }
        if !patch.genres.is_empty() && (refresh || genres.is_empty()) {
            genres = patch.genres.clone();
        }
        merge_objects(&mut provider_ids, patch.provider_ids.clone(), false);
    }
    if allowed.contains(&Category::Ratings) {
        if let Some(value) = patch
            .rating
            .filter(|value| value.is_finite() && *value > 0.0)
        {
            if refresh || rating <= 0.0 {
                rating = value;
            }
        }
        apply_text(&mut content_rating, patch.content_rating.as_ref(), refresh);
        if !patch.provider_ratings.is_empty() && (refresh || provider_ratings.is_empty()) {
            provider_ratings = patch.provider_ratings.clone();
        }
        if !patch.content_ratings.is_empty() {
            merge_objects(&mut content_ratings, patch.content_ratings.clone(), refresh);
        }
    }
    if allowed.contains(&Category::Artwork) {
        // A populated primary may be a custom reference or a user's official
        // selection. Provider refreshes only fill empty primaries.
        apply_text(&mut poster, patch.poster.as_ref(), false);
        apply_text(&mut backdrop, patch.backdrop.as_ref(), false);
        apply_text(&mut logo, patch.logo.as_ref(), false);
        append_unique(
            &mut poster_candidates,
            patch.poster_candidates.clone(),
            MAX_ARTWORK_CANDIDATES,
        );
        append_unique(
            &mut backdrop_candidates,
            patch.backdrop_candidates.clone(),
            MAX_ARTWORK_CANDIDATES,
        );
        append_unique(
            &mut logo_candidates,
            patch.logo_candidates.clone(),
            MAX_ARTWORK_CANDIDATES,
        );
    }
    if allowed.contains(&Category::Cast) && !patch.cast.is_empty() && (refresh || cast.is_empty()) {
        cast = patch.cast.clone();
    }
    if allowed.contains(&Category::StreamingProviders)
        && !patch.streaming_providers.is_empty()
        && (refresh || streaming_providers.is_empty())
    {
        streaming_providers = patch.streaming_providers.clone();
    }

    let after_item = json!({
        "format":format,"title":title,"year":year,"poster":poster,"backdrop":backdrop,
        "logo":logo,"summary":summary,"rating":rating,"contentRating":content_rating,
        "trailerUrl":trailer_url,"runtime":runtime,"seasonCount":season_count,
        "episodeCount":episode_count,"providerRatings":provider_ratings,"genres":genres,
        "cast":cast,"providerIds":provider_ids,"streamingProviders":streaming_providers,
        "posterCandidates":poster_candidates,"backdropCandidates":backdrop_candidates,
        "logoCandidates":logo_candidates,"contentRatings":content_ratings,
    });
    let item_changed = before_item != after_item;
    if item_changed {
        transaction.execute(
            "UPDATE media_items SET format=?,title=?,year=?,poster=?,backdrop=?,logo=?,summary=?,rating=?,\
             content_rating=?,trailer_url=?,runtime=?,season_count=?,episode_count=?,provider_ratings_json=?,\
             genres_json=?,cast_json=?,provider_ids_json=?,streaming_providers_json=?,poster_candidates_json=?,\
             backdrop_candidates_json=?,logo_candidates_json=?,content_ratings_json=?,updated_at=? WHERE id=?",
            params![
                format, title, year, poster, backdrop, logo, summary, rating, content_rating,
                trailer_url, runtime, season_count, episode_count,
                Value::Object(provider_ratings).to_string(), Value::Array(genres.into_iter().map(Value::String).collect()).to_string(),
                Value::Array(cast).to_string(), Value::Object(provider_ids).to_string(), Value::Array(streaming_providers).to_string(),
                Value::Array(poster_candidates.into_iter().map(Value::String).collect()).to_string(),
                Value::Array(backdrop_candidates.into_iter().map(Value::String).collect()).to_string(),
                Value::Array(logo_candidates.into_iter().map(Value::String).collect()).to_string(),
                Value::Object(content_ratings).to_string(), now(), item.id,
            ],
        )?;
    }

    let episodes_changed = if allowed.contains(&Category::Episodes) {
        commit_episodes(&transaction, &item.id, patch, refresh)?
    } else {
        false
    };
    record_attempt_tx(
        &transaction,
        &item.id,
        &item.requested,
        &allowed,
        partial_error,
    )?;
    transaction.commit()?;
    Ok(item_changed || episodes_changed)
}

fn commit_episodes(
    transaction: &Transaction<'_>,
    media_id: &str,
    patch: &MetadataPatch,
    refresh: bool,
) -> Result<bool> {
    let mut changed = false;
    for season in &patch.seasons {
        let current: Option<String> = transaction
            .query_row(
                "SELECT title FROM seasons WHERE media_id=? AND number=?",
                params![media_id, season.number],
                |row| row.get(0),
            )
            .optional()?;
        let Some(current) = current else {
            continue;
        };
        if is_generic_season_title(&current, season.number) && !season.title.trim().is_empty() {
            transaction.execute(
                "UPDATE seasons SET title=? WHERE media_id=? AND number=?",
                params![season.title, media_id, season.number],
            )?;
            changed = true;
        }
    }
    for episode in &patch.episodes {
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM episode_files WHERE media_id=? AND season=? AND episode=?)",
            params![media_id, episode.season, episode.number],
            |row| row.get(0),
        )?;
        if !exists {
            continue;
        }
        let current = transaction
            .query_row(
                "SELECT title,summary,still,rating,air_date FROM episodes WHERE media_id=? AND season=? AND number=?",
                params![media_id, episode.season, episode.number],
                |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,f64>(3)?,row.get::<_,String>(4)?)),
            )
            .optional()?;
        let (mut title, mut summary, mut still, mut rating, mut air_date) =
            current.clone().unwrap_or_else(|| {
                (
                    String::new(),
                    String::new(),
                    String::new(),
                    0.0,
                    String::new(),
                )
            });
        if is_generic_episode_title(&title, episode.number) && !episode.title.trim().is_empty() {
            title = episode.title.clone();
        }
        apply_text(
            &mut summary,
            nonempty(episode.summary.clone()).as_ref(),
            refresh,
        );
        apply_text(
            &mut still,
            secure_url(Some(&episode.still)).as_ref(),
            refresh,
        );
        if episode.rating > 0.0 && (refresh || rating <= 0.0) {
            rating = episode.rating;
        }
        apply_text(
            &mut air_date,
            nonempty(episode.air_date.clone()).as_ref(),
            refresh,
        );
        let next = (&title, &summary, &still, rating, &air_date);
        let differs = current
            .as_ref()
            .is_none_or(|value| next != (&value.0, &value.1, &value.2, value.3, &value.4));
        if differs {
            transaction.execute(
                "INSERT INTO episodes (media_id,season,number,title,summary,still,rating,air_date) VALUES (?,?,?,?,?,?,?,?) \
                 ON CONFLICT(media_id,season,number) DO UPDATE SET title=excluded.title,summary=excluded.summary,\
                 still=excluded.still,rating=excluded.rating,air_date=excluded.air_date",
                params![media_id,episode.season,episode.number,title,summary,still,rating,air_date],
            )?;
            changed = true;
        }
    }
    Ok(changed)
}

async fn record_attempt(
    context: MetadataWriteContext<'_>,
    media_id: &str,
    requested: &HashSet<Category>,
    successful: &HashSet<Category>,
    error: Option<&str>,
    cancelled: &AtomicBool,
) -> Result<()> {
    let MetadataWriteContext {
        store,
        expected_profile,
        expected_revision,
        owner_required,
    } = context;
    check_cancelled(cancelled)?;
    let mut store = store.lock().await;
    check_cancelled(cancelled)?;
    if !authorize_access(
        &store,
        expected_profile,
        expected_revision,
        Some(media_id),
        owner_required,
    )? {
        return Ok(());
    }
    let transaction = store.db.transaction()?;
    record_attempt_tx(&transaction, media_id, requested, successful, error)?;
    transaction.commit()?;
    Ok(())
}

fn record_attempt_tx(
    transaction: &Transaction<'_>,
    media_id: &str,
    requested: &HashSet<Category>,
    successful: &HashSet<Category>,
    error: Option<&str>,
) -> Result<()> {
    let locked = locked_categories(transaction, media_id)?;
    for category in requested {
        if locked.contains(category) {
            continue;
        }
        let succeeded = successful.contains(category);
        let error = (!succeeded)
            .then(|| error.unwrap_or("No matching provider metadata was returned."))
            .map(|value| value.chars().take(500).collect::<String>());
        transaction.execute(
            "INSERT INTO media_metadata_refresh_state (media_id,category,refreshed_at,attempted_at,last_error,locked) \
             VALUES (?,?,?,?,?,0) ON CONFLICT(media_id,category) DO UPDATE SET \
             refreshed_at=COALESCE(excluded.refreshed_at,media_metadata_refresh_state.refreshed_at),\
             attempted_at=excluded.attempted_at,last_error=excluded.last_error",
            params![
                media_id,
                category.as_str(),
                succeeded.then(now),
                now(),
                error,
            ],
        )?;
    }
    Ok(())
}

fn locked_categories(transaction: &Transaction<'_>, media_id: &str) -> Result<HashSet<Category>> {
    let mut statement = transaction.prepare(
        "SELECT category FROM media_metadata_refresh_state WHERE media_id=? AND locked=1",
    )?;
    let values = statement
        .query_map([media_id], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(values
        .into_iter()
        .filter_map(|value| match value.as_str() {
            "core" => Some(Category::Core),
            "cast" => Some(Category::Cast),
            "artwork" => Some(Category::Artwork),
            "ratings" => Some(Category::Ratings),
            "episodes" => Some(Category::Episodes),
            "streaming-providers" => Some(Category::StreamingProviders),
            _ => None,
        })
        .collect())
}

fn authorize_access(
    store: &Store,
    expected_profile: &str,
    expected_revision: i64,
    media_id: Option<&str>,
    owner_required: bool,
) -> Result<bool> {
    let active = if owner_required {
        store.require_owner()?
    } else {
        store.require_active(Some(expected_profile))?
    };
    if active != expected_profile || store.selection_revision() != expected_revision {
        return Err(Error::new(
            "scan_cancelled",
            "The profile changed during metadata refresh.",
        ));
    }
    if !owner_required {
        if let Some(media_id) = media_id {
            return store.can_access_item(media_id);
        }
    }
    Ok(true)
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<()> {
    if cancelled.load(Ordering::SeqCst) {
        Err(cancelled_error())
    } else {
        Ok(())
    }
}

fn cancelled_error() -> Error {
    Error::new("scan_cancelled", "The metadata refresh was cancelled.")
}

fn tmdb_artwork_candidates(details: &Value, primary: &str, collection: &str) -> Vec<String> {
    let mut paths = Vec::new();
    if !primary.is_empty() {
        if let Some(value) = details.get(primary).and_then(Value::as_str) {
            paths.push(value.to_owned());
        }
    }
    let mut images = details
        .pointer(&format!("/images/{collection}"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    images.sort_by(|left, right| {
        let language_score = |value: &Value| match value.get("iso_639_1").and_then(Value::as_str) {
            Some("en") => 2,
            None => 1,
            _ => 0,
        };
        language_score(right)
            .cmp(&language_score(left))
            .then_with(|| {
                number_value(right.get("vote_average"))
                    .unwrap_or(0.0)
                    .total_cmp(&number_value(left.get("vote_average")).unwrap_or(0.0))
            })
    });
    paths.extend(images.iter().filter_map(|image| {
        image
            .get("file_path")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }));
    let mut result = Vec::new();
    append_unique(
        &mut result,
        paths
            .into_iter()
            .filter(|path| path.starts_with('/'))
            .map(|path| format!("https://image.tmdb.org/t/p/original{path}"))
            .collect(),
        MAX_ARTWORK_CANDIDATES,
    );
    result
}

fn tmdb_cast(details: &Value) -> Vec<Value> {
    details
        .pointer("/credits/cast")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|credit| {
            let name = text(credit.get("name"));
            if name.trim().is_empty() {
                return None;
            }
            Some(json!({
                "name": name,
                "character": text(credit.get("character")),
                "image": tmdb_image(credit.get("profile_path"), "w500"),
            }))
        })
        .take(10)
        .collect()
}

fn anilist_cast(media: &Value) -> Vec<Value> {
    media
        .pointer("/characters/edges")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|edge| {
            let role = text(edge.get("role"));
            if !["MAIN", "SUPPORTING"].contains(&role.as_str()) {
                return None;
            }
            let character_name = text(edge.pointer("/node/name/full"));
            if character_name.trim().is_empty() {
                return None;
            }
            let voice_actor = edge
                .get("voiceActors")
                .and_then(Value::as_array)
                .and_then(|actors| {
                    actors.iter().find(|actor| {
                        text(actor.get("languageV2")).eq_ignore_ascii_case("japanese")
                    }).or_else(|| actors.first())
                });
            let voice_actor_name = voice_actor
                .map(|actor| text(actor.pointer("/name/full")))
                .unwrap_or_default();
            let voice_actor_image = voice_actor
                .and_then(|actor| secure_url(actor.pointer("/image/large").and_then(Value::as_str)))
                .unwrap_or_default();
            let character_image = secure_url(edge.pointer("/node/image/large").and_then(Value::as_str))
                .unwrap_or_default();
            Some(json!({
                "name": if voice_actor_name.is_empty() { &character_name } else { &voice_actor_name },
                "character": role,
                "image": voice_actor_image,
                "characterName": character_name,
                "characterRole": text(edge.get("role")),
                "characterImage": character_image,
                "voiceActorName": voice_actor_name,
                "voiceActorImage": voice_actor_image,
                "voiceActorLanguage": voice_actor.map(|actor| text(actor.get("languageV2"))).unwrap_or_default(),
            }))
        })
        .take(MAX_CAST)
        .collect()
}

fn tmdb_content_ratings(details: &Value) -> Map<String, Value> {
    let mut result = Map::new();
    for entry in details
        .pointer("/release_dates/results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let country = text(entry.get("iso_3166_1"));
        for release in entry
            .get("release_dates")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            accept_content_rating(
                &mut result,
                &country,
                &text(release.get("certification")),
                "tmdb",
            );
        }
    }
    for entry in details
        .pointer("/content_ratings/results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        accept_content_rating(
            &mut result,
            &text(entry.get("iso_3166_1")),
            &text(entry.get("rating")),
            "tmdb",
        );
    }
    result
}

fn accept_content_rating(result: &mut Map<String, Value>, country: &str, code: &str, source: &str) {
    let Some(rating) = normalized_content_rating(country, code, source) else {
        return;
    };
    let age = rating
        .get("minimumAge")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let existing_age = result
        .get(&country.to_uppercase())
        .and_then(|value| value.get("minimumAge"))
        .and_then(Value::as_i64)
        .unwrap_or(-1);
    if age > existing_age {
        result.insert(country.to_uppercase(), rating);
    }
}

fn omdb_provider_ratings(response: &Value) -> Map<String, Value> {
    let mut result = Map::new();
    let rating_source = |name: &str| {
        response
            .get("Ratings")
            .and_then(Value::as_array)
            .and_then(|ratings| {
                ratings
                    .iter()
                    .find(|rating| text(rating.get("Source")) == name)
            })
            .and_then(|rating| rating.get("Value"))
    };
    if let Some(value) = parse_score(
        response
            .get("imdbRating")
            .or_else(|| rating_source("Internet Movie Database")),
        10.0,
    ) {
        let votes = text(response.get("imdbVotes"))
            .replace(',', "")
            .parse::<i64>()
            .ok();
        let mut rating = json!({"value":value,"scale":10});
        if let Some(votes) = votes {
            rating["votes"] = json!(votes);
        }
        result.insert("imdb".into(), rating);
    }
    if let Some(value) = parse_score(rating_source("Rotten Tomatoes"), 100.0) {
        result.insert("rottenTomatoes".into(), json!({"value":value,"scale":100}));
    }
    if let Some(value) = parse_score(
        rating_source("Popcornmeter").or_else(|| rating_source("Rotten Tomatoes Audience Score")),
        100.0,
    ) {
        result.insert("popcornmeter".into(), json!({"value":value,"scale":100}));
    }
    if let Some(value) = parse_score(
        response
            .get("Metascore")
            .or_else(|| rating_source("Metacritic")),
        100.0,
    ) {
        result.insert("metacritic".into(), json!({"value":value,"scale":100}));
    }
    result
}

fn tmdb_streaming_providers(details: &Value) -> Vec<Value> {
    #[derive(Default)]
    struct Aggregate {
        name: String,
        logo: String,
        regions: HashSet<String>,
        offers: HashSet<String>,
    }
    let mut providers: BTreeMap<i64, Aggregate> = BTreeMap::new();
    let Some(regions) = details
        .pointer("/watch~1providers/results")
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    for (region, availability) in regions {
        for (group, offer) in [
            ("flatrate", "subscription"),
            ("free", "free"),
            ("ads", "ads"),
            ("rent", "rent"),
            ("buy", "buy"),
        ] {
            for provider in availability
                .get(group)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let Some(id) = integer(provider.get("provider_id")) else {
                    continue;
                };
                let name = text(provider.get("provider_name"));
                if name.trim().is_empty() {
                    continue;
                }
                let entry = providers.entry(id).or_default();
                entry.name = name;
                entry.logo = tmdb_image(provider.get("logo_path"), "original");
                entry.regions.insert(region.to_uppercase());
                entry.offers.insert(offer.to_owned());
            }
        }
    }
    providers
        .into_iter()
        .take(MAX_STREAMING_PROVIDERS)
        .map(|(id, provider)| {
            let mut regions = provider.regions.into_iter().collect::<Vec<_>>();
            regions.sort();
            let mut offers = provider.offers.into_iter().collect::<Vec<_>>();
            offers.sort();
            json!({
                "id":id,"name":provider.name,"logoUrl":provider.logo,"regions":regions,
                "offerTypes":offers,"availability":if regions.iter().any(|value| value=="US") {"preferred-region"} else {"other-region"},
                "source":"tmdb",
            })
        })
        .collect()
}

fn tmdb_streaming_providers_response(response: &Value) -> Vec<Value> {
    tmdb_streaming_providers(&json!({"watch/providers":response}))
}

fn sanitized_streaming_providers(values: Vec<Value>) -> Vec<Value> {
    values
        .into_iter()
        .filter_map(|value| {
            let mut provider = value.as_object()?.clone();
            let id = provider
                .get("id")?
                .as_f64()
                .filter(|value| value.is_finite())?;
            let name = provider.get("name")?.as_str()?.trim().to_owned();
            if name.is_empty() {
                return None;
            }
            let logo = provider
                .get("logoUrl")
                .and_then(Value::as_str)
                .and_then(|value| secure_url(Some(value)))
                .unwrap_or_default();
            provider.insert("id".into(), json!(id));
            provider.insert("name".into(), json!(name));
            provider.insert("logoUrl".into(), json!(logo));
            Some(Value::Object(provider))
        })
        .take(MAX_STREAMING_PROVIDERS)
        .collect()
}

fn tmdb_trailer(details: &Value) -> Option<String> {
    let videos = details.pointer("/videos/results")?.as_array()?;
    let selected = videos
        .iter()
        .filter(|video| {
            text(video.get("site")).eq_ignore_ascii_case("youtube")
                && !text(video.get("key")).is_empty()
        })
        .max_by_key(|video| {
            i32::from(text(video.get("type")).eq_ignore_ascii_case("trailer")) * 2
                + i32::from(
                    video
                        .get("official")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )
        })?;
    Some(format!(
        "https://www.youtube.com/watch?v={}",
        text(selected.get("key"))
    ))
}

fn apply_text(current: &mut String, incoming: Option<&String>, refresh: bool) {
    if let Some(value) = incoming.filter(|value| !value.trim().is_empty()) {
        if refresh || current.trim().is_empty() {
            *current = value.clone();
        }
    }
}

fn merge_objects(
    target: &mut Map<String, Value>,
    incoming: Map<String, Value>,
    incoming_wins: bool,
) {
    for (key, value) in incoming {
        if incoming_wins || !target.contains_key(&key) {
            target.insert(key, value);
        }
    }
}

fn append_unique(target: &mut Vec<String>, values: Vec<String>, limit: usize) {
    for value in values {
        if target.len() >= limit {
            break;
        }
        if !value.is_empty() && !target.contains(&value) {
            target.push(value);
        }
    }
}

fn json_object(raw: &str) -> Map<String, Value> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn json_array(raw: &str) -> Vec<Value> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
}

fn json_array_strings(raw: &str) -> Vec<String> {
    json_array(raw)
        .into_iter()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect()
}

fn value_id(value: &Value) -> Option<String> {
    match value {
        Value::String(value) if valid_numeric_id(value) => Some(value.clone()),
        Value::Number(value) => value
            .as_i64()
            .filter(|value| *value > 0)
            .map(|value| value.to_string()),
        _ => None,
    }
}

fn valid_numeric_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 20 && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned()
}

fn nonempty(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}

fn integer(value: Option<&Value>) -> Option<i64> {
    value.and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
    })
}

fn number_value(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn positive_number(value: Option<&Value>) -> Option<f64> {
    number_value(value).filter(|value| *value > 0.0)
}

fn parse_score(value: Option<&Value>, scale: f64) -> Option<f64> {
    let value = text(value);
    if value.is_empty() || value == "N/A" {
        return None;
    }
    value
        .trim_end_matches('%')
        .split('/')
        .next()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0 && *value <= scale)
}

fn valid_omdb_text(value: Option<&Value>) -> Option<String> {
    nonempty(text(value)).filter(|value| value != "N/A")
}

fn secure_url(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.starts_with("https://") {
        Some(value.to_owned())
    } else {
        value
            .strip_prefix("http://")
            .map(|value| format!("https://{value}"))
    }
}

fn tmdb_image(value: Option<&Value>, rendition: &str) -> String {
    value
        .and_then(Value::as_str)
        .filter(|path| path.starts_with('/'))
        .map(|path| format!("https://image.tmdb.org/t/p/{rendition}{path}"))
        .unwrap_or_default()
}

fn year_from_date(value: &str) -> Option<i64> {
    value.get(0..4).and_then(|year| year.parse::<i64>().ok())
}

fn normalize_title(value: &str) -> String {
    value
        .nfkd()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn strip_markup(value: &str) -> String {
    let mut result = String::new();
    let mut in_tag = false;
    for character in value.chars() {
        match character {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                result.push(' ');
            }
            _ if !in_tag => result.push(character),
            _ => {}
        }
    }
    result.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_generic_episode_title(value: &str, number: i64) -> bool {
    let normalized = value.trim().to_lowercase();
    normalized.is_empty()
        || normalized == format!("episode {number}")
        || normalized == format!("ep {number}")
        || normalized == format!("episode {number:02}")
        || normalized == format!("ep {number:02}")
}

fn is_generic_season_title(value: &str, number: i64) -> bool {
    let normalized = value.trim().to_lowercase().replace(' ', "");
    normalized.is_empty()
        || normalized == format!("season{number}")
        || normalized == format!("season{number:02}")
        || normalized == format!("series{number}")
        || normalized == format!("series{number:02}")
        || normalized == format!("s{number}")
        || normalized == format!("s{number:02}")
}
