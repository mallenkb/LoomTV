use crate::Runtime;
use tauri::{
    http::{Request, Response},
    Manager, UriSchemeContext, UriSchemeResponder, Wry,
};

pub fn handle(
    context: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = context.app_handle().clone();
    let trusted = context.webview_label() == "main"
        && app
            .get_webview_window("main")
            .and_then(|window| window.url().ok())
            .is_some_and(|url| crate::trusted_ui_url(&url));
    tauri::async_runtime::spawn(async move {
        let response = if trusted {
            resource(&app, request).await
        } else {
            Err(403)
        };
        let response = response.unwrap_or_else(|status| {
            Response::builder()
                .status(status)
                .header("Cache-Control", "no-store")
                .body(Vec::new())
                .unwrap_or_default()
        });
        responder.respond(response);
    });
}
async fn resource(
    app: &tauri::AppHandle,
    request: Request<Vec<u8>>,
) -> Result<Response<Vec<u8>>, u16> {
    if !["GET", "HEAD"].contains(&request.method().as_str()) {
        return Err(405);
    }
    let state = app.state::<Runtime>();
    if state.closing.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(503);
    }
    let url = request.uri().to_string();
    let parsed = tauri::Url::parse(&url).map_err(|_| 403u16)?;
    if parsed.host_str() == Some("localhost") {
        if parsed.path() == "/api/custom-artwork" {
            let params = parsed
                .query_pairs()
                .collect::<std::collections::HashMap<_, _>>();
            let profile = params.get("profile").ok_or(403u16)?;
            let revision = params
                .get("revision")
                .and_then(|v| v.parse::<i64>().ok())
                .ok_or(403u16)?;
            let media = params.get("mediaId").ok_or(400u16)?;
            let target = params.get("target").ok_or(400u16)?;
            let store = state.store.clone();
            let media = media.to_string();
            let target = target.to_string();
            let profile = profile.to_string();
            let expected_profile = profile.clone();
            let (bytes, mime) = tokio::task::spawn_blocking(move || {
                store
                    .blocking_lock()
                    .custom_artwork_resource(&media, &target, &profile, revision)
            })
            .await
            .map_err(|_| 500u16)?
            .map_err(|_| 403u16)?;
            {
                let store = state.store.lock().await;
                store
                    .require_active(Some(&expected_profile))
                    .map_err(|_| 403u16)?;
                if store.selection_revision() != revision {
                    return Err(403);
                }
            }
            return Response::builder()
                .status(200)
                .header("Content-Type", mime)
                .header("Cache-Control", "private, no-store")
                .header("Access-Control-Allow-Origin", "*")
                .header("X-Content-Type-Options", "nosniff")
                .body(if request.method() == "HEAD" {
                    Vec::new()
                } else {
                    bytes
                })
                .map_err(|_| 500u16);
        }
        if parsed.path() != "/subtitle" {
            return Err(404);
        }
        let params = parsed
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        let path = params.get("path").ok_or(400u16)?;
        let profile = params.get("profile").ok_or(403u16)?;
        let revision = params
            .get("revision")
            .and_then(|v| v.parse::<i64>().ok())
            .ok_or(403u16)?;
        let ordinal = match params.get("streamOrdinal") {
            None => None,
            Some(value) => Some(value.parse::<u32>().map_err(|_| 400u16)?),
        };
        let (bytes, content_type) = state
            .media
            .local_resource(
                path,
                &loomtv_core::media_tools::Transform::Subtitle(ordinal),
                profile,
                revision,
            )
            .await
            .map_err(|_| 403u16)?;
        return Response::builder()
            .status(200)
            .header("Content-Type", content_type)
            .header("Cache-Control", "private, no-store")
            .header("Access-Control-Allow-Origin", "*")
            .header("X-Content-Type-Options", "nosniff")
            .body(if request.method() == "HEAD" {
                Vec::new()
            } else {
                bytes
            })
            .map_err(|_| 500u16);
    }
    let route = loomtv_core::remote::media_route(&url).map_err(|_| 403u16)?;
    // Video bytes stay on the streaming loopback server; custom protocols use bounded resource buffers.
    if route.starts_with("/stream?") || route.starts_with("/hls/") {
        let location = state.media.grant(&url).await.map_err(|_| 403u16)?;
        return Response::builder()
            .status(307)
            .header("Location", location)
            .header("Cache-Control", "no-store")
            .body(Vec::new())
            .map_err(|_| 500u16);
    }
    let epoch = state.remote.epoch();
    let mut upstream = state
        .remote
        .fetch_media(&route, request.method().as_str(), None, epoch)
        .await
        .map_err(|_| 502u16)?;
    let mut builder = Response::builder()
        .status(upstream.status())
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Access-Control-Allow-Origin", "*");
    if let Some(value) = upstream.headers().get("content-type") {
        builder = builder.header("Content-Type", value);
    }
    const LIMIT: usize = 16 * 1024 * 1024;
    if upstream
        .content_length()
        .is_some_and(|size| size > LIMIT as u64)
    {
        return Err(413);
    }
    let mut body = Vec::new();
    if request.method() != "HEAD" {
        while let Some(chunk) = upstream.chunk().await.map_err(|_| 502u16)? {
            if state.remote.epoch() != epoch {
                return Err(403);
            }
            if body.len() + chunk.len() > LIMIT {
                return Err(413);
            }
            body.extend_from_slice(&chunk);
        }
    }
    builder.body(body).map_err(|_| 500u16)
}
