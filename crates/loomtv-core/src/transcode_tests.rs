//! Generated-fixture integration tests. Never opens the installed app's data directory.
use crate::{remote::RemoteClient, streaming::MediaServer, Store};
use serde_json::json;
use std::{path::PathBuf, sync::Arc};
use tokio::sync::Mutex;

#[test]
#[ignore = "requires LOOMTV_TEST_FFMPEG and LOOMTV_TEST_FFPROBE"]
fn generated_media_probe_hls_seek_range_and_revocation() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let ffmpeg = PathBuf::from(std::env::var("LOOMTV_TEST_FFMPEG").expect("explicit test FFmpeg path"));
        let ffprobe = PathBuf::from(std::env::var("LOOMTV_TEST_FFPROBE").expect("explicit test ffprobe path"));
        assert!(ffmpeg.is_absolute() && ffprobe.is_absolute());
        let root = std::env::temp_dir().join(format!("loomtv-port-test-{}",uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&root).await.unwrap();
        tokio::fs::write(root.join("TEST-OWNED"),b"temporary generated fixture").await.unwrap();
        let media_dir = root.join("media");
        tokio::fs::create_dir(&media_dir).await.unwrap();
        let source = media_dir.join("Unicode movie \u{00e9} fixture.mp4");
        let output = tokio::process::Command::new(&ffmpeg)
            .args(["-nostdin","-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc2=size=160x90:rate=24","-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t","65","-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p","-c:a","aac","-movflags","+faststart","-y"])
            .arg(&source).kill_on_drop(true).status().await.unwrap();
        assert!(output.success());
        let mut store = Store::open(&root.join("data")).unwrap();
        let owner: String = store.db.query_row("SELECT id FROM profiles WHERE profile_type='owner'",[],|r|r.get(0)).unwrap();
        store.select_profile(&owner,None).unwrap();
        store.add_folder("movies",media_dir.to_str().unwrap()).unwrap();
        store.db.execute("INSERT INTO media_items(id,type,title,file_path,updated_at) VALUES ('fixture','movie','Fixture',?,0)",[source.to_str().unwrap()]).unwrap();
        let store = Arc::new(Mutex::new(store));
        let (server,stop) = MediaServer::start(store.clone(),Arc::new(RemoteClient::default()),Some(ffmpeg),Some(ffprobe)).await.unwrap();
        let probe = server.probe.probe(store.clone(),source.to_str().unwrap()).await.unwrap();
        assert_eq!(probe["videoCodec"],"h264");
        assert_eq!(probe["audioCodec"],"aac");
        assert_eq!(probe["durationSeconds"],65.0);
        assert!(crate::probe::can_direct_play(&probe,"html5").unwrap());
        let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(35)).build().unwrap();
        let direct = server.grant(source.to_str().unwrap()).await.unwrap();
        let suffix = client.get(&direct).header("Range","bytes=-16").send().await.unwrap();
        assert_eq!(suffix.status(),206);
        assert_eq!(suffix.bytes().await.unwrap().len(),16);
        let session = server.transcodes.start(source.to_str().unwrap(),&json!({"preset":"software","startSeconds":0})).await.unwrap();
        let id = session["sessionId"].as_str().unwrap();
        let playlist_url = session["playlistUrl"].as_str().unwrap();
        let playlist = client.get(playlist_url).send().await.unwrap();
        assert_eq!(playlist.status(),200);
        let playlist = playlist.text().await.unwrap();
        assert!(playlist.contains("#EXT-X-ENDLIST"));
        assert!(playlist.contains("segment-00060.ts"));
        assert!(!playlist.contains(source.to_str().unwrap()));
        let base = playlist_url.strip_suffix("index.m3u8").unwrap();
        let first = client.get(format!("{base}segment-00000.ts")).send().await.unwrap();
        assert_eq!(first.status(),200);
        let bytes = first.bytes().await.unwrap();
        assert!(!bytes.is_empty());
        assert_eq!(bytes[0],0x47); // MPEG transport-stream packet sync byte.
        let ranged = client.get(format!("{base}segment-00060.ts")).header("Range","bytes=0-187").send().await.unwrap();
        assert_eq!(ranged.status(),206);
        assert_eq!(ranged.bytes().await.unwrap().len(),188);
        let head = client.head(format!("{base}segment-00060.ts")).send().await.unwrap();
        assert_eq!(head.status(),200);
        assert!(head.headers()[reqwest::header::CONTENT_LENGTH].to_str().unwrap().parse::<u64>().unwrap() > 0);
        assert!(head.bytes().await.unwrap().is_empty());
        let invalid_range = client.get(format!("{base}segment-00060.ts")).header("Range","bytes=999999999-").send().await.unwrap();
        assert_eq!(invalid_range.status(),416);
        let invalid_name = client.get(format!("{base}segment-00060.ts.tmp")).send().await.unwrap();
        assert_eq!(invalid_name.status(),400);
        let forged_host = client.get(playlist_url).header("Host","attacker.invalid").send().await.unwrap();
        assert_eq!(forged_host.status(),403);
        let reused = server.transcodes.start(source.to_str().unwrap(),&json!({"preset":"software","startSeconds":10})).await.unwrap();
        assert_eq!(reused["sessionId"],id);
        let output_dir = PathBuf::from(session["outputDir"].as_str().unwrap());
        store.lock().await.lock_profile().unwrap();
        let revoked = client.get(playlist_url).send().await.unwrap();
        assert_eq!(revoked.status(),403);
        server.revoke_all().await;
        assert!(!output_dir.exists());
        assert!(!server.transcodes.stop(id).await.unwrap());
        server.shutdown().await;
        let _ = stop.send(());
        assert!(server.transcodes.start(source.to_str().unwrap(),&json!({})).await.is_err());
        drop(server);
        drop(store);
        assert!(root.join("TEST-OWNED").is_file());
        tokio::fs::remove_dir_all(root).await.unwrap();
    });
}
