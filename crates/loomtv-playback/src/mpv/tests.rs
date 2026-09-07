use super::*;
use std::collections::HashMap;
fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn mpv_command_contract_preserves_scales_and_ids() {
    assert_eq!(
        contract::commands(&json!({"type":"set-volume","volume":0.95})).unwrap(),
        vec![json!(["set_property", "volume", 95.0])]
    );
    assert_eq!(
        contract::commands(&json!({"type":"set-subtitle-track","trackId":null})).unwrap(),
        vec![json!(["set_property", "sid", "no"])]
    );
    assert_eq!(
        contract::commands(&json!({"type":"set-secondary-subtitle-track","trackId":8})).unwrap(),
        vec![json!(["set_property", "secondary-sid", 8])]
    );
    assert_eq!(
        contract::commands(&json!({"type":"seek","position":12.5})).unwrap(),
        vec![json!(["seek", 12.5, "absolute+exact"])]
    );
    assert_eq!(
        contract::commands(&json!({"type":"set-speed","speed":100})).unwrap(),
        vec![json!(["set_property", "speed", 3.0])]
    );
    assert_eq!(
        contract::commands(&json!({"type":"set-audio-delay","seconds":-1.25})).unwrap(),
        vec![json!(["set_property", "audio-delay", -1.25])]
    );
}
#[test]
fn mpv_command_contract_rejects_generic_execution_and_bad_payloads() {
    for command in [
        json!({"type":"run","command":"evil"}),
        json!({"type":"set_property","name":"input-ipc-server","value":"evil"}),
        json!({"type":"set-volume","volume":"1"}),
        json!({"type":"set-paused","paused":1}),
        json!({"type":"set-audio-track"}),
        json!({"type":"set-audio-track","trackId":-1}),
        json!({"type":"set-audio-track","trackId":1.5}),
        json!({"type":"set-video-aspect","aspect":"1\nrun evil"}),
    ] {
        assert!(contract::commands(&command).is_err(), "{command}");
    }
    assert!(contract::start_commands(&Value::Null).is_err());
    assert!(contract::start_commands(
        &json!({"subtitleFiles":[{"path":"/fixture","source":"unknown"}]})
    )
    .is_err());
    assert!(contract::start_commands(
        &json!({"subtitleFiles":vec![json!({"path":"/fixture","source":"sidecar"});33]})
    )
    .is_err());
}
#[test]
fn mpv_tracks_keep_runtime_id_separate_from_stream_index() {
    let tracks = contract::tracks(
        &json!([{"id":3,"ff-index":7,"type":"sub","external":true,"external-filename":"/字幕.srt","selected":true,"lang":"ja","title":"Japanese"},{"id":1,"type":"audio","demux-channel-count":6},{"id":4,"type":"unknown"},{"id":-2,"type":"video"}]),
        &HashMap::from([("/字幕.srt".into(), "opensubtitles".into())]),
    );
    assert_eq!(tracks.as_array().unwrap().len(), 2);
    assert_eq!(tracks[0]["id"], 3);
    assert_eq!(tracks[0]["streamIndex"], 7);
    assert_eq!(tracks[0]["source"], "opensubtitles");
    assert_eq!(tracks[0]["type"], "subtitle");
    assert_eq!(tracks[1]["channels"], 6);
}
#[test]
fn mpv_state_normalizes_events_without_repeating_tracks() {
    let mut state = contract::State::new("fixture", &json!({}));
    state.event(&json!({"event":"file-loaded"}));
    state.event(&json!({"event":"property-change","name":"volume","data":95}));
    state.event(
        &json!({"event":"property-change","name":"track-list","data":[{"id":1,"type":"video"}]}),
    );
    let first = state.take_update().unwrap();
    assert_eq!(first["volume"], 0.95);
    assert_eq!(first["status"], "ready");
    assert!(first.get("tracks").is_some());
    assert!(state.take_update().is_none());
    state.event(&json!({"event":"property-change","name":"time-pos","data":1.0}));
    assert!(state.take_update().unwrap().get("tracks").is_none());
    state.event(&json!({"event":"property-change","name":"paused-for-cache","data":true}));
    assert_eq!(
        state.take_update().unwrap()["diagnostics"]["buffering"],
        true
    );
    state.event(&json!({"event":"property-change","name":"eof-reached","data":true}));
    assert_eq!(state.take_update().unwrap()["status"], "ended");
    state.event(&json!({"event":"playback-restart"}));
    assert_eq!(state.take_update().unwrap()["status"], "ready");
}
#[test]
fn mpv_ipc_framing_is_bounded_and_handles_fragmented_messages() {
    runtime().block_on(async {
        let (tx, mut rx) = mpsc::channel(4);
        let (mut writer, reader) = tokio::io::duplex(4096);
        let task = tokio::spawn(async move { read_messages(reader, &tx).await });
        writer.write_all(b"{\"event\":").await.unwrap();
        writer
            .write_all(b"\"file-loaded\"}\n{\"request_id\":2,\"error\":\"success\"}\n")
            .await
            .unwrap();
        drop(writer);
        assert_eq!(rx.recv().await.unwrap().unwrap()["event"], "file-loaded");
        assert_eq!(rx.recv().await.unwrap().unwrap()["request_id"], 2);
        assert!(task.await.unwrap().is_ok());
        let (tx, _rx) = mpsc::channel(1);
        let (mut writer, reader) = tokio::io::duplex(4096);
        let task = tokio::spawn(async move { read_messages(reader, &tx).await });
        let _ = writer.write_all(&vec![b'a'; MAX_FRAME + 1]).await;
        drop(writer);
        assert!(task.await.unwrap().unwrap_err().contains("limit"));
    });
}
#[test]
fn mpv_ipc_rejects_invalid_envelopes() {
    runtime().block_on(async {
        for bytes in [b"[]\n".as_slice(), b"no-json\n", b"{\"partial\":"] {
            let (tx, _rx) = mpsc::channel(1);
            let (mut writer, reader) = tokio::io::duplex(1024);
            writer.write_all(bytes).await.unwrap();
            drop(writer);
            assert!(read_messages(reader, &tx).await.is_err());
        }
    });
}
#[test]
fn mpv_private_endpoint_has_an_owner_and_cleanup() {
    let endpoint = Endpoint::new().unwrap();
    let directory = endpoint.directory.clone();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(directory.as_ref().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
    drop(endpoint);
    if let Some(path) = directory {
        assert!(!path.exists());
    }
}
#[test]
fn mpv_runtime_rejects_non_executables() {
    runtime().block_on(async {
        assert!(validate_executable(Path::new("mpv")).await.is_err());
        assert!(validate_executable(Path::new("/not-a-real-runtime/mpv"))
            .await
            .is_err());
        let resolver = RuntimeResolver::default();
        assert_eq!(
            resolver.availability(vec![], true).await.unwrap()["available"],
            false
        );
        assert!(resolver.resolve(vec![]).await.unwrap().is_none());
    });
}

#[test]
#[ignore = "requires LOOMTV_TEST_MPV and LOOMTV_TEST_FFMPEG; exercises real IPC with null audio/video outputs"]
fn generated_mpv_ipc_play_seek_tracks_eof_and_cleanup() {
    runtime().block_on(async{
    let mpv=PathBuf::from(std::env::var_os("LOOMTV_TEST_MPV").expect("explicit test mpv is required"));
    let ffmpeg=PathBuf::from(std::env::var_os("LOOMTV_TEST_FFMPEG").expect("explicit test FFmpeg is required"));assert!(mpv.is_absolute()&&ffmpeg.is_absolute());
    let (mpv,version)=validate_executable(&mpv).await.unwrap();println!("Verified test runtime {version}");
    let root=std::env::temp_dir().join(format!("loomtv-mpv-test-{}",uuid::Uuid::new_v4()));std::fs::create_dir(&root).unwrap();std::fs::write(root.join("TEST-OWNED"),b"generated media only").unwrap();
    let source=root.join("movie 字幕.mp4");let subtitle=root.join("movie 字幕.srt");std::fs::write(&subtitle,"1\n00:00:00,000 --> 00:00:03,000\nGenerated test subtitle\n").unwrap();
    let status=Command::new(ffmpeg).args(["-nostdin","-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc2=size=160x90:rate=24","-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t","4","-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p","-c:a","aac","-y"]).arg(&source).stdin(Stdio::null()).status().await.unwrap();assert!(status.success());
    let endpoint_before=std::fs::read_dir("/tmp").ok().map(|entries|entries.flatten().filter(|e|e.file_name().to_string_lossy().starts_with("loomtv-mpv-")).count());
    let (sender,receiver)=mpsc::channel(64);let(window,state)=watch::channel(WindowState::default());
    let (observed,events)=std::sync::mpsc::sync_channel(64);
    let task=tokio::spawn(worker(receiver,state,Arc::new(move|v|{let _=observed.try_send(v);}),true));let service=MpvService{sender,window};
    let loaded=service.start(mpv,source.to_string_lossy().into_owned(),json!({"volume":0.8,"audioDelay":0.1,"subtitleDelay":0.2,"subtitleFiles":[{"path":subtitle,"source":"sidecar"}]}),WindowState::default()).await.unwrap();
    let id=loaded["sessionId"].as_str().unwrap().to_owned();assert_eq!(loaded["surface"],"external-window");
    let deadline=Instant::now()+Duration::from_secs(5);
    loop {let value=service.send(|reply|Request::Inspect{reply}).await.unwrap();if value["state"]["status"]=="ready"&&value["state"]["tracks"].as_array().is_some_and(|rows|rows.len()>=3){break;}assert!(Instant::now()<deadline,"{value}");tokio::time::sleep(Duration::from_millis(30)).await;}
    assert!(service.command("stale".into(),json!({"type":"seek","position":1})).await.is_err());
    for v in [0.95,0.90,0.85,0.80]{service.command(id.clone(),json!({"type":"set-volume","volume":v})).await.unwrap();}
    service.command(id.clone(),json!({"type":"set-paused","paused":true})).await.unwrap();service.command(id.clone(),json!({"type":"seek","position":1.25})).await.unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    let inspect=service.send(|reply|Request::Inspect{reply}).await.unwrap();let pid=inspect["pid"].as_u64().unwrap();let directory=inspect["directory"].as_str().map(PathBuf::from);
    assert_eq!(inspect["state"]["volume"],0.8);assert_eq!(inspect["state"]["paused"],true);assert!((inspect["state"]["position"].as_f64().unwrap()-1.25).abs()<0.25);
    service.command(id.clone(),json!({"type":"seek","position":3.75})).await.unwrap();service.command(id.clone(),json!({"type":"set-paused","paused":false})).await.unwrap();
    let deadline=Instant::now()+Duration::from_secs(5);loop{let value=service.send(|reply|Request::Inspect{reply}).await.unwrap();if value["state"]["status"]=="ended"{break;}assert!(Instant::now()<deadline,"{value}");tokio::time::sleep(Duration::from_millis(30)).await;}
    service.command(id.clone(),json!({"type":"set-paused","paused":false})).await.unwrap();tokio::time::sleep(Duration::from_millis(180)).await;let replay=service.send(|reply|Request::Inspect{reply}).await.unwrap();assert_eq!(replay["state"]["sessionId"],id);assert_eq!(replay["state"]["status"],"ready");assert!(replay["state"]["position"].as_f64().unwrap()<2.);assert_eq!(replay["pid"],pid);assert_eq!(replay["state"]["volume"],0.8);
    assert_eq!(service.stop(Some(id.clone())).await.unwrap(),true);assert_eq!(service.stop(Some(id)).await.unwrap(),false);service.shutdown().await.unwrap();task.await.unwrap();
    if let Some(path)=directory{assert!(!path.exists());}
    #[cfg(target_os="linux")] assert!(!PathBuf::from(format!("/proc/{pid}")).exists());
    assert!(events.try_iter().any(|v|v["status"]=="closed"));
    if let Some(before)=endpoint_before{assert_eq!(std::fs::read_dir("/tmp").unwrap().flatten().filter(|e|e.file_name().to_string_lossy().starts_with("loomtv-mpv-")).count(),before);}
    assert!(root.join("TEST-OWNED").is_file());std::fs::remove_dir_all(root).unwrap();
});
}
