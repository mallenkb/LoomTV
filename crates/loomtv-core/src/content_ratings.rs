//! Shared provider normalization and conservative checks for previously stored ratings.
use serde_json::{json, Value};

pub(crate) fn normalize(country: &str, code: &str, source: &str) -> Option<Value> {
    let country = country.trim().to_uppercase();
    let code = code
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_uppercase();
    if country.is_empty()
        || code.is_empty()
        || !["tmdb", "omdb", "jikan"].contains(&source)
        || ["N/A", "NA", "NONE", "NOT RATED", "UNKNOWN", "UNRATED"].contains(&code.as_str())
    {
        return None;
    }
    let known = match (country.as_str(), code.as_str()) {
        ("US", "G" | "TV-Y" | "TV-G") => Some(0),
        ("US", "PG" | "TV-PG") => Some(8),
        ("US", "PG-13") => Some(13),
        ("US", "R" | "TV-MA") => Some(17),
        ("US", "NC-17") => Some(18),
        ("US", "TV-Y7") => Some(7),
        ("US", "TV-14") => Some(14),
        ("GB", "U") => Some(0),
        ("GB", "PG") => Some(8),
        ("GB", "12" | "12A") => Some(12),
        ("GB", "15") => Some(15),
        ("GB", "18" | "R18") => Some(18),
        ("CA", "G") => Some(0),
        ("CA", "PG") => Some(8),
        ("CA", "14A") => Some(14),
        ("CA", "18A" | "R" | "A") => Some(18),
        ("AU", "G") => Some(0),
        ("AU", "PG") => Some(8),
        ("AU", "M" | "MA15+") => Some(15),
        ("AU", "R18+" | "X18+") => Some(18),
        ("BR", "L") => Some(0),
        ("BR", "10") => Some(10),
        ("BR", "12") => Some(12),
        ("BR", "14") => Some(14),
        ("BR", "16") => Some(16),
        ("BR", "18") => Some(18),
        ("DE", "0") => Some(0),
        ("DE", "6") => Some(6),
        ("DE", "12") => Some(12),
        ("DE", "16") => Some(16),
        ("DE", "18") => Some(18),
        ("ES", "TP") => Some(0),
        ("ES", "7") => Some(7),
        ("ES", "12") => Some(12),
        ("ES", "16") => Some(16),
        ("ES", "18") => Some(18),
        ("FR", "U") => Some(0),
        ("FR", "-10") => Some(10),
        ("FR", "12") => Some(12),
        ("FR", "16") => Some(16),
        ("FR", "18") => Some(18),
        ("IN", "U") => Some(0),
        ("IN", "U/A" | "UA") => Some(13),
        ("IN", "A" | "S") => Some(18),
        ("IT", "T") => Some(0),
        ("IT", "VM6") => Some(6),
        ("IT", "VM8") => Some(8),
        ("IT", "VM12") => Some(12),
        ("IT", "VM14") => Some(14),
        ("IT", "VM18") => Some(18),
        ("JP", "G") => Some(0),
        ("JP", "PG12") => Some(12),
        ("JP", "R15+") => Some(15),
        ("JP", "R18+") => Some(18),
        ("KR", "ALL") => Some(0),
        ("KR", "12") => Some(12),
        ("KR", "15") => Some(15),
        ("KR", "18") => Some(18),
        ("MX", "AA" | "A") => Some(0),
        ("MX", "B") => Some(12),
        ("MX", "B15") => Some(15),
        ("MX", "C" | "D") => Some(18),
        ("NL", "AL") => Some(0),
        ("NL", "6") => Some(6),
        ("NL", "9") => Some(9),
        ("NL", "12") => Some(12),
        ("NL", "14") => Some(14),
        ("NL", "16") => Some(16),
        ("NL", "18") => Some(18),
        ("NZ", "G") => Some(0),
        ("NZ", "PG") => Some(8),
        ("NZ", "M" | "R16" | "RP16") => Some(16),
        ("NZ", "R13" | "RP13") => Some(13),
        ("NZ", "R15") => Some(15),
        ("NZ", "R18") => Some(18),
        ("US", "R+" | "RX") if source == "jikan" => Some(18),
        _ => None,
    };
    let inferred = || {
        code.split(|character: char| !character.is_ascii_digit())
            .find_map(|part| {
                (!part.is_empty() && part.len() <= 2)
                    .then(|| part.parse::<i64>().ok())
                    .flatten()
            })
            .or(match code.as_str() {
                "G" | "U" | "ALL" | "AL" | "L" | "TP" | "T" => Some(0),
                "A" | "C" | "D" | "R18" | "R18+" | "X18+" | "NC-17" | "TV-MA" => Some(18),
                _ => None,
            })
    };
    // Unknown values are unrated. Never turn an unrecognized provider value into an all-ages rating.
    let minimum_age = known.or_else(inferred)?;
    Some(json!({"code":code,"minimumAge":minimum_age,"source":source}))
}

pub(crate) fn stored_minimum_age(country: &str, rating: &Value) -> Option<i64> {
    let recorded = rating["minimumAge"].as_i64().filter(|age| *age >= 0)?;
    let normalized = normalize(
        country,
        rating["code"].as_str()?,
        rating["source"].as_str()?,
    )?;
    // Old Rust rows can contain zero for a known restricted rating. Correct authorization on read,
    // without mutating a user's store or relaxing an existing, more restrictive stored value.
    Some(recorded.max(normalized["minimumAge"].as_i64()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_known_electron_rating_keeps_its_age() {
        let fixtures: Value =
            serde_json::from_str(include_str!("../fixtures/content-ratings.json")).unwrap();
        for fixture in fixtures["knownRatings"].as_array().unwrap() {
            let country = fixture[0].as_str().unwrap();
            let code = fixture[1].as_str().unwrap();
            let actual =
                normalize(&country.to_lowercase(), &format!("  {code}  "), "tmdb").unwrap();
            assert_eq!(actual["minimumAge"], fixture[2], "{country}/{code}");
        }
    }

    #[test]
    fn unknown_codes_do_not_become_safe_for_children() {
        for code in ["", "UNKNOWN", "FUTURE", "XX2016", "NOT RATED"] {
            assert!(normalize("AU", code, "tmdb").is_none(), "{code}");
        }
        assert!(normalize("", "PG", "tmdb").is_none());
        assert!(normalize("US", "PG", "untrusted").is_none());
        assert_eq!(normalize("US", "R+", "jikan").unwrap()["minimumAge"], 18);
        assert_eq!(normalize("ZZ", "15+", "tmdb").unwrap()["minimumAge"], 15);
    }

    #[test]
    fn stored_underestimates_cannot_bypass_current_rating_rules() {
        assert_eq!(
            stored_minimum_age("AU", &json!({"code":"M","minimumAge":0,"source":"tmdb"})),
            Some(15)
        );
        assert_eq!(
            stored_minimum_age("AU", &json!({"code":"M","minimumAge":18,"source":"tmdb"})),
            Some(18)
        );
        assert_eq!(
            stored_minimum_age("CA", &json!({"code":"R","minimumAge":0,"source":"tmdb"})),
            Some(18)
        );
        assert_eq!(
            stored_minimum_age(
                "AU",
                &json!({"code":"FUTURE","minimumAge":0,"source":"tmdb"})
            ),
            None
        );
        assert_eq!(
            stored_minimum_age("US", &json!({"code":"G","source":"tmdb"})),
            None
        );
    }
}
