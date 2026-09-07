from pathlib import Path
import re,json,hashlib
R=Path.cwd()
C=R/'crates/loomtv-core/src'
# Bind the transformation to reviewed source bytes, not a moving checkout.
EXPECTED = {
  "crates/loomtv-core/src/content_policy.rs": "437a32ed9174dc71b292357a708ed0a8f8cd1b4835856dcb9d4ff64e0d1e2c79",
  "crates/loomtv-core/src/iptv.rs": "f73a5e06b396c00c603b8c406f7a110d9aa6dcfb2ebf12e2eaf7aec2c51ccc55",
  "crates/loomtv-core/src/lib.rs": "82ee3a79e4df43a4602aa846736badabd47b1e02a758ed0b353c4e3a270ab231",
  "crates/loomtv-core/src/metadata_scan.rs": "919e511b21cc45a019e7ec9735043d6b13872a7d150efc099937bc28364c9932",
  "crates/loomtv-core/src/official_artwork.rs": "7440c4e4bde67d3d50aab8954c3405ab2f0b6b128a74857e81003e59008ad724",
  "crates/loomtv-core/src/store.rs": "a5c3a32d8fc6ebf72e0ee1005f930b5fd83bd932498bf41f01951fc81001aa07",
  "crates/loomtv-core/src/stremio_store.rs": "13cb296509d4613e0660321f10de55038c1b54c068fe126f1c1c2908dc13425f",
  "crates/loomtv-core/src/transcode.rs": "fe1b2e4ab03a353d3da52949b192713bf79c4c8a66ee15dbdcb09ce9d8232774",
  "crates/loomtv-core/src/transcode_tests.rs": "c7a9316bc4f3881e59e8c0de1e073dbe66bcd21873ab2707012af68e4b92c6e0",
  "apps/desktop/src/main/metadata/contentRatings.ts": "68717addaf05b432e293a086379d9381e8fdb5d4e162f302488dd48bcb3b9b4a"
}
for name, expected in EXPECTED.items():
 assert hashlib.sha256((R/name).read_bytes()).hexdigest()==expected, name

def edit(name, old, new, count=1):
 p=C/name;s=p.read_text();assert s.count(old)==count,(name,s.count(old),old[:80]);p.write_text(s.replace(old,new))
# Keep already-tested scan, playback and HTTP behavior in one generated-media regression.
(C/'transcode_tests.rs').write_text((R/'.github/tauri-hardening/transcode-tests.rs').read_text())
# New content-rating mapping is generated from the frozen Electron table, not outside assumptions.
t=(R/'apps/desktop/src/main/metadata/contentRatings.ts').read_text()
block=t[t.index('const MINIMUM_AGES'):t.index('const EMPTY_RATING_CODES')]
ratings=[]
for country, pairs in re.findall(r'\b([A-Z]{2}):\s*\{([^}]+)\}',block):
 for quoted, bare, age in re.findall(r"(?:'([^']+)'|(\w+)):\s*(\d+)",pairs): ratings.append([country,quoted or bare,int(age)])
assert len(ratings)==92,len(ratings)
fixture=C.parent/'fixtures';fixture.mkdir(exist_ok=True)
(fixture/'content-ratings.json').write_text(json.dumps({'sourceCommit':'7ab2267d776c05c39bc09134295dfcb48baa0069','sourcePath':'apps/desktop/src/main/metadata/contentRatings.ts','knownRatings':ratings},ensure_ascii=False,indent=2)+'\n')
# Group exact country/code entries by age for a small reviewed match table.
lines=[]
for country in dict.fromkeys(row[0] for row in ratings):
 ages={}
 for c,code,age in ratings:
  if c==country:ages.setdefault(age,[]).append(code)
 for age,codes in ages.items():
  lines.append(f'        ("{country}", '+ ' | '.join(json.dumps(x) for x in codes)+f') => Some({age}),')
module='''//! Shared provider normalization and conservative checks for previously stored ratings.
use serde_json::{json, Value};

pub(crate) fn normalize(country: &str, code: &str, source: &str) -> Option<Value> {
    let country = country.trim().to_uppercase();
    let code = code.split_whitespace().collect::<Vec<_>>().join(" ").to_uppercase();
    if country.is_empty() || code.is_empty() || !["tmdb", "omdb", "jikan"].contains(&source)
        || ["N/A", "NA", "NONE", "NOT RATED", "UNKNOWN", "UNRATED"].contains(&code.as_str()) {
        return None;
    }
    let known = match (country.as_str(), code.as_str()) {
'''+ '\n'.join(lines)+'''
        ("US", "R+" | "RX") if source == "jikan" => Some(18),
        _ => None,
    };
    let inferred = || {
        code.split(|character: char| !character.is_ascii_digit())
            .find_map(|part| (!part.is_empty() && part.len() <= 2).then(|| part.parse::<i64>().ok()).flatten())
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
    let normalized = normalize(country, rating["code"].as_str()?, rating["source"].as_str()?)?;
    // Old Rust rows can contain zero for a known restricted rating. Correct authorization on read,
    // without mutating a user's store or relaxing an existing, more restrictive stored value.
    Some(recorded.max(normalized["minimumAge"].as_i64()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_known_electron_rating_keeps_its_age() {
        let fixtures: Value = serde_json::from_str(include_str!("../fixtures/content-ratings.json")).unwrap();
        for fixture in fixtures["knownRatings"].as_array().unwrap() {
            let country = fixture[0].as_str().unwrap();
            let code = fixture[1].as_str().unwrap();
            let actual = normalize(&country.to_lowercase(), &format!("  {code}  "), "tmdb").unwrap();
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
        assert_eq!(stored_minimum_age("AU", &json!({"code":"M","minimumAge":0,"source":"tmdb"})), Some(15));
        assert_eq!(stored_minimum_age("AU", &json!({"code":"M","minimumAge":18,"source":"tmdb"})), Some(18));
        assert_eq!(stored_minimum_age("CA", &json!({"code":"R","minimumAge":0,"source":"tmdb"})), Some(18));
        assert_eq!(stored_minimum_age("AU", &json!({"code":"FUTURE","minimumAge":0,"source":"tmdb"})), None);
        assert_eq!(stored_minimum_age("US", &json!({"code":"G","source":"tmdb"})), None);
    }
}
'''
(C/'content_ratings.rs').write_text(module)
edit('lib.rs','mod content_policy;','mod content_policy;\nmod content_ratings;')
edit('content_policy.rs','match ratings[country]["minimumAge"].as_i64()', 'match crate::content_ratings::stored_minimum_age(country, &ratings[country])')
for name in ['metadata_scan.rs','official_artwork.rs']:
 p=C/name;s=p.read_text();a=s.index('fn normalized_content_rating(');b=s.index('\nfn omdb_provider_ratings(',a)
 s=s[:a]+s[b:]
 s='use crate::content_ratings::normalize as normalized_content_rating;\n'+s
 p.write_text(s)
# Refactor the long metadata write signatures into an authorization context.
p=C/'metadata_scan.rs';s=p.read_text()
pattern=re.compile(r'(commit_patch|record_attempt)\(\n(?P<i> +)&store,\n(?P=i)expected_profile,\n(?P=i)expected_revision,\n(?P<body>.*?)\n(?P=i)(?P<owner>true|false),\n(?P<end> *)\)',re.S)
count=0
def call(m):
 global count
 count+=1;i=m['i']
 return m[1]+'(\n'+i+'MetadataWriteContext { store: &store, expected_profile, expected_revision, owner_required: '+m['owner']+' },\n'+m['body']+'\n'+m['end']+')'
s=pattern.sub(call,s);assert count==7,count
context='''struct MetadataWriteContext<'a> {
    store: &'a Arc<Mutex<Store>>,
    expected_profile: &'a str,
    expected_revision: i64,
    owner_required: bool,
}

'''
s=s.replace('async fn commit_patch(',context+'async fn commit_patch(',1)
for fn in ['commit_patch','record_attempt']:
 start=s.index('async fn '+fn+'(');end=s.index('    check_cancelled(cancelled)?;',start)
 seg=s[start:end]
 seg=seg.replace('    store: &Arc<Mutex<Store>>,\n    expected_profile: &str,\n    expected_revision: i64,','    context: MetadataWriteContext<\'_>,')
 seg=seg.replace('    owner_required: bool,\n','')
 seg+='    let MetadataWriteContext { store, expected_profile, expected_revision, owner_required } = context;\n'
 s=s[:start]+seg+s[end:]
# Convert only the three initial patch-field sequences; expressions are unchanged.
starts=[s.index('    let mut patch = MetadataPatch::default();',s.index('fn tmdb_details(')),s.index('    let mut patch = MetadataPatch::default();',s.index('async fn fetch_omdb(')),s.index('    let mut patch = MetadataPatch::default();',s.index('async fn fetch_anilist('))]
for start in reversed(starts):
 initend=start+len('    let mut patch = MetadataPatch::default();\n')
 end=s.index('    patch.provider_ids.insert(',initend) if start==starts[0] else s.index('    if let Some(value) = patch.poster.clone()',initend)
 body=s[initend:end]
 fields=re.findall(r'^    patch\.(\w+) = (.*?);\n',body,re.M|re.S)
 consumed=''.join('    patch.'+name+' = '+expr+';\n' for name,expr in fields)
 assert consumed==body,body
 replacement='    let mut patch = MetadataPatch {\n'+''.join('        '+name+': '+expr.replace('\n','\n    ')+',\n' for name,expr in fields)+'        ..MetadataPatch::default()\n    };\n'
 s=s[:start]+replacement+s[end:]
s=s.replace('''    } else if let Some(value) = value.strip_prefix("http://") {
        Some(format!("https://{value}"))
    } else {
        None
''','''    } else {
        value.strip_prefix("http://").map(|value| format!("https://{value}"))
''')
s=s.replace('''        .filter_map(|character| {
            character
                .is_alphanumeric()
                .then(|| character.to_lowercase())
        })
        .flatten()''','''        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)''')
p.write_text(s)
# Artwork request values belong together; native authorization remains explicit.
p=C/'official_artwork.rs';s=p.read_text()
a=s.index('/// Applies a fresh provider candidate')
s=s[:a]+'''pub struct OfficialArtworkSelection<'a> {
    pub media_id: &'a str,
    pub candidate: &'a Value,
    pub target: Option<&'a str>,
}

'''+s[a:]
s=s.replace('''    media_id: &str,
    supplied_candidate: &Value,
    requested_target: Option<&str>,''','''    selection: OfficialArtworkSelection<'_>,''',1)
s=s.replace(''') -> Result<Value> {
    validate_media_id(media_id)?;
    let supplied = supplied_candidate''',''') -> Result<Value> {
    let OfficialArtworkSelection { media_id, candidate: supplied_candidate, target: requested_target } = selection;
    validate_media_id(media_id)?;
    let supplied = supplied_candidate''',1)
s=s.replace('data.chunks_exact(64)','data.chunks(64)').replace('chunk.chunks_exact(4)','chunk.chunks(4)')
s=s.replace('''        if let Some(votes) = text(response.get("imdbVotes"))
            .replace(',', "")
            .parse::<i64>()
            .ok()''','''        if let Ok(votes) = text(response.get("imdbVotes"))
            .replace(',', "")
            .parse::<i64>()''')
s+='''
#[cfg(test)]
mod tests {
    use super::sha1_hex;

    #[test]
    fn candidate_hash_retains_the_reference_sha1_bytes() {
        assert_eq!(sha1_hex(b""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(sha1_hex(&[b'a'; 200]), "'''+hashlib.sha1(b'a'*200).hexdigest()+'''");
    }
}
'''
p.write_text(s)
edit('iptv.rs','''        if playlist_url != existing.playlist_url {
            if source_by_playlist_url(&store, &playlist_url)?
                .is_some_and(|source| source.id != source_id)
            {
                return Err(iptv_error("That playlist has already been added."));
            }
        }''','''        if playlist_url != existing.playlist_url
            && source_by_playlist_url(&store, &playlist_url)?.is_some_and(|source| source.id != source_id)
        {
            return Err(iptv_error("That playlist has already been added."));
        }''')
edit('store.rs','''                return Err(Error::unsupported(channel));''','''                Err(Error::unsupported(channel))''')
p=C/'stremio_store.rs';s=p.read_text();a=s.index('    if manifest\n        .get("peerToPeerDeclared")');b=s.index('    Ok(warnings)',a)
body=s[a:b];body=body.replace('    if manifest','    let peer_declared = manifest',1)
body=body.replace('''            .unwrap_or(false)
    {
        if !warnings.iter().any(|warning| warning == PEER_WARNING) {
            warnings.push(PEER_WARNING.into());
        }
    }
''','''            .unwrap_or(false);
    if peer_declared && !warnings.iter().any(|warning| warning == PEER_WARNING) {
        warnings.push(PEER_WARNING.into());
    }
''')
s=s[:a]+body+s[b:];p.write_text(s)
p=C/'transcode.rs';s=p.read_text();a=s.index('#[cfg(test)]\nmod tests {');b=s.index('pub fn router(',a);tests=s[a:b].strip();s=s[:a]+s[b:];s=s.rstrip()+'\n\n'+tests+'\n'
s=s.replace('n >= 0.0 && n <= 1_000_000.0','(0.0..=1_000_000.0).contains(&n)')
s=s.replace('''                if !expire && encoder.last_activity.elapsed() >= ENCODER_IDLE {
                    if stop_encoder(&mut encoder).await.is_err() {
                        expire = true;
                    }
                }''','''                if !expire && encoder.last_activity.elapsed() >= ENCODER_IDLE
                    && stop_encoder(&mut encoder).await.is_err()
                {
                    expire = true;
                }''')
p.write_text(s)
print('Rating fixtures:',len(ratings),'metadata write callers:',count)

p=fixture/"content-ratings.json"
d=json.loads(p.read_text())
h={key:value for key,value in d.items() if key!="knownRatings"}
p.write_text(json.dumps(h,indent=2)[:-2]+",\n  \"knownRatings\": [\n"+",\n".join("    "+json.dumps(row) for row in d["knownRatings"])+"\n  ]\n}\n")
