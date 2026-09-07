from pathlib import Path
import hashlib

root = Path.cwd()
path = root / 'crates/loomtv-core/src/catalog.rs'
assert hashlib.sha256(path.read_bytes()).hexdigest() == '82b317a7dba4d3d695bfb79944ac8ca83c84923853ac3ad5909e70f2e5b6c5b4'
source = path.read_text()
old = '''source["localMetadata"]["durationSeconds"]
                        .as_f64()'''
new = '''source.get("localMetadata")
                        .and_then(|metadata| metadata.get("durationSeconds"))
                        .and_then(Value::as_f64)'''
assert source.count(old) == 1
source = source.replace(old, new)
source += '''
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_movie_cards_do_not_require_optional_probe_metadata() {
        let base = json!({"id":"fixture","type":"movie","title":"New movie","poster":"","backdrop":"","summary":"","rating":0,"genres":[],"filePath":"/fixture/new.mp4"});
        let card = Store::card(&base).unwrap();
        assert_eq!(card["playbackReferences"], json!([{"progressKey":"/fixture/new.mp4"}]));
        assert!(card.get("filePath").is_none());
        assert!(card.get("localMetadata").is_none());
        for metadata in [Value::Null, json!({}), json!({"durationSeconds":0}), json!({"durationSeconds":-1}), json!({"durationSeconds":"invalid"})] {
            let mut item = base.clone();
            item["localMetadata"] = metadata;
            assert_eq!(Store::card(&item).unwrap()["playbackReferences"],card["playbackReferences"]);
        }
        let mut probed = base;
        probed["localMetadata"] = json!({"durationSeconds":65});
        assert_eq!(Store::card(&probed).unwrap()["playbackReferences"][0]["durationSeconds"],65.0);
    }

    #[test]
    fn episode_cards_preserve_track_identity_without_optional_metadata() {
        let item = json!({"id":"show","type":"tv","title":"New show","episodeFiles":[{"filePath":"/fixture/S01E02.mp4","season":1,"episode":2},{"filePath":"/fixture/S01E03.mp4","season":1,"episode":3,"localMetadata":{"durationSeconds":65}}]});
        let card = Store::card(&item).unwrap();
        assert_eq!(card["playbackReferences"][0],json!({"progressKey":"/fixture/S01E02.mp4","season":1,"episode":2}));
        assert_eq!(card["playbackReferences"][1]["durationSeconds"],65.0);
        assert!(card.get("episodeFiles").is_none());
    }
}
'''
path.write_text(source)
path = root / 'crates/loomtv-core/src/transcode_tests.rs'
source = path.read_text()
old = 'store.library_item(&media_id).unwrap()["filePath"]'
assert source.count(old) == 1
path.write_text(source.replace(old, 'store.library_item(&media_id).unwrap()["item"]["filePath"]'))
