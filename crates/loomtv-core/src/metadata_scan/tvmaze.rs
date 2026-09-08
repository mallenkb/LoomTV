use super::*;

fn search_title(title: &str) -> String {
    static SEASON: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let title = SEASON
        .get_or_init(|| regex::Regex::new(r"(?i)\s+(?:s\d{1,2}|season\s+\d{1,2})\s*$").unwrap())
        .replace(title.trim(), "")
        .trim()
        .trim_end_matches(['(', '['])
        .trim()
        .to_owned();
    // Some releases repeat a numeric title in words, such as 86 Eighty Six.
    let words: Vec<_> = title.split_whitespace().collect();
    if let Some(number) = words.first().and_then(|word| word.parse::<u32>().ok()) {
        let mut spelled = 0;
        let mut valid = words.len() > 1;
        for word in &words[1..] {
            let value = match word.to_lowercase().as_str() {
                "one" => 1,
                "two" => 2,
                "three" => 3,
                "four" => 4,
                "five" => 5,
                "six" => 6,
                "seven" => 7,
                "eight" => 8,
                "nine" => 9,
                "ten" => 10,
                "twenty" => 20,
                "thirty" => 30,
                "forty" => 40,
                "fifty" => 50,
                "sixty" => 60,
                "seventy" => 70,
                "eighty" => 80,
                "ninety" => 90,
                _ => {
                    valid = false;
                    0
                }
            };
            spelled += value;
        }
        if valid && spelled == number {
            return number.to_string();
        }
    }
    title
}

async fn request(
    gateway: &MetadataProviderGateway,
    settings: &Value,
    path: String,
    query: Value,
) -> Result<Value> {
    gateway
        .request_metadata_provider(
            &json!({"provider":"tvmaze","path":path,"query":query}),
            settings,
        )
        .await
}

pub(super) async fn fetch(
    gateway: &MetadataProviderGateway,
    settings: &Value,
    item: &ItemSnapshot,
    cancelled: &AtomicBool,
) -> Result<Option<MetadataPatch>> {
    check_cancelled(cancelled)?;
    let id = item
        .provider_ids
        .get("tvmazeId")
        .and_then(value_id)
        .filter(|id| valid_numeric_id(id));
    let show = if let Some(id) = id {
        request(gateway, settings, format!("shows/{id}"), json!({})).await?
    } else {
        let title = search_title(&item.title);
        let results = request(gateway, settings, "search/shows".into(), json!({"q":title})).await?;
        let matches: Vec<_> = results
            .as_array()
            .into_iter()
            .flatten()
            .map(|hit| &hit["show"])
            .filter(|show| {
                let name = text(show.get("name"));
                (normalize_title(&name) == normalize_title(&title)
                    || name
                        .split_once(':')
                        .is_some_and(|(base, _)| normalize_title(base) == normalize_title(&title)))
                    && (item.year <= 0
                        || text(show.get("premiered"))
                            .get(..4)
                            .and_then(|year| year.parse::<i64>().ok())
                            .is_none_or(|year| year == item.year))
            })
            .collect();
        if matches.len() != 1 {
            return Ok(None);
        }
        matches[0].clone()
    };
    let Some(id) = value_id(&show["id"]) else {
        return Ok(None);
    };
    let mut patch = MetadataPatch {
        title: nonempty(text(show.get("name"))),
        summary: nonempty(strip_markup(&text(show.get("summary")))),
        year: text(show.get("premiered"))
            .get(..4)
            .and_then(|year| year.parse().ok()),
        rating: positive_number(show["rating"].get("average")),
        poster: nonempty(text(show["image"].get("original"))),
        genres: show["genres"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        ..Default::default()
    };
    patch.provider_ids.insert("tvmazeId".into(), json!(id));
    if let Some(imdb) = show["externals"]["imdb"].as_str() {
        patch.provider_ids.insert("imdbId".into(), json!(imdb));
    }
    if let Some(runtime) = integer(show.get("averageRuntime")).filter(|value| *value > 0) {
        patch.runtime = Some(format!("{runtime} min"));
    }
    check_cancelled(cancelled)?;
    // A failed optional endpoint must not discard the show's core metadata.
    if item.requested.contains(&Category::Episodes) {
        if let Ok(episodes) = request(
            gateway,
            settings,
            format!("shows/{id}/episodes"),
            json!({"specials":1}),
        )
        .await
        {
            for episode in episodes
                .as_array()
                .into_iter()
                .flatten()
                .take(MAX_LOCAL_EPISODES)
            {
                let (Some(season), Some(number)) = (
                    integer(episode.get("season")),
                    integer(episode.get("number")),
                ) else {
                    continue;
                };
                patch.episodes.push(EpisodePatch {
                    season,
                    number,
                    title: text(episode.get("name")),
                    summary: strip_markup(&text(episode.get("summary"))),
                    still: text(episode["image"].get("original")),
                    rating: positive_number(episode["rating"].get("average")).unwrap_or(0.0),
                    air_date: text(episode.get("airdate")),
                });
            }
        }
    }
    check_cancelled(cancelled)?;
    if item.requested.contains(&Category::Cast) {
        if let Ok(cast) = request(gateway, settings, format!("shows/{id}/cast"), json!({})).await {
            patch.cast = cast
                .as_array()
                .into_iter()
                .flatten()
                .take(MAX_CAST)
                .map(|entry| {
                    json!({
                        "name":text(entry["person"].get("name")),
                        "character":text(entry["character"].get("name")),
                        "image":text(entry["person"]["image"].get("original"))
                    })
                })
                .collect();
        }
    }
    check_cancelled(cancelled)?;
    if item.requested.contains(&Category::Artwork) {
        if let Ok(images) =
            request(gateway, settings, format!("shows/{id}/images"), json!({})).await
        {
            for image in images.as_array().into_iter().flatten() {
                let url = text(image["resolutions"]["original"].get("url"));
                if url.is_empty() {
                    continue;
                }
                match image["type"].as_str() {
                    Some("background") if patch.backdrop.is_none() => patch.backdrop = Some(url),
                    Some("typography") if patch.logo.is_none() => patch.logo = Some(url),
                    _ => {}
                }
            }
        }
    }
    Ok(Some(patch))
}
