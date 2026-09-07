use crate::{metadata::MetadataProviderGateway, now, Error, Result, Store};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::sync::Mutex;
use unicode_normalization::UnicodeNormalization;

const MAX_MEDIA_ID_BYTES: usize = 512;
const MAX_CANDIDATES: usize = 24;
const MAX_PROVIDER_RESULTS: usize = 5;
const MAX_LOCAL_SEASONS: usize = 15;
const MAX_LOCAL_EPISODES: usize = 5_000;
const MAX_ARTWORK_CANDIDATES: usize = 32;
const MAX_CAST: usize = 20;
const MAX_STREAMING_PROVIDERS: usize = 64;

const ANILIST_QUERY: &str = r#"
query ($malId: Int, $search: String) {
  Media(idMal: $malId, search: $search, type: ANIME) {
    idMal
    title { userPreferred english native }
    description(asHtml: false)
    genres
    averageScore
    format
    episodes
    duration
    startDate { year }
    coverImage { extraLarge large medium }
    bannerImage
    trailer { id site thumbnail }
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

#[derive(Clone)]
struct ItemSnapshot {
    id: String,
    kind: String,
    title: String,
    year: i64,
    provider_ids: Map<String, Value>,
    local_seasons: Vec<i64>,
    local_episodes: HashSet<(i64, i64)>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ApplyTarget {
    All,
    Poster,
    Cover,
    Logo,
    Summary,
    Episodes,
}

impl ApplyTarget {
    fn parse(value: Option<&str>) -> Self {
        match value {
            Some("poster") => Self::Poster,
            Some("cover") => Self::Cover,
            Some("logo") => Self::Logo,
            Some("summary") => Self::Summary,
            Some("episodes") => Self::Episodes,
            _ => Self::All,
        }
    }

    fn categories(self) -> &'static [&'static str] {
        match self {
            Self::All => &["core", "cast", "artwork", "ratings", "episodes"],
            Self::Summary => &["core"],
            Self::Episodes => &["episodes"],
            Self::Poster | Self::Cover | Self::Logo => &["artwork"],
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum RefreshTarget {
    All,
    Poster,
    Cover,
    Logo,
}

impl RefreshTarget {
    fn parse(value: Option<&str>) -> Self {
        match value {
            Some("poster") => Self::Poster,
            Some("cover") => Self::Cover,
            Some("logo") => Self::Logo,
            _ => Self::All,
        }
    }
}

struct RequestContext<'a> {
    store: Arc<Mutex<Store>>,
    gateway: &'a MetadataProviderGateway,
    settings: Value,
    profile: &'a str,
    revision: i64,
    cancelled: &'a AtomicBool,
}

impl RequestContext<'_> {
    async fn request(&self, request: Value) -> Result<Value> {
        authorize_owner(&self.store, self.profile, self.revision, self.cancelled).await?;
        let response = self
            .gateway
            .request_metadata_provider(&request, &self.settings)
            .await;
        authorize_owner(&self.store, self.profile, self.revision, self.cancelled).await?;
        response
    }
}

/// Returns provider candidates for the requested media item. The array shape
/// matches the Electron `artwork:official-candidates` result.
pub async fn official_candidates(
    store: Arc<Mutex<Store>>,
    gateway: &MetadataProviderGateway,
    expected_profile: &str,
    expected_revision: i64,
    media_id: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<Value> {
    validate_media_id(media_id)?;
    let (settings, item) = snapshot(
        &store,
        expected_profile,
        expected_revision,
        media_id,
        &cancelled,
    )
    .await?;
    reject_offline(&settings, "search metadata providers")?;
    let context = RequestContext {
        store,
        gateway,
        settings,
        profile: expected_profile,
        revision: expected_revision,
        cancelled: &cancelled,
    };
    Ok(Value::Array(fetch_candidates(&context, &item).await?))
}

/// Applies a fresh provider candidate, ignoring renderer-supplied metadata.
/// Target-specific artwork variants must belong to the re-fetched candidate.
pub async fn apply_official(
    store: Arc<Mutex<Store>>,
    gateway: &MetadataProviderGateway,
    expected_profile: &str,
    expected_revision: i64,
    media_id: &str,
    supplied_candidate: &Value,
    requested_target: Option<&str>,
    cancelled: Arc<AtomicBool>,
) -> Result<Value> {
    validate_media_id(media_id)?;
    let supplied = supplied_candidate
        .as_object()
        .ok_or_else(|| invalid("Choose a valid metadata candidate."))?;
    let supplied_id = supplied
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 512)
        .ok_or_else(|| invalid("Choose a valid metadata candidate."))?;
    let target = ApplyTarget::parse(requested_target);
    let (settings, item) = snapshot(
        &store,
        expected_profile,
        expected_revision,
        media_id,
        &cancelled,
    )
    .await?;
    reject_offline(&settings, "search metadata providers")?;
    let context = RequestContext {
        store: store.clone(),
        gateway,
        settings,
        profile: expected_profile,
        revision: expected_revision,
        cancelled: &cancelled,
    };
    let candidates = fetch_candidates(&context, &item).await?;
    let base_id = supplied_id.split(':').next().unwrap_or(supplied_id);
    let mut selected = candidates
        .into_iter()
        .find(|candidate| candidate.get("id").and_then(Value::as_str) == Some(base_id))
        .ok_or_else(|| {
            Error::new(
                "metadata_candidate_stale",
                "That metadata candidate is no longer available. Search again.",
            )
        })?;
    if supplied_id != base_id {
        apply_selected_artwork_variant(&mut selected, supplied, target)?;
    }
    commit_candidate(
        &store,
        expected_profile,
        expected_revision,
        &item,
        &selected,
        target,
        &cancelled,
    )
    .await
}

/// Refreshes official metadata or one artwork category using the supported
/// provider set and returns the Electron-compatible artwork result object.
pub async fn refresh_official(
    store: Arc<Mutex<Store>>,
    gateway: &MetadataProviderGateway,
    expected_profile: &str,
    expected_revision: i64,
    media_id: &str,
    requested_target: Option<&str>,
    cancelled: Arc<AtomicBool>,
) -> Result<Value> {
    validate_media_id(media_id)?;
    let refresh_target = RefreshTarget::parse(requested_target);
    let (settings, item) = snapshot(
        &store,
        expected_profile,
        expected_revision,
        media_id,
        &cancelled,
    )
    .await?;
    reject_offline(&settings, "refresh provider artwork")?;
    let context = RequestContext {
        store: store.clone(),
        gateway,
        settings,
        profile: expected_profile,
        revision: expected_revision,
        cancelled: &cancelled,
    };
    let candidates = fetch_candidates(&context, &item).await?;
    let Some(merged) = merge_refresh_candidates(candidates, &item) else {
        return current_result(
            &store,
            expected_profile,
            expected_revision,
            media_id,
            None,
            &cancelled,
        )
        .await;
    };
    let apply_target = match refresh_target {
        RefreshTarget::All => ApplyTarget::All,
        RefreshTarget::Poster => ApplyTarget::Poster,
        RefreshTarget::Cover => ApplyTarget::Cover,
        RefreshTarget::Logo => ApplyTarget::Logo,
    };
    let result = commit_candidate(
        &store,
        expected_profile,
        expected_revision,
        &item,
        &merged,
        apply_target,
        &cancelled,
    )
    .await?;
    Ok(match refresh_target {
        RefreshTarget::Poster => json!({
            "thumbnail": result.get("thumbnail").cloned().unwrap_or(Value::Null),
            "posterCandidates": result.get("posterCandidates").cloned().unwrap_or_else(|| json!([])),
        }),
        RefreshTarget::Cover => json!({
            "cover": result.get("cover").cloned().unwrap_or(Value::Null),
            "backdropCandidates": result.get("backdropCandidates").cloned().unwrap_or_else(|| json!([])),
        }),
        RefreshTarget::Logo => json!({
            "logo": result.get("logo").cloned().unwrap_or(Value::Null),
            "logoCandidates": result.get("logoCandidates").cloned().unwrap_or_else(|| json!([])),
        }),
        RefreshTarget::All => result,
    })
}

async fn snapshot(
    store: &Arc<Mutex<Store>>,
    profile: &str,
    revision: i64,
    media_id: &str,
    cancelled: &AtomicBool,
) -> Result<(Value, ItemSnapshot)> {
    authorize_owner(store, profile, revision, cancelled).await?;
    let store = store.lock().await;
    check_cancelled(cancelled)?;
    authorize_owner_locked(&store, profile, revision)?;
    let settings = store.metadata_settings()?;
    let row = store
        .db
        .query_row(
            "SELECT type,title,year,provider_ids_json FROM media_items WHERE id=?",
            [media_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(media_not_found)?;
    let local_seasons = store
        .db
        .prepare(
            "SELECT DISTINCT season FROM episode_files WHERE media_id=? ORDER BY season LIMIT ?",
        )?
        .query_map(params![media_id, MAX_LOCAL_SEASONS as i64 + 1], |row| {
            row.get(0)
        })?
        .collect::<std::result::Result<Vec<i64>, _>>()?;
    if local_seasons.len() > MAX_LOCAL_SEASONS {
        return Err(Error::new(
            "metadata_item_limit",
            "This item has too many seasons for one metadata request.",
        ));
    }
    let episode_rows = store
        .db
        .prepare("SELECT DISTINCT season,episode FROM episode_files WHERE media_id=? ORDER BY season,episode LIMIT ?")?
        .query_map(params![media_id, MAX_LOCAL_EPISODES as i64 + 1], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<std::result::Result<Vec<(i64, i64)>, _>>()?;
    if episode_rows.len() > MAX_LOCAL_EPISODES {
        return Err(Error::new(
            "metadata_item_limit",
            "This item has too many episodes for one metadata request.",
        ));
    }
    Ok((
        settings,
        ItemSnapshot {
            id: media_id.to_owned(),
            kind: row.0,
            title: row.1,
            year: row.2,
            provider_ids: row.3.as_deref().map(json_object).unwrap_or_default(),
            local_seasons,
            local_episodes: episode_rows.into_iter().collect(),
        },
    ))
}

async fn fetch_candidates(context: &RequestContext<'_>, item: &ItemSnapshot) -> Result<Vec<Value>> {
    let mut candidates = Vec::new();
    if credential_is_configured(&context.settings, "tmdb", "tmdbApiKey") {
        match fetch_tmdb_candidates(context, item).await {
            Ok(values) => candidates.extend(values),
            Err(error) if fatal_provider_error(&error) => return Err(error),
            Err(_) => {}
        }
    }
    if credential_is_configured(&context.settings, "omdb", "omdbApiKey") {
        match fetch_omdb_candidates(context, item).await {
            Ok(values) => candidates.extend(values),
            Err(error) if fatal_provider_error(&error) => return Err(error),
            Err(_) => {}
        }
    }
    if item.kind == "anime" {
        match fetch_anilist_candidate(context, item).await {
            Ok(Some(value)) => candidates.push(value),
            Ok(None) => {}
            Err(error) if fatal_provider_error(&error) => return Err(error),
            Err(_) => {}
        }
    }
    let mut seen = HashSet::new();
    candidates.retain(|candidate| {
        let key = format!(
            "{}:{}:{}:{}",
            text(candidate.get("source")),
            normalize_title(&text(candidate.get("title"))),
            integer(candidate.get("year")).unwrap_or(0),
            text(candidate.get("thumbnail")),
        );
        seen.insert(key)
    });
    candidates.sort_by(|left, right| {
        candidate_score(right, &item.title)
            .total_cmp(&candidate_score(left, &item.title))
            .then_with(|| text(left.get("source")).cmp(&text(right.get("source"))))
    });
    candidates.truncate(MAX_CANDIDATES);
    Ok(candidates)
}

async fn fetch_tmdb_candidates(
    context: &RequestContext<'_>,
    item: &ItemSnapshot,
) -> Result<Vec<Value>> {
    let media_type = if item.kind == "movie" { "movie" } else { "tv" };
    let mut ids = Vec::new();
    if let Some(id) = item
        .provider_ids
        .get("tmdbId")
        .and_then(Value::as_str)
        .filter(|value| valid_numeric_id(value))
    {
        ids.push(id.to_owned());
    }
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
    let search = context
        .request(json!({
            "provider":"tmdb",
            "path":format!("search/{media_type}"),
            "query":query,
        }))
        .await?;
    for id in search
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| value.get("id").and_then(value_id))
        .take(MAX_PROVIDER_RESULTS)
    {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let append = if media_type == "movie" {
        "credits,images,external_ids,release_dates,watch/providers,videos"
    } else {
        "credits,images,external_ids,content_ratings,watch/providers,videos"
    };
    let mut result = Vec::new();
    for id in ids.into_iter().take(MAX_PROVIDER_RESULTS) {
        let details = match context
            .request(json!({
                "provider":"tmdb",
                "path":format!("{media_type}/{id}"),
                "query":{"append_to_response":append},
            }))
            .await
        {
            Ok(value) => value,
            Err(error) if fatal_provider_error(&error) => return Err(error),
            Err(_) => continue,
        };
        let mut episodes = Vec::new();
        if media_type == "tv" {
            for season in &item.local_seasons {
                if *season < 0 {
                    continue;
                }
                let response = match context
                    .request(json!({
                        "provider":"tmdb",
                        "path":format!("tv/{id}/season/{season}"),
                    }))
                    .await
                {
                    Ok(value) => value,
                    Err(error) if fatal_provider_error(&error) => return Err(error),
                    Err(_) => continue,
                };
                for episode in response
                    .get("episodes")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .take(MAX_LOCAL_EPISODES)
                {
                    let season_number = integer(episode.get("season_number")).unwrap_or(*season);
                    let Some(number) = integer(episode.get("episode_number")) else {
                        continue;
                    };
                    if !item.local_episodes.contains(&(season_number, number)) {
                        continue;
                    }
                    episodes.push(json!({
                        "season":season_number,
                        "number":number,
                        "title":text(episode.get("name")),
                        "summary":text(episode.get("overview")),
                        "still":tmdb_image(episode.get("still_path"), "w780"),
                        "rating":positive_number(episode.get("vote_average")).unwrap_or(0.0),
                        "airDate":text(episode.get("air_date")),
                    }));
                }
            }
        }
        if let Some(candidate) = tmdb_candidate(&details, media_type, &id, episodes) {
            result.push(candidate);
        }
    }
    Ok(result)
}

fn tmdb_candidate(
    details: &Value,
    media_type: &str,
    tmdb_id: &str,
    episodes: Vec<Value>,
) -> Option<Value> {
    let title = if media_type == "movie" {
        text(details.get("title"))
    } else {
        text(details.get("name"))
    };
    if title.is_empty() {
        return None;
    }
    let year = year_from_date(&text(if media_type == "movie" {
        details.get("release_date")
    } else {
        details.get("first_air_date")
    }));
    let mut provider_ids = Map::new();
    provider_ids.insert("tmdbId".into(), json!(tmdb_id));
    if let Some(value) = details
        .get("imdb_id")
        .or_else(|| details.pointer("/external_ids/imdb_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        provider_ids.insert("imdbId".into(), json!(value));
    }
    if let Some(value) = details.pointer("/external_ids/tvdb_id").and_then(value_id) {
        provider_ids.insert("tvdbId".into(), json!(value));
    }
    let posters = tmdb_artwork_candidates(details, "poster_path", "posters");
    let backdrops = tmdb_artwork_candidates(details, "backdrop_path", "backdrops");
    let logos = tmdb_artwork_candidates(details, "", "logos");
    let content_ratings = tmdb_content_ratings(details);
    let content_rating = content_ratings
        .get("US")
        .and_then(|value| value.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let runtime = integer(details.get("runtime"))
        .or_else(|| {
            details
                .get("episode_run_time")
                .and_then(Value::as_array)
                .and_then(|values| values.first())
                .and_then(|value| integer(Some(value)))
        })
        .filter(|value| *value > 0)
        .map(|value| format!("{value}m"))
        .unwrap_or_default();
    let seasons = details
        .get("seasons")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|season| {
            let number = integer(season.get("season_number"))?;
            (number >= 0).then(|| {
                json!({
                    "number":number,
                    "title":text(season.get("name")),
                    "episodeCount":integer(season.get("episode_count")).unwrap_or(0),
                })
            })
        })
        .take(MAX_LOCAL_SEASONS)
        .collect::<Vec<_>>();
    make_candidate(
        "TMDB",
        json!({
            "providerIds":provider_ids,
            "format":if media_type == "movie" {"Movie"} else {"TV"},
            "title":title,
            "year":year,
            "poster":posters.first().cloned().unwrap_or_default(),
            "posterCandidates":posters,
            "backdrop":backdrops.first().cloned().unwrap_or_default(),
            "backdropCandidates":backdrops,
            "logo":logos.first().cloned().unwrap_or_default(),
            "logoCandidates":logos,
            "summary":text(details.get("overview")),
            "rating":positive_number(details.get("vote_average")).unwrap_or(0.0),
            "contentRating":content_rating,
            "trailerUrl":tmdb_trailer(details).unwrap_or_default(),
            "runtime":runtime,
            "seasonCount":integer(details.get("number_of_seasons")),
            "episodeCount":integer(details.get("number_of_episodes")),
            "providerRatings":{},
            "genres":details.get("genres").and_then(Value::as_array).into_iter().flatten().filter_map(|genre| nonempty(text(genre.get("name")))).take(64).collect::<Vec<_>>(),
            "seasons":seasons,
            "episodes":episodes,
            "contentRatings":content_ratings,
            "cast":tmdb_cast(details),
            "streamingProviders":tmdb_streaming_providers(details),
        }),
    )
}

async fn fetch_omdb_candidates(
    context: &RequestContext<'_>,
    item: &ItemSnapshot,
) -> Result<Vec<Value>> {
    let mut ids = Vec::new();
    if let Some(id) = item
        .provider_ids
        .get("imdbId")
        .and_then(Value::as_str)
        .filter(|value| valid_imdb_id(value))
    {
        ids.push(id.to_owned());
    }
    let mut search_query =
        json!({"s":item.title,"type":if item.kind=="movie" {"movie"} else {"series"}});
    if item.year > 0 {
        search_query["y"] = json!(item.year);
    }
    if let Ok(search) = context
        .request(json!({"provider":"omdb","query":search_query}))
        .await
    {
        for id in search
            .get("Search")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|value| value.get("imdbID").and_then(Value::as_str))
            .filter(|value| valid_imdb_id(value))
            .take(MAX_PROVIDER_RESULTS)
        {
            if !ids.iter().any(|existing| existing == id) {
                ids.push(id.to_owned());
            }
        }
    }
    if ids.is_empty() {
        let mut query = json!({
            "t":item.title,
            "plot":"full",
            "type":if item.kind=="movie" {"movie"} else {"series"},
        });
        if item.year > 0 {
            query["y"] = json!(item.year);
        }
        let response = context
            .request(json!({"provider":"omdb","query":query}))
            .await?;
        if response.get("Response").and_then(Value::as_str) != Some("False") {
            if let Some(candidate) = omdb_candidate(&response, &item.title) {
                return Ok(vec![candidate]);
            }
        }
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for id in ids.into_iter().take(MAX_PROVIDER_RESULTS) {
        let response = match context
            .request(json!({
                "provider":"omdb",
                "query":{"i":id,"plot":"full"},
            }))
            .await
        {
            Ok(value) => value,
            Err(error) if fatal_provider_error(&error) => return Err(error),
            Err(_) => continue,
        };
        if let Some(candidate) = omdb_candidate(&response, &item.title) {
            result.push(candidate);
        }
    }
    Ok(result)
}

fn omdb_candidate(response: &Value, fallback_title: &str) -> Option<Value> {
    if response.get("Response").and_then(Value::as_str) == Some("False") {
        return None;
    }
    let poster = valid_omdb_text(response.get("Poster"))
        .and_then(|value| official_url(&value))
        .unwrap_or_default();
    let mut provider_ids = Map::new();
    if let Some(id) = response
        .get("imdbID")
        .and_then(Value::as_str)
        .filter(|value| valid_imdb_id(value))
    {
        provider_ids.insert("imdbId".into(), json!(id));
    }
    let content_rating = valid_omdb_text(response.get("Rated")).unwrap_or_default();
    let mut content_ratings = Map::new();
    if let Some(value) = normalized_content_rating("US", &content_rating, "omdb") {
        content_ratings.insert("US".into(), value);
    }
    make_candidate(
        "OMDb",
        json!({
            "providerIds":provider_ids,
            "format":if text(response.get("Type")).eq_ignore_ascii_case("movie") {"Movie"} else {"TV"},
            "title":nonempty(text(response.get("Title"))).unwrap_or_else(|| fallback_title.to_owned()),
            "year":text(response.get("Year")).get(0..4).and_then(|value| value.parse::<i64>().ok()),
            "poster":poster,
            "posterCandidates":if poster.is_empty(){Vec::<String>::new()}else{vec![poster]},
            "backdrop":"",
            "backdropCandidates":[],
            "logo":"",
            "logoCandidates":[],
            "summary":valid_omdb_text(response.get("Plot")).unwrap_or_default(),
            "rating":parse_score(response.get("imdbRating"), 10.0).unwrap_or(0.0),
            "contentRating":content_rating,
            "runtime":valid_omdb_text(response.get("Runtime")).unwrap_or_default(),
            "providerRatings":omdb_provider_ratings(response),
            "genres":valid_omdb_text(response.get("Genre")).map(|value|value.split(',').filter_map(|genre|nonempty(genre.trim().to_owned())).take(64).collect::<Vec<_>>()).unwrap_or_default(),
            "contentRatings":content_ratings,
            "episodes":[],
            "seasons":[],
            "cast":[],
            "streamingProviders":[],
        }),
    )
}

async fn fetch_anilist_candidate(
    context: &RequestContext<'_>,
    item: &ItemSnapshot,
) -> Result<Option<Value>> {
    let mal_id = item
        .provider_ids
        .get("malId")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0);
    let variables = mal_id
        .map(|value| json!({"malId":value}))
        .unwrap_or_else(|| json!({"search":item.title}));
    let response = context
        .request(json!({
            "provider":"anilist",
            "query":ANILIST_QUERY,
            "variables":variables,
        }))
        .await?;
    let Some(media) = response.pointer("/data/Media") else {
        return Ok(None);
    };
    let title = ["userPreferred", "english", "native"]
        .iter()
        .find_map(|key| {
            media
                .pointer(&format!("/title/{key}"))
                .and_then(Value::as_str)
        })
        .unwrap_or(&item.title)
        .trim()
        .to_owned();
    let poster = ["extraLarge", "large", "medium"]
        .iter()
        .find_map(|key| {
            media
                .pointer(&format!("/coverImage/{key}"))
                .and_then(Value::as_str)
                .and_then(official_url)
        })
        .unwrap_or_default();
    let backdrop = media
        .get("bannerImage")
        .and_then(Value::as_str)
        .and_then(official_url)
        .unwrap_or_default();
    let mut provider_ids = Map::new();
    if let Some(value) = media.get("idMal").and_then(value_id) {
        provider_ids.insert("malId".into(), json!(value));
    }
    let trailer_url = match (
        text(media.pointer("/trailer/site"))
            .to_ascii_lowercase()
            .as_str(),
        text(media.pointer("/trailer/id")),
    ) {
        ("youtube", id) if !id.is_empty() => format!("https://www.youtube.com/watch?v={id}"),
        _ => String::new(),
    };
    Ok(make_candidate(
        "AniList",
        json!({
            "providerIds":provider_ids,
            "format":text(media.get("format")).replace('_', " "),
            "title":title,
            "year":integer(media.pointer("/startDate/year")),
            "poster":poster,
            "posterCandidates":if poster.is_empty(){Vec::<String>::new()}else{vec![poster]},
            "backdrop":backdrop,
            "backdropCandidates":if backdrop.is_empty(){Vec::<String>::new()}else{vec![backdrop]},
            "logo":"",
            "logoCandidates":[],
            "summary":strip_markup(&text(media.get("description"))),
            "rating":positive_number(media.get("averageScore")).map(|value|value/10.0).unwrap_or(0.0),
            "trailerUrl":trailer_url,
            "runtime":integer(media.get("duration")).filter(|value|*value>0).map(|value|format!("{value}m")).unwrap_or_default(),
            "episodeCount":integer(media.get("episodes")),
            "providerRatings":{},
            "genres":media.get("genres").and_then(Value::as_array).cloned().unwrap_or_default(),
            "contentRatings":{},
            "episodes":[],
            "seasons":[],
            "cast":anilist_cast(media),
            "streamingProviders":[],
        }),
    ))
}

fn make_candidate(source: &str, metadata: Value) -> Option<Value> {
    let object = metadata.as_object()?;
    let title = text(object.get("title"));
    let poster_candidates = official_urls(object.get("posterCandidates"));
    let backdrop_candidates = official_urls(object.get("backdropCandidates"));
    let logo_candidates = official_urls(object.get("logoCandidates"));
    let thumbnail = poster_candidates.first().cloned().unwrap_or_default();
    let cover = backdrop_candidates.first().cloned().unwrap_or_default();
    if title.is_empty() && thumbnail.is_empty() && cover.is_empty() {
        return None;
    }
    let year = integer(object.get("year")).unwrap_or(0);
    let id = candidate_id(source, &title, year, &thumbnail, &cover);
    let episodes = bounded_values(object.get("episodes"), MAX_LOCAL_EPISODES);
    let episode_preview = episodes
        .iter()
        .filter_map(|episode| {
            let title = nonempty(text(episode.get("title")))?;
            Some(format!(
                "S{:02}E{:02} {}",
                integer(episode.get("season")).unwrap_or(1),
                integer(episode.get("number")).unwrap_or(0),
                title
            ))
        })
        .take(4)
        .collect::<Vec<_>>();
    Some(json!({
        "id":id,
        "source":source,
        "providerIds":object.get("providerIds").cloned().unwrap_or_else(||json!({})),
        "format":text(object.get("format")),
        "title":title,
        "year":if year>0 {Some(year)} else {None},
        "thumbnail":thumbnail,
        "cover":cover,
        "summary":text(object.get("summary")),
        "rating":positive_number(object.get("rating")).unwrap_or(0.0),
        "contentRating":text(object.get("contentRating")),
        "trailerUrl":text(object.get("trailerUrl")),
        "runtime":text(object.get("runtime")),
        "seasonCount":integer(object.get("seasonCount")),
        "episodeCount":integer(object.get("episodeCount")).or_else(||(!episodes.is_empty()).then_some(episodes.len() as i64)),
        "providerRatings":object.get("providerRatings").cloned().unwrap_or_else(||json!({})),
        "genres":bounded_values(object.get("genres"), 64),
        "seasons":bounded_values(object.get("seasons"), MAX_LOCAL_SEASONS),
        "episodes":episodes,
        "episodePreview":episode_preview,
        "posterCandidates":poster_candidates,
        "backdropCandidates":backdrop_candidates,
        "logo":logo_candidates.first().cloned().unwrap_or_default(),
        "logoCandidates":logo_candidates,
        "contentRatings":object.get("contentRatings").cloned().unwrap_or_else(||json!({})),
        "cast":bounded_values(object.get("cast"), MAX_CAST),
        "streamingProviders":bounded_values(object.get("streamingProviders"), MAX_STREAMING_PROVIDERS),
        "originPlatform":object.get("originPlatform").cloned().unwrap_or(Value::Null),
    }))
}

fn merge_refresh_candidates(candidates: Vec<Value>, item: &ItemSnapshot) -> Option<Value> {
    let mut iter = candidates.into_iter();
    let mut result = iter.next()?;
    for candidate in iter {
        let source = text(candidate.get("source"));
        if source == "OMDb" {
            for key in ["providerRatings", "contentRatings"] {
                if candidate
                    .get(key)
                    .and_then(Value::as_object)
                    .is_some_and(|value| !value.is_empty())
                {
                    result[key] = candidate[key].clone();
                }
            }
            if positive_number(result.get("rating")).is_none() {
                result["rating"] = candidate["rating"].clone();
            }
        }
        for key in ["posterCandidates", "backdropCandidates", "logoCandidates"] {
            let mut values = official_urls(result.get(key));
            append_unique(
                &mut values,
                official_urls(candidate.get(key)),
                MAX_ARTWORK_CANDIDATES,
            );
            result[key] = json!(values);
        }
        if result
            .get("episodes")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
            && candidate
                .get("episodes")
                .and_then(Value::as_array)
                .is_some_and(|value| !value.is_empty())
        {
            result["episodes"] = candidate["episodes"].clone();
            result["episodeSource"] = candidate["source"].clone();
        }
        if result
            .get("streamingProviders")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
            && candidate
                .get("streamingProviders")
                .and_then(Value::as_array)
                .is_some_and(|value| !value.is_empty())
        {
            result["streamingProviders"] = candidate["streamingProviders"].clone();
        }
    }
    let mut ids = item.provider_ids.clone();
    if let Some(candidate_ids) = result.get("providerIds").and_then(Value::as_object) {
        for (key, value) in candidate_ids {
            ids.insert(key.clone(), value.clone());
        }
    }
    result["providerIds"] = Value::Object(ids);
    let posters = official_urls(result.get("posterCandidates"));
    let backdrops = official_urls(result.get("backdropCandidates"));
    let logos = official_urls(result.get("logoCandidates"));
    result["thumbnail"] = json!(posters.first().cloned().unwrap_or_default());
    result["cover"] = json!(backdrops.first().cloned().unwrap_or_default());
    result["logo"] = json!(logos.first().cloned().unwrap_or_default());
    Some(result)
}

fn apply_selected_artwork_variant(
    selected: &mut Value,
    supplied: &Map<String, Value>,
    target: ApplyTarget,
) -> Result<()> {
    let (primary, candidates) = match target {
        ApplyTarget::Poster => ("thumbnail", "posterCandidates"),
        ApplyTarget::Cover => ("cover", "backdropCandidates"),
        ApplyTarget::Logo => ("logo", "logoCandidates"),
        _ => {
            return Err(invalid(
                "Artwork variants can only be applied to poster, cover, or logo.",
            ))
        }
    };
    let requested = supplied
        .get(primary)
        .and_then(Value::as_str)
        .and_then(official_url)
        .ok_or_else(|| invalid("Choose valid official artwork."))?;
    let allowed = official_urls(selected.get(candidates));
    if !allowed.contains(&requested) {
        return Err(Error::new(
            "metadata_candidate_stale",
            "That artwork is no longer available. Search again.",
        ));
    }
    selected[primary] = json!(requested);
    selected[candidates] = json!([requested]);
    Ok(())
}

async fn commit_candidate(
    store: &Arc<Mutex<Store>>,
    profile: &str,
    revision: i64,
    item: &ItemSnapshot,
    candidate: &Value,
    target: ApplyTarget,
    cancelled: &AtomicBool,
) -> Result<Value> {
    authorize_owner(store, profile, revision, cancelled).await?;
    let mut guard = store.lock().await;
    check_cancelled(cancelled)?;
    authorize_owner_locked(&guard, profile, revision)?;
    let transaction = guard
        .db
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current_exists: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM media_items WHERE id=?)",
        [&item.id],
        |row| row.get(0),
    )?;
    if !current_exists {
        return Err(media_not_found());
    }
    apply_candidate_tx(&transaction, item, candidate, target)?;
    for category in target.categories() {
        transaction.execute(
            "INSERT INTO media_metadata_refresh_state (media_id,category,refreshed_at,attempted_at,last_error,locked) \
             VALUES (?,?,?,?,NULL,1) ON CONFLICT(media_id,category) DO UPDATE SET \
             refreshed_at=excluded.refreshed_at,attempted_at=excluded.attempted_at,last_error=NULL,locked=1",
            params![item.id, category, now(), now()],
        )?;
    }
    transaction.commit()?;
    drop(guard);
    current_result(
        store,
        profile,
        revision,
        &item.id,
        candidate.get("source").and_then(Value::as_str),
        cancelled,
    )
    .await
}

fn apply_candidate_tx(
    transaction: &Transaction<'_>,
    item: &ItemSnapshot,
    candidate: &Value,
    target: ApplyTarget,
) -> Result<()> {
    let row = transaction.query_row(
        "SELECT format,title,year,poster,backdrop,logo,summary,rating,content_rating,trailer_url,runtime,\
         season_count,episode_count,provider_ratings_json,genres_json,cast_json,provider_ids_json,\
         streaming_providers_json,origin_platform_json,poster_candidates_json,backdrop_candidates_json,\
         logo_candidates_json,content_ratings_json FROM media_items WHERE id=?",
        [&item.id],
        |row| Ok((
            row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,i64>(2)?,
            row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,
            row.get::<_,String>(6)?,row.get::<_,f64>(7)?,row.get::<_,String>(8)?,
            row.get::<_,String>(9)?,row.get::<_,String>(10)?,row.get::<_,Option<i64>>(11)?,
            row.get::<_,Option<i64>>(12)?,row.get::<_,String>(13)?,row.get::<_,String>(14)?,
            row.get::<_,String>(15)?,row.get::<_,Option<String>>(16)?,row.get::<_,Option<String>>(17)?,
            row.get::<_,Option<String>>(18)?,row.get::<_,String>(19)?,row.get::<_,String>(20)?,
            row.get::<_,String>(21)?,row.get::<_,String>(22)?,
        )),
    )?;
    let mut format = row.0;
    let mut title = row.1;
    let mut year = row.2;
    let mut poster = row.3;
    let mut backdrop = row.4;
    let mut logo = row.5;
    let mut summary = row.6;
    let mut rating = row.7;
    let mut content_rating = row.8;
    let mut trailer_url = row.9;
    let mut runtime = row.10;
    let mut season_count = row.11;
    let mut episode_count = row.12;
    let mut provider_ratings = json_object(&row.13);
    let mut genres = json_array(&row.14);
    let mut cast = json_array(&row.15);
    let mut provider_ids = row.16.as_deref().map(json_object).unwrap_or_default();
    let mut streaming = row.17.as_deref().map(json_array).unwrap_or_default();
    let mut origin_platform = row
        .18
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or(Value::Null);
    let mut posters = json_array_strings(&row.19);
    let mut backdrops = json_array_strings(&row.20);
    let mut logos = json_array_strings(&row.21);
    let mut content_ratings = json_object(&row.22);
    let all = target == ApplyTarget::All;
    if all {
        assign_text(&mut title, candidate.get("title"));
        if let Some(value) = integer(candidate.get("year")).filter(|value| *value > 0) {
            year = value;
        }
        assign_text(&mut format, candidate.get("format"));
        assign_text(&mut content_rating, candidate.get("contentRating"));
        assign_text(&mut trailer_url, candidate.get("trailerUrl"));
        assign_text(&mut runtime, candidate.get("runtime"));
        if candidate
            .get("seasonCount")
            .is_some_and(|value| !value.is_null())
        {
            season_count = integer(candidate.get("seasonCount"));
        }
        if candidate
            .get("episodeCount")
            .is_some_and(|value| !value.is_null())
        {
            episode_count = integer(candidate.get("episodeCount"));
        }
        if let Some(ids) = candidate.get("providerIds").and_then(Value::as_object) {
            for (key, value) in ids {
                provider_ids.insert(key.clone(), value.clone());
            }
        }
        if let Some(value) = positive_number(candidate.get("rating")) {
            rating = value;
        }
        if let Some(values) = candidate.get("providerRatings").and_then(Value::as_object) {
            if !values.is_empty() {
                provider_ratings = values.clone();
            } else if positive_number(candidate.get("rating")).is_some() {
                provider_ratings.clear();
            }
        }
        if let Some(values) = candidate
            .get("genres")
            .and_then(Value::as_array)
            .filter(|values| !values.is_empty())
        {
            genres = values.iter().take(64).cloned().collect();
        }
        if let Some(values) = candidate
            .get("cast")
            .and_then(Value::as_array)
            .filter(|values| !values.is_empty())
        {
            cast = values.iter().take(MAX_CAST).cloned().collect();
        }
        if let Some(values) = candidate
            .get("contentRatings")
            .and_then(Value::as_object)
            .filter(|values| !values.is_empty())
        {
            content_ratings = values.clone();
        }
        if let Some(values) = candidate
            .get("streamingProviders")
            .and_then(Value::as_array)
            .filter(|values| !values.is_empty())
        {
            streaming = values
                .iter()
                .take(MAX_STREAMING_PROVIDERS)
                .cloned()
                .collect();
        }
        if let Some(value) = candidate
            .get("originPlatform")
            .filter(|value| !value.is_null())
        {
            origin_platform = value.clone();
        }
    }
    if all || target == ApplyTarget::Poster {
        assign_text(&mut poster, candidate.get("thumbnail"));
        posters = official_urls(candidate.get("posterCandidates"));
    }
    if all || target == ApplyTarget::Cover {
        assign_text(&mut backdrop, candidate.get("cover"));
        backdrops = official_urls(candidate.get("backdropCandidates"));
    }
    if all || target == ApplyTarget::Logo {
        assign_text(&mut logo, candidate.get("logo"));
        logos = official_urls(candidate.get("logoCandidates"));
    }
    if all || target == ApplyTarget::Summary {
        assign_text(&mut summary, candidate.get("summary"));
    }
    transaction.execute(
        "UPDATE media_items SET format=?,title=?,year=?,poster=?,backdrop=?,logo=?,summary=?,rating=?,content_rating=?,\
         trailer_url=?,runtime=?,season_count=?,episode_count=?,provider_ratings_json=?,genres_json=?,cast_json=?,\
         provider_ids_json=?,streaming_providers_json=?,origin_platform_json=?,poster_candidates_json=?,\
         backdrop_candidates_json=?,logo_candidates_json=?,content_ratings_json=?,updated_at=? WHERE id=?",
        params![format,title,year,poster,backdrop,logo,summary,rating,content_rating,trailer_url,runtime,
            season_count,episode_count,Value::Object(provider_ratings).to_string(),Value::Array(genres).to_string(),
            Value::Array(cast).to_string(),Value::Object(provider_ids).to_string(),Value::Array(streaming).to_string(),
            if origin_platform.is_null(){None}else{Some(origin_platform.to_string())},Value::Array(posters.into_iter().map(Value::String).collect()).to_string(),
            Value::Array(backdrops.into_iter().map(Value::String).collect()).to_string(),Value::Array(logos.into_iter().map(Value::String).collect()).to_string(),
            Value::Object(content_ratings).to_string(),now(),item.id],
    )?;
    if all {
        apply_seasons_tx(transaction, &item.id, candidate.get("seasons"));
    }
    if all || target == ApplyTarget::Episodes {
        apply_episodes_tx(transaction, item, candidate.get("episodes"))?;
    }
    Ok(())
}

fn apply_seasons_tx(transaction: &Transaction<'_>, media_id: &str, value: Option<&Value>) {
    for season in value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_LOCAL_SEASONS)
    {
        let Some(number) = integer(season.get("number")) else {
            continue;
        };
        let title = text(season.get("title"));
        let count = integer(season.get("episodeCount"));
        if title.is_empty() && count.is_none() {
            continue;
        }
        let _=transaction.execute("UPDATE seasons SET title=CASE WHEN ?='' THEN title ELSE ? END,episode_count=COALESCE(?,episode_count) WHERE media_id=? AND number=?",params![title,title,count,media_id,number]);
    }
}

fn apply_episodes_tx(
    transaction: &Transaction<'_>,
    item: &ItemSnapshot,
    value: Option<&Value>,
) -> Result<()> {
    for episode in value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_LOCAL_EPISODES)
    {
        let Some(season) = integer(episode.get("season")) else {
            continue;
        };
        let Some(number) = integer(episode.get("number")) else {
            continue;
        };
        if !item.local_episodes.contains(&(season, number)) {
            continue;
        }
        let current=transaction.query_row("SELECT title,summary,still,rating,air_date,local_metadata_json FROM episodes WHERE media_id=? AND season=? AND number=?",params![item.id,season,number],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,f64>(3)?,row.get::<_,String>(4)?,row.get::<_,Option<String>>(5)?))).optional()?;
        let (old_title, old_summary, old_still, old_rating, old_air, local) =
            current.unwrap_or_default();
        let next_title = nonempty(text(episode.get("title"))).unwrap_or(old_title);
        let next_summary = nonempty(text(episode.get("summary"))).unwrap_or(old_summary);
        let next_still = episode
            .get("still")
            .and_then(Value::as_str)
            .and_then(official_url)
            .unwrap_or(old_still);
        let next_rating = positive_number(episode.get("rating")).unwrap_or(old_rating);
        let next_air = nonempty(text(episode.get("airDate"))).unwrap_or(old_air);
        transaction.execute("INSERT INTO episodes (media_id,season,number,title,summary,still,rating,air_date,local_metadata_json) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(media_id,season,number) DO UPDATE SET title=excluded.title,summary=excluded.summary,still=excluded.still,rating=excluded.rating,air_date=excluded.air_date",params![item.id,season,number,next_title,next_summary,next_still,next_rating,next_air,local])?;
    }
    Ok(())
}

async fn current_result(
    store: &Arc<Mutex<Store>>,
    profile: &str,
    revision: i64,
    media_id: &str,
    episode_source: Option<&str>,
    cancelled: &AtomicBool,
) -> Result<Value> {
    authorize_owner(store, profile, revision, cancelled).await?;
    let store = store.lock().await;
    authorize_owner_locked(&store, profile, revision)?;
    let row=store.db.query_row("SELECT type,format,poster,backdrop,logo,summary,rating,content_rating,trailer_url,runtime,season_count,episode_count,provider_ratings_json,content_ratings_json,poster_candidates_json,backdrop_candidates_json,logo_candidates_json,cast_json,streaming_providers_json,origin_platform_json FROM media_items WHERE id=?",[media_id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,f64>(6)?,row.get::<_,String>(7)?,row.get::<_,String>(8)?,row.get::<_,String>(9)?,row.get::<_,Option<i64>>(10)?,row.get::<_,Option<i64>>(11)?,row.get::<_,String>(12)?,row.get::<_,String>(13)?,row.get::<_,String>(14)?,row.get::<_,String>(15)?,row.get::<_,String>(16)?,row.get::<_,String>(17)?,row.get::<_,Option<String>>(18)?,row.get::<_,Option<String>>(19)?))).optional()?.ok_or_else(media_not_found)?;
    let seasons = if row.0 == "movie" {
        Value::Null
    } else {
        Value::Array(store.db.prepare("SELECT number,title,episode_count FROM seasons WHERE media_id=? ORDER BY number LIMIT ?")?.query_map(params![media_id,MAX_LOCAL_SEASONS as i64],|row|Ok(json!({"number":row.get::<_,i64>(0)?,"title":row.get::<_,String>(1)?,"episodeCount":row.get::<_,i64>(2)?})))?.collect::<std::result::Result<Vec<_>,_>>()?)
    };
    let episodes = if row.0 == "movie" {
        Value::Null
    } else {
        Value::Array(store.db.prepare("SELECT season,number,title,summary,still,rating,air_date,local_metadata_json FROM episodes WHERE media_id=? ORDER BY season,number LIMIT ?")?.query_map(params![media_id,MAX_LOCAL_EPISODES as i64],|row|Ok(json!({"season":row.get::<_,i64>(0)?,"number":row.get::<_,i64>(1)?,"title":row.get::<_,String>(2)?,"summary":row.get::<_,String>(3)?,"still":row.get::<_,String>(4)?,"rating":row.get::<_,f64>(5)?,"airDate":row.get::<_,String>(6)?,"localMetadata":row.get::<_,Option<String>>(7)?.and_then(|raw|serde_json::from_str::<Value>(&raw).ok())})))?.collect::<std::result::Result<Vec<_>,_>>()?)
    };
    Ok(
        json!({"thumbnail":row.2,"cover":if row.3.is_empty(){row.2.clone()}else{row.3},"format":row.1,"contentRating":row.7,"trailerUrl":row.8,"runtime":row.9,"seasonCount":row.10,"episodeCount":row.11,"summary":row.5,"rating":row.6,"providerRatings":json_object(&row.12),"contentRatings":json_object(&row.13),"seasons":seasons,"episodes":episodes,"episodeSource":episode_source,"posterCandidates":json_array_strings(&row.14),"backdropCandidates":json_array_strings(&row.15),"logo":row.4,"logoCandidates":json_array_strings(&row.16),"cast":json_array(&row.17),"streamingProviders":row.18.as_deref().map(json_array).unwrap_or_default(),"originPlatform":row.19.as_deref().and_then(|raw|serde_json::from_str::<Value>(raw).ok())}),
    )
}

async fn authorize_owner(
    store: &Arc<Mutex<Store>>,
    profile: &str,
    revision: i64,
    cancelled: &AtomicBool,
) -> Result<()> {
    check_cancelled(cancelled)?;
    let store = store.lock().await;
    check_cancelled(cancelled)?;
    authorize_owner_locked(&store, profile, revision)
}
fn authorize_owner_locked(store: &Store, profile: &str, revision: i64) -> Result<()> {
    let active = store.require_owner()?;
    if active != profile || store.selection_revision() != revision {
        return Err(Error::new(
            "scan_cancelled",
            "The profile changed during metadata refresh.",
        ));
    }
    Ok(())
}
fn check_cancelled(cancelled: &AtomicBool) -> Result<()> {
    if cancelled.load(Ordering::SeqCst) {
        Err(Error::new(
            "scan_cancelled",
            "The metadata refresh was cancelled.",
        ))
    } else {
        Ok(())
    }
}
fn reject_offline(settings: &Value, action: &str) -> Result<()> {
    if settings
        .get("metadataOfflineMode")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        Err(Error::new(
            "metadata_offline",
            format!("Metadata offline mode is enabled. Turn it off to {action}."),
        ))
    } else {
        Ok(())
    }
}
fn validate_media_id(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > MAX_MEDIA_ID_BYTES || value.contains('\0') {
        Err(invalid("Choose a valid media item."))
    } else {
        Ok(())
    }
}
fn invalid(message: &str) -> Error {
    Error::new("invalid_argument", message)
}
fn media_not_found() -> Error {
    Error::new(
        "media_not_found",
        "Media item was not found in the library.",
    )
}
fn fatal_provider_error(error: &Error) -> bool {
    matches!(
        error.code.as_str(),
        "scan_cancelled"
            | "profile_required"
            | "profile_locked"
            | "owner_required"
            | "stale_profile_selection"
    )
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

fn candidate_score(candidate: &Value, preferred: &str) -> f64 {
    let title = normalize_title(&text(candidate.get("title")));
    let preferred = normalize_title(preferred);
    let mut score = 0.0;
    if title == preferred {
        score += 100.0
    }
    if !preferred.is_empty() && title.contains(&preferred) {
        score += 45.0
    }
    if !text(candidate.get("thumbnail")).is_empty() {
        score += 8.0
    }
    if !text(candidate.get("cover")).is_empty() {
        score += 6.0
    }
    if !text(candidate.get("summary")).is_empty() {
        score += 4.0
    }
    if positive_number(candidate.get("rating")).is_some() {
        score += 2.0
    }
    if [
        "mugen",
        "entertainment",
        "district",
        "swordsmith",
        "hashira",
        "training",
        "infinity",
        "castle",
        "arc",
    ]
    .iter()
    .any(|word| title.split_whitespace().any(|token| token == *word))
    {
        score -= 140.0
    } else {
        score += 60.0
    }
    score
}
fn candidate_id(source: &str, title: &str, year: i64, thumbnail: &str, cover: &str) -> String {
    let payload = format!(
        "{{\"source\":{},\"title\":{},\"year\":{},\"thumbnail\":{},\"cover\":{}}}",
        serde_json::to_string(source).unwrap_or_default(),
        serde_json::to_string(title).unwrap_or_default(),
        year,
        serde_json::to_string(thumbnail).unwrap_or_default(),
        serde_json::to_string(cover).unwrap_or_default()
    );
    sha1_hex(payload.as_bytes())[..12].to_owned()
}

fn sha1_hex(input: &[u8]) -> String {
    let mut data = input.to_vec();
    let bit_len = (data.len() as u64) * 8;
    data.push(0x80);
    while data.len() % 64 != 56 {
        data.push(0)
    }
    data.extend_from_slice(&bit_len.to_be_bytes());
    let mut h = [
        0x67452301u32,
        0xefcdab89,
        0x98badcfe,
        0x10325476,
        0xc3d2e1f0,
    ];
    for chunk in data.chunks_exact(64) {
        let mut w = [0u32; 80];
        for (i, word) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]])
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1)
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5a827999),
                20..=39 => (b ^ c ^ d, 0x6ed9eba1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8f1bbcdc),
                _ => (b ^ c ^ d, 0xca62c1d6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e)
    }
    h.iter().map(|value| format!("{value:08x}")).collect()
}

fn official_url(value: &str) -> Option<String> {
    let parsed = url::Url::parse(value).ok()?;
    if parsed.scheme() != "https"
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.port().is_some()
    {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    let allowed = host == "image.tmdb.org"
        || host == "assets.fanart.tv"
        || host.ends_with(".fanart.tv")
        || host == "anilist.co"
        || host.ends_with(".anilist.co")
        || host == "media-amazon.com"
        || host.ends_with(".media-amazon.com")
        || host == "cdn.myanimelist.net"
        || host.ends_with(".myanimelist.net")
        || host == "static.tvmaze.com"
        || host == "thetvdb.com"
        || host.ends_with(".thetvdb.com");
    allowed.then(|| value.to_owned())
}
fn official_urls(value: Option<&Value>) -> Vec<String> {
    let mut result = Vec::new();
    for value in value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(official_url)
    {
        if result.len() >= MAX_ARTWORK_CANDIDATES {
            break;
        }
        if !result.contains(&value) {
            result.push(value)
        }
    }
    result
}
fn append_unique(target: &mut Vec<String>, values: Vec<String>, limit: usize) {
    for value in values {
        if target.len() >= limit {
            break;
        }
        if !target.contains(&value) {
            target.push(value)
        }
    }
}
fn bounded_values(value: Option<&Value>, limit: usize) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|values| values.iter().take(limit).cloned().collect())
        .unwrap_or_default()
}
fn assign_text(target: &mut String, value: Option<&Value>) {
    if let Some(value) = value
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        *target = value.to_owned()
    }
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
fn positive_number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0)
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
fn valid_imdb_id(value: &str) -> bool {
    value.len() >= 3
        && value.len() <= 32
        && value.starts_with("tt")
        && value[2..].bytes().all(|byte| byte.is_ascii_digit())
}
fn year_from_date(value: &str) -> Option<i64> {
    value
        .get(0..4)
        .and_then(|year| year.parse().ok())
        .filter(|year| *year >= 1800 && *year <= 3000)
}
fn normalize_title(value: &str) -> String {
    value
        .nfkd()
        .filter(|character| !unicode_normalization::char::is_combining_mark(*character))
        .flat_map(char::to_lowercase)
        .map(|character| {
            if character.is_alphanumeric() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn strip_markup(value: &str) -> String {
    let mut result = String::new();
    let mut inside = false;
    for character in value.chars() {
        match character {
            '<' => inside = true,
            '>' => inside = false,
            _ if !inside => result.push(character),
            _ => {}
        }
    }
    result
        .replace("&quot;", "\"")
        .replace("&#039;", "'")
        .replace("&amp;", "&")
        .trim()
        .to_owned()
}
fn valid_omdb_text(value: Option<&Value>) -> Option<String> {
    nonempty(text(value)).filter(|value| value != "N/A")
}
fn parse_score(value: Option<&Value>, scale: f64) -> Option<f64> {
    let raw = text(value);
    if raw.is_empty() || raw == "N/A" {
        return None;
    }
    raw.trim_end_matches('%')
        .split('/')
        .next()?
        .replace(',', "")
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value > 0.0 && *value <= scale)
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

fn tmdb_image(value: Option<&Value>, size: &str) -> String {
    value
        .and_then(Value::as_str)
        .filter(|path| path.starts_with('/') && path.len() <= 2048)
        .map(|path| format!("https://image.tmdb.org/t/p/{size}{path}"))
        .unwrap_or_default()
}
fn tmdb_artwork_candidates(details: &Value, primary: &str, collection: &str) -> Vec<String> {
    let mut paths = Vec::new();
    if !primary.is_empty() {
        if let Some(value) = details.get(primary).and_then(Value::as_str) {
            paths.push(value.to_owned())
        }
    }
    let mut images = details
        .pointer(&format!("/images/{collection}"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    images.sort_by(|left, right| {
        let language = |value: &Value| match value.get("iso_639_1").and_then(Value::as_str) {
            Some("en") => 2,
            None => 1,
            _ => 0,
        };
        language(right).cmp(&language(left)).then_with(|| {
            positive_number(right.get("vote_average"))
                .unwrap_or(0.0)
                .total_cmp(&positive_number(left.get("vote_average")).unwrap_or(0.0))
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
    details.pointer("/credits/cast").and_then(Value::as_array).into_iter().flatten().filter_map(|credit|{let name=text(credit.get("name"));if name.is_empty(){return None}Some(json!({"name":name,"character":text(credit.get("character")),"image":tmdb_image(credit.get("profile_path"),"w500")}))}).take(10).collect()
}
fn anilist_cast(media: &Value) -> Vec<Value> {
    media.pointer("/characters/edges").and_then(Value::as_array).into_iter().flatten().filter_map(|edge|{let role=text(edge.get("role"));if !["MAIN","SUPPORTING"].contains(&role.as_str()){return None}let character_name=text(edge.pointer("/node/name/full"));if character_name.is_empty(){return None}let actor=edge.get("voiceActors").and_then(Value::as_array).and_then(|actors|actors.iter().find(|actor|text(actor.get("languageV2")).eq_ignore_ascii_case("japanese")).or_else(||actors.first()));let actor_name=actor.map(|actor|text(actor.pointer("/name/full"))).unwrap_or_default();let actor_image=actor.and_then(|actor|actor.pointer("/image/large").and_then(Value::as_str).and_then(official_url)).unwrap_or_default();Some(json!({"name":if actor_name.is_empty(){&character_name}else{&actor_name},"character":role,"image":actor_image,"characterName":character_name,"characterRole":text(edge.get("role")),"characterImage":edge.pointer("/node/image/large").and_then(Value::as_str).and_then(official_url).unwrap_or_default(),"voiceActorName":actor_name,"voiceActorImage":actor_image,"voiceActorLanguage":actor.map(|actor|text(actor.get("languageV2"))).unwrap_or_default()}))}).take(MAX_CAST).collect()
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
            )
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
        )
    }
    result
}
fn accept_content_rating(result: &mut Map<String, Value>, country: &str, code: &str, source: &str) {
    if let Some(rating) = normalized_content_rating(country, code, source) {
        let age = rating
            .get("minimumAge")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let key = country.trim().to_uppercase();
        let existing = result
            .get(&key)
            .and_then(|value| value.get("minimumAge"))
            .and_then(Value::as_i64)
            .unwrap_or(-1);
        if age > existing {
            result.insert(key, rating);
        }
    }
}
fn normalized_content_rating(country: &str, code: &str, source: &str) -> Option<Value> {
    let country = country.trim().to_uppercase();
    let code = code
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_uppercase();
    if country.is_empty()
        || code.is_empty()
        || ["N/A", "NA", "NONE", "NOT RATED", "UNKNOWN", "UNRATED"].contains(&code.as_str())
    {
        return None;
    }
    let known = match (country.as_str(), code.as_str()) {
        ("US", "G" | "TV-Y" | "TV-G") => Some(0),
        ("US", "TV-Y7") => Some(7),
        ("US", "PG" | "TV-PG") => Some(8),
        ("US", "PG-13") => Some(13),
        ("US", "TV-14") => Some(14),
        ("US", "R" | "TV-MA") => Some(17),
        ("US", "NC-17") => Some(18),
        _ => None,
    };
    let inferred = code
        .split(|character: char| !character.is_ascii_digit())
        .find_map(|part| {
            (!part.is_empty())
                .then(|| part.parse::<i64>().ok())
                .flatten()
        })
        .unwrap_or(0);
    Some(json!({"code":code,"minimumAge":known.unwrap_or(inferred),"source":source}))
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
        let mut rating = json!({"value":value,"scale":10});
        if let Some(votes) = text(response.get("imdbVotes"))
            .replace(',', "")
            .parse::<i64>()
            .ok()
        {
            rating["votes"] = json!(votes)
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
    struct Entry {
        name: String,
        logo: String,
        regions: HashSet<String>,
        offers: HashSet<String>,
    }
    let mut providers: BTreeMap<i64, Entry> = BTreeMap::new();
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
                if name.is_empty() {
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
    providers.into_iter().take(MAX_STREAMING_PROVIDERS).map(|(id,entry)|{let mut regions=entry.regions.into_iter().collect::<Vec<_>>();regions.sort();let mut offers=entry.offers.into_iter().collect::<Vec<_>>();offers.sort();json!({"id":id,"name":entry.name,"logoUrl":entry.logo,"regions":regions,"offerTypes":offers,"availability":if regions.iter().any(|value|value=="US"){"preferred-region"}else{"other-region"},"source":"tmdb"})}).collect()
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
