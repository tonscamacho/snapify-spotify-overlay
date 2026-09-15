use rand::Rng;
use reqwest::{Method, StatusCode};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::AppHandle;

use crate::auth;

#[derive(Clone, Debug)]
struct RequestEntry {
    method: String,
    path: String,
    result: &'static str,
    retry_after: Option<String>,
}

const REQUEST_LOG_CAP: usize = 500;

fn request_log() -> &'static Mutex<VecDeque<RequestEntry>> {
    static LOG: OnceLock<Mutex<VecDeque<RequestEntry>>> = OnceLock::new();
    LOG.get_or_init(|| Mutex::new(VecDeque::with_capacity(REQUEST_LOG_CAP)))
}

fn classify_result(status: StatusCode, body: &str) -> &'static str {
    if status == StatusCode::TOO_MANY_REQUESTS {
        if body.contains("QUOTA_EXCEEDED") || body.contains("quota") {
            "429-quota"
        } else {
            "429-rate"
        }
    } else if status == StatusCode::UNAUTHORIZED {
        "401"
    } else if status.is_success()
        || status == StatusCode::NO_CONTENT
        || status == StatusCode::NOT_FOUND
    {
        "ok"
    } else {
        "other"
    }
}

fn record_request(
    method: &Method,
    path: &str,
    result: &'static str,
    retry_after: Option<&str>,
) {
    if let Ok(mut log) = request_log().lock() {
        if log.len() >= REQUEST_LOG_CAP {
            log.pop_front();
        }
        log.push_back(RequestEntry {
            method: method.to_string(),
            path: path.to_string(),
            result,
            retry_after: retry_after.map(|s| s.to_string()),
        });
    }
}

fn api_url(path: &str) -> String {
    format!("https://api.spotify.com/v1{path}")
}

fn shared_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

struct Cooldown {
    rate_until: Option<tokio::time::Instant>,
    quota_until: Option<tokio::time::Instant>,
}

fn cooldown_state() -> &'static tokio::sync::Mutex<Cooldown> {
    static STATE: OnceLock<tokio::sync::Mutex<Cooldown>> = OnceLock::new();
    STATE.get_or_init(|| {
        tokio::sync::Mutex::new(Cooldown {
            rate_until: None,
            quota_until: None,
        })
    })
}

fn spotify_gate() -> &'static tokio::sync::Semaphore {
    static GATE: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Semaphore::new(1))
}

struct InflightSlot {
    notify: tokio::sync::Notify,
    result: tokio::sync::Mutex<Option<Result<serde_json::Value, String>>>,
}

fn inflight_gets() -> &'static tokio::sync::Mutex<HashMap<String, Arc<InflightSlot>>> {
    static MAP: OnceLock<tokio::sync::Mutex<HashMap<String, Arc<InflightSlot>>>> =
        OnceLock::new();
    MAP.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

fn inflight_key(method: &Method, path: &str, query: &[(&str, &str)]) -> String {
    let mut key = String::with_capacity(path.len() + 32);
    key.push_str(method.as_str());
    key.push(' ');
    key.push_str(path);
    for (k, v) in query {
        key.push('|');
        key.push_str(k);
        key.push('=');
        key.push_str(v);
    }
    key
}

fn parse_retry_after(raw: Option<&str>, is_quota: bool) -> Duration {
    let secs: u64 = raw.and_then(|s| s.trim().parse().ok()).unwrap_or(0);
    if is_quota {
        Duration::from_secs(secs.max(30).min(300))
    } else if secs == 0 {
        Duration::from_millis(1000)
    } else {
        Duration::from_secs(secs.min(30))
    }
}

fn jittered(base: Duration, attempt: u32) -> Duration {
    let shift = attempt.min(3);
    let doubled = base.as_millis() as u64 * (1u64 << shift);
    let cap = doubled.min(8000).max(500);
    let v = rand::thread_rng().gen_range(0..=cap);
    Duration::from_millis(v.max(250))
}

async fn wait_for_cooldown() {
    loop {
        let wake_in = {
            let guard = cooldown_state().lock().await;
            let now = tokio::time::Instant::now();
            let mut earliest: Option<Duration> = None;
            for until in [guard.rate_until, guard.quota_until].into_iter().flatten() {
                if until > now {
                    let d = until - now;
                    earliest = Some(match earliest {
                        Some(e) => e.min(d),
                        None => d,
                    });
                }
            }
            earliest
        };
        match wake_in {
            Some(d) => tokio::time::sleep(d).await,
            None => return,
        }
    }
}

async fn set_rate_cooldown(wait: Duration) {
    let mut guard = cooldown_state().lock().await;
    let until = tokio::time::Instant::now() + wait;
    guard.rate_until = Some(match guard.rate_until {
        Some(prev) => prev.max(until),
        None => until,
    });
}

async fn set_quota_cooldown(wait: Duration) {
    let mut guard = cooldown_state().lock().await;
    let until = tokio::time::Instant::now() + wait;
    guard.quota_until = Some(match guard.quota_until {
        Some(prev) => prev.max(until),
        None => until,
    });
}

#[derive(Clone)]
struct CacheEntry {
    body: serde_json::Value,
    etag: Option<String>,
    stored_at: tokio::time::Instant,
    ttl: Duration,
}

const CACHE_CAP: usize = 100;

fn response_cache(
) -> &'static tokio::sync::Mutex<HashMap<String, CacheEntry>> {
    static CACHE: OnceLock<tokio::sync::Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

fn cache_ttl(path: &str) -> Option<Duration> {
    if path.starts_with("/me/player") || path.starts_with("/search") {
        return None;
    }
    if path.contains("/contains") {
        return None;
    }
    if path == "/me" {
        return Some(Duration::from_secs(60));
    }
    for prefix in [
        "/playlists/",
        "/albums/",
        "/artists/",
        "/shows/",
        "/audiobooks/",
        "/episodes/",
        "/tracks/",
        "/chapters/",
        "/me/tracks",
        "/me/albums",
        "/me/shows",
        "/me/episodes",
        "/me/audiobooks",
        "/me/following",
        "/me/top",
        "/me/playlists",
    ] {
        if path.starts_with(prefix) {
            return Some(Duration::from_secs(30));
        }
    }
    None
}



async fn call(
    app: &AppHandle,
    method: Method,
    path: &str,
    query: &[(&str, &str)],
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if method == Method::GET {
        let key = inflight_key(&method, path, query);
        let slot = loop {
            let shared = {
                let mut map = inflight_gets().lock().await;
                match map.get(&key) {
                    Some(existing) => existing.clone(),
                    None => {
                        let fresh = Arc::new(InflightSlot {
                            notify: tokio::sync::Notify::new(),
                            result: tokio::sync::Mutex::new(None),
                        });
                        map.insert(key.clone(), fresh.clone());
                        break fresh;
                    }
                }
            };
            // Race-free wait: register interest before re-checking the
            // result, so a notify between check and sleep cannot strand us.
            let notified = shared.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(result) = shared.result.lock().await.clone() {
                return result;
            }
            notified.await;
        };
        let out = call_inner(app, method, path, query, body).await;
        *slot.result.lock().await = Some(out.clone());
        slot.notify.notify_waiters();
        inflight_gets().lock().await.remove(&key);
        return out;
    }
    call_inner(app, method, path, query, body).await
}

async fn call_inner(
    app: &AppHandle,
    method: Method,
    path: &str,
    query: &[(&str, &str)],
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let cache_key = if method == Method::GET {
        cache_ttl(path).map(|ttl| (inflight_key(&method, path, query), ttl))
    } else {
        None
    };
    if let Some((ref key, ttl)) = cache_key {
        let hit = {
            let cache = response_cache().lock().await;
            cache.get(key).cloned().and_then(|entry| {
                if entry.stored_at.elapsed() < entry.ttl.min(ttl) {
                    Some(entry.body)
                } else {
                    None
                }
            })
        };
        if let Some(cached) = hit {
            return Ok(cached);
        }
    }
    let mut token = auth::access_token(app).await?;
    let mut refreshed = false;
    let mut attempt: u32 = 0;
    loop {
        wait_for_cooldown().await;
        let conditional_etag = if let Some((ref key, _)) = cache_key {
            response_cache()
                .lock()
                .await
                .get(key)
                .and_then(|e| e.etag.clone())
        } else {
            None
        };
        let res = {
            let _permit = spotify_gate()
                .acquire()
                .await
                .map_err(|e| e.to_string())?;
            send(
                method.clone(),
                path,
                query,
                body.clone(),
                &token,
                conditional_etag.as_deref(),
            )
            .await?
        };
        if res.status() == StatusCode::UNAUTHORIZED && !refreshed {
            refreshed = true;
            token = auth::refresh_now(app).await?;
            continue;
        }
        if res.status() == StatusCode::TOO_MANY_REQUESTS {
            let retry_raw = res
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let status = res.status();
            let response_body = res.text().await.unwrap_or_default();
            let is_quota =
                response_body.contains("QUOTA_EXCEEDED") || response_body.contains("quota");
            let base = parse_retry_after(retry_raw.as_deref(), is_quota);
            record_request(
                &method,
                path,
                classify_result(status, &response_body),
                retry_raw.as_deref(),
            );
            if is_quota {
                set_quota_cooldown(base).await;
                return decide(&method, status, retry_raw.as_deref(), &response_body);
            }
            if method == Method::GET && attempt < 3 {
                attempt += 1;
                let wait = jittered(base, attempt);
                set_rate_cooldown(wait).await;
                tokio::time::sleep(wait).await;
                continue;
            }
            set_rate_cooldown(base).await;
            return decide(&method, status, retry_raw.as_deref(), &response_body);
        }
        if res.status() == StatusCode::NOT_MODIFIED {
            if let Some((ref key, _)) = cache_key {
                let mut cache = response_cache().lock().await;
                if let Some(entry) = cache.get_mut(key) {
                    entry.stored_at = tokio::time::Instant::now();
                    record_request(&method, path, "ok", None);
                    return Ok(entry.body.clone());
                }
            }
        }
        let etag = res
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let out = interpret(res, &method, path).await;
        if method != Method::GET && out.is_ok() {
            response_cache().lock().await.clear();
        }
        if let (Ok(ref value), Some((ref key, ttl))) = (&out, &cache_key) {
            let empty = value
                .as_object()
                .is_some_and(|o| o.get("empty") == Some(&serde_json::Value::Bool(true)));
            if !empty {
                let mut cache = response_cache().lock().await;
                if cache.len() >= CACHE_CAP {
                    if let Some(oldest) = cache.keys().next().cloned() {
                        cache.remove(&oldest);
                    }
                }
                cache.insert(
                    key.clone(),
                    CacheEntry {
                        body: value.clone(),
                        etag,
                        stored_at: tokio::time::Instant::now(),
                        ttl: *ttl,
                    },
                );
            }
        }
        return out;
    }
}

async fn send(
    method: Method,
    path: &str,
    query: &[(&str, &str)],
    body: Option<serde_json::Value>,
    token: &str,
    if_none_match: Option<&str>,
) -> Result<reqwest::Response, String> {
    let mut req = shared_client()
        .request(method, api_url(path))
        .bearer_auth(token)
        .query(query);
    if let Some(tag) = if_none_match {
        req = req.header("If-None-Match", tag);
    }
    if let Some(b) = body {
        req = req.json(&b);
    } else {
        // Spotify rejects bodiless PUT/POST/DELETE without an explicit
        // length as 411. reqwest omits Content-Length for an empty body,
        // so set it explicitly.
        req = req.header(reqwest::header::CONTENT_LENGTH, "0").body("");
    }
    req.send().await.map_err(|e| e.to_string())
}

async fn interpret(
    res: reqwest::Response,
    method: &Method,
    path: &str,
) -> Result<serde_json::Value, String> {
    let status = res.status();
    let retry_after = if status == StatusCode::TOO_MANY_REQUESTS {
        res.headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
    } else {
        None
    };
    let body = res.text().await.unwrap_or_default();
    record_request(
        method,
        path,
        classify_result(status, &body),
        retry_after.as_deref(),
    );
    decide(method, status, retry_after.as_deref(), &body)
}

fn trim_snippet(body: &str) -> String {
    // Spotify gateway errors arrive as HTML pages. Trim them so the
    // overlay toast never dumps markup like the 411 page did.
    let short = body
        .replace(|c: char| c.is_whitespace(), " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    short.chars().take(220).collect()
}

fn missing_scope(body: &str) -> Option<String> {
    // Spotify: {"error":{"status":403,"message":"Insufficient client scope: user-top-read"}}
    let marker = "Insufficient client scope:";
    let at = body.find(marker)?;
    body[at + marker.len()..]
        .split(|c| c == '"' || c == '\'' || c == '}' || c == ',')
        .map(str::trim)
        .find(|s| !s.is_empty())
        .filter(|s| s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .map(|s| s.to_string())
}

fn decide(
    method: &Method,
    status: StatusCode,
    retry_after: Option<&str>,
    body: &str,
) -> Result<serde_json::Value, String> {
    if status == StatusCode::TOO_MANY_REQUESTS {
        // Quota is shared per developer account and distinct from rate
        // limits. QUOTA_EXCEEDED backs off longer and never spins hot.
        if body.contains("QUOTA_EXCEEDED") || body.contains("quota") {
            return Err(format!(
                "quota-exceeded: developer quota hit, back off and retry after {}s. Detail reads run on demand only.",
                retry_after.unwrap_or("30")
            ));
        }
        return Err(format!(
            "rate-limited: retry after {}s",
            retry_after.unwrap_or("2")
        ));
    }
    if status == StatusCode::NO_CONTENT || status == StatusCode::NOT_FOUND {
        return Ok(serde_json::json!({ "empty": true }));
    }
    if status == StatusCode::UNAUTHORIZED {
        return Err("unauthorized: token rejected".into());
    }
    if status == StatusCode::LENGTH_REQUIRED {
        return Err("spotify rejected the request length (411). Update the app and retry.".into());
    }
    if !status.is_success() {
        if status == StatusCode::FORBIDDEN {
            if let Some(scope) = missing_scope(body) {
                return Err(format!(
                    "spotify 403 Forbidden: missing permission \"{scope}\" — logout and login again to grant it"
                ));
            }
        }
        return Err(format!("spotify {status}: {}", trim_snippet(body)));
    }
    if body.trim().is_empty() {
        return Ok(serde_json::json!({ "empty": true }));
    }
    match serde_json::from_str(body) {
        Ok(v) => Ok(v),
        Err(_) => {
            if *method != Method::GET && status.is_success() {
                // Commands are fire-and-forget: Spotify answers 2xx with an
                // empty body, so on success an out-of-contract body still
                // means the press worked. Queries stay strict so corrupt
                // player/queue payloads keep erroring instead of wiping
                // on-screen state to empty.
                return Ok(serde_json::json!({ "empty": true }));
            }
            Err(format!(
                "spotify {status}: unexpected response (not JSON): {}",
                trim_snippet(body)
            ))
        }
    }
}

#[tauri::command]
pub async fn request_log_counts() -> Result<serde_json::Value, String> {
    let log = request_log().lock().map_err(|e| e.to_string())?;
    let mut ok = 0;
    let mut rate = 0;
    let mut quota = 0;
    let mut unauthorized = 0;
    let mut other = 0;
    for entry in log.iter() {
        match entry.result {
            "ok" => ok += 1,
            "429-rate" => rate += 1,
            "429-quota" => quota += 1,
            "401" => unauthorized += 1,
            _ => other += 1,
        }
    }
    Ok(serde_json::json!({
        "total": log.len(),
        "ok": ok,
        "rate_limited": rate,
        "quota_exceeded": quota,
        "unauthorized": unauthorized,
        "other": other,
    }))
}

#[tauri::command]
pub async fn request_log_recent(limit: Option<usize>) -> Result<serde_json::Value, String> {
    let log = request_log().lock().map_err(|e| e.to_string())?;
    let n = limit.unwrap_or(50).clamp(1, REQUEST_LOG_CAP);
    let items: Vec<serde_json::Value> = log
        .iter()
        .rev()
        .take(n)
        .map(|entry| {
            serde_json::json!({
                "method": entry.method,
                "path": entry.path,
                "result": entry.result,
                "retry_after": entry.retry_after,
            })
        })
        .collect();
    Ok(serde_json::json!(items))
}

#[tauri::command]
pub async fn get_player(app: AppHandle) -> Result<serde_json::Value, String> {
    call(&app, Method::GET, "/me/player", &[], None).await
}

#[tauri::command]
pub async fn get_devices(app: AppHandle) -> Result<serde_json::Value, String> {
    call(&app, Method::GET, "/me/player/devices", &[], None).await
}

#[tauri::command]
pub async fn get_queue(app: AppHandle) -> Result<serde_json::Value, String> {
    call(&app, Method::GET, "/me/player/queue", &[], None).await
}

#[tauri::command]
pub async fn play(app: AppHandle, device_id: Option<String>) -> Result<serde_json::Value, String> {
    let q: Vec<(&str, &str)> = match &device_id {
        Some(d) => vec![("device_id", d.as_str())],
        None => vec![],
    };
    call(&app, Method::PUT, "/me/player/play", &q, None).await
}

#[tauri::command]
pub async fn pause(app: AppHandle, device_id: Option<String>) -> Result<serde_json::Value, String> {
    let q: Vec<(&str, &str)> = match &device_id {
        Some(d) => vec![("device_id", d.as_str())],
        None => vec![],
    };
    call(&app, Method::PUT, "/me/player/pause", &q, None).await
}

#[tauri::command]
pub async fn next_track(
    app: AppHandle,
    device_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let q: Vec<(&str, &str)> = match &device_id {
        Some(d) => vec![("device_id", d.as_str())],
        None => vec![],
    };
    call(&app, Method::POST, "/me/player/next", &q, None).await
}

#[tauri::command]
pub async fn prev_track(
    app: AppHandle,
    device_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let q: Vec<(&str, &str)> = match &device_id {
        Some(d) => vec![("device_id", d.as_str())],
        None => vec![],
    };
    call(&app, Method::POST, "/me/player/previous", &q, None).await
}

#[tauri::command]
pub async fn seek(
    app: AppHandle,
    position_ms: i64,
    device_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let pos = position_ms.to_string();
    let mut q = vec![("position_ms", pos.as_str())];
    if let Some(d) = &device_id {
        q.push(("device_id", d.as_str()));
    }
    call(&app, Method::PUT, "/me/player/seek", &q, None).await
}

#[tauri::command]
pub async fn set_volume(
    app: AppHandle,
    volume_percent: i64,
    device_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let vol = volume_percent.clamp(0, 100).to_string();
    let mut q = vec![("volume_percent", vol.as_str())];
    if let Some(d) = &device_id {
        q.push(("device_id", d.as_str()));
    }
    call(&app, Method::PUT, "/me/player/volume", &q, None).await
}

#[tauri::command]
pub async fn set_shuffle(
    app: AppHandle,
    enabled: bool,
    device_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let on = enabled.to_string();
    let mut q = vec![("state", on.as_str())];
    if let Some(d) = &device_id {
        q.push(("device_id", d.as_str()));
    }
    call(&app, Method::PUT, "/me/player/shuffle", &q, None).await
}

#[tauri::command]
pub async fn set_repeat(
    app: AppHandle,
    mode: String,
    device_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let mode = match mode.as_str() {
        "track" | "context" => mode,
        _ => "off".to_string(),
    };
    let mut q = vec![("state", mode.as_str())];
    if let Some(d) = &device_id {
        q.push(("device_id", d.as_str()));
    }
    call(&app, Method::PUT, "/me/player/repeat", &q, None).await
}

#[tauri::command]
pub async fn transfer_playback(
    app: AppHandle,
    device_id: String,
    play_now: bool,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({ "device_ids": [device_id], "play": play_now });
    call(&app, Method::PUT, "/me/player", &[], Some(body)).await
}

#[tauri::command]
pub async fn add_to_queue(
    app: AppHandle,
    uri: String,
    device_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut q = vec![("uri", uri.as_str())];
    if let Some(d) = &device_id {
        q.push(("device_id", d.as_str()));
    }
    call(&app, Method::POST, "/me/player/queue", &q, None).await
}

fn clamp_page(limit: i64, offset: i64) -> (String, String) {
    (limit.clamp(1, 50).to_string(), offset.max(0).to_string())
}

async fn paged(
    app: &AppHandle,
    method: Method,
    path: &str,
    extra: &[(&str, &str)],
    limit: i64,
    offset: i64,
) -> Result<serde_json::Value, String> {
    let (ls, os) = clamp_page(limit, offset);
    let mut q = vec![("limit", ls.as_str()), ("offset", os.as_str())];
    for (k, v) in extra {
        q.push((k, v));
    }
    call(app, method, path, &q, None).await
}

#[tauri::command]
pub async fn get_me(app: AppHandle) -> Result<serde_json::Value, String> {
    // Self only. Do not rely on stale fields removed in Feb 2026:
    // popularity, followers, available_markets, label, publisher,
    // linked_from, country, product. Frontend uses id/display_name/images only.
    // Bulk `?ids=` is never called; callers loop singly with quota backoff.
    call(&app, Method::GET, "/me", &[], None).await
}

#[tauri::command]
pub async fn get_my_playlists(
    app: AppHandle,
    limit: i64,
    offset: i64,
) -> Result<serde_json::Value, String> {
    paged(&app, Method::GET, "/me/playlists", &[], limit, offset).await
}

#[tauri::command]
pub async fn create_playlist(
    app: AppHandle,
    name: String,
    public: bool,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({ "name": name, "public": public });
    call(&app, Method::POST, "/me/playlists", &[], Some(body)).await
}

#[tauri::command]
pub async fn get_my_tracks(
    app: AppHandle,
    limit: i64,
    offset: i64,
) -> Result<serde_json::Value, String> {
    paged(&app, Method::GET, "/me/tracks", &[], limit, offset).await
}

#[tauri::command]
pub async fn get_my_albums(
    app: AppHandle,
    limit: i64,
    offset: i64,
) -> Result<serde_json::Value, String> {
    paged(&app, Method::GET, "/me/albums", &[], limit, offset).await
}

#[tauri::command]
pub async fn get_my_shows(
    app: AppHandle,
    limit: i64,
    offset: i64,
) -> Result<serde_json::Value, String> {
    paged(&app, Method::GET, "/me/shows", &[], limit, offset).await
}

#[tauri::command]
pub async fn get_my_episodes(
    app: AppHandle,
    limit: i64,
    offset: i64,
) -> Result<serde_json::Value, String> {
    paged(&app, Method::GET, "/me/episodes", &[], limit, offset).await
}

#[tauri::command]
pub async fn get_my_audiobooks(
    app: AppHandle,
    limit: i64,
    offset: i64,
) -> Result<serde_json::Value, String> {
    paged(&app, Method::GET, "/me/audiobooks", &[], limit, offset).await
}

#[tauri::command]
pub async fn get_my_following(
    app: AppHandle,
    kind: String,
    limit: i64,
    after: Option<String>,
) -> Result<serde_json::Value, String> {
    let t = match kind.as_str() {
        "show" | "episode" | "audiobook" => kind,
        _ => "artist".to_string(),
    };
    let ls = limit.clamp(1, 50).to_string();
    let mut q = vec![("type", t.as_str()), ("limit", ls.as_str())];
    if let Some(a) = &after {
        q.push(("after", a.as_str()));
    }
    call(&app, Method::GET, "/me/following", &q, None).await
}

#[tauri::command]
pub async fn library_contains(
    app: AppHandle,
    kind: String,
    ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    // Batch `?ids=` up to 50 per call. One network call per chunk; a 429
    // returns partial results plus the queued-retry error.
    let path = match kind.as_str() {
        "album" => "/me/albums/contains",
        "episode" => "/me/episodes/contains",
        "audiobook" => "/me/audiobooks/contains",
        "show" => "/me/shows/contains",
        _ => "/me/tracks/contains",
    };
    let mut out: Vec<bool> = Vec::with_capacity(ids.len().min(50));
    for chunk in ids.chunks(50).take(1) {
        if chunk.is_empty() {
            break;
        }
        let joined = chunk.join(",");
        let q = [("ids", joined.as_str())];
        match call(&app, Method::GET, path, &q, None).await {
            Ok(v) => {
                let flags = v.as_array().map(|a| {
                    a.iter().map(|x| x.as_bool().unwrap_or(false)).collect::<Vec<_>>()
                }).unwrap_or_default();
                if flags.len() == chunk.len() {
                    out.extend(flags);
                } else {
                    return Err("spotify contains: short batch response".into());
                }
            }
            Err(e) => return Err(e),
        }
    }
    Ok(serde_json::Value::Array(out.into_iter().map(serde_json::Value::Bool).collect()))
}

#[tauri::command]
pub async fn library_save(
    app: AppHandle,
    kind: String,
    ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    // Universal heart through PUT /me/library. Never save liked content locally.
    let body = serde_json::json!({ "ids": ids, "kind": kind });
    call(&app, Method::PUT, "/me/library", &[], Some(body)).await
}

#[tauri::command]
pub async fn library_remove(
    app: AppHandle,
    kind: String,
    ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({ "ids": ids, "kind": kind });
    call(&app, Method::DELETE, "/me/library", &[], Some(body)).await
}

#[tauri::command]
pub async fn follow_put(
    app: AppHandle,
    kind: String,
    ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    let t = if kind == "show" || kind == "episode" { kind } else { "artist".to_string() };
    let q = [("type", t.as_str())];
    let body = serde_json::json!({ "ids": ids });
    call(&app, Method::PUT, "/me/following", &q, Some(body)).await
}

#[tauri::command]
pub async fn follow_delete(
    app: AppHandle,
    kind: String,
    ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    let t = if kind == "show" || kind == "episode" { kind } else { "artist".to_string() };
    let q = [("type", t.as_str())];
    let body = serde_json::json!({ "ids": ids });
    call(&app, Method::DELETE, "/me/following", &q, Some(body)).await
}

#[tauri::command]
pub async fn get_followed_artists(
    app: AppHandle,
    limit: i64,
    after: Option<String>,
) -> Result<serde_json::Value, String> {
    let ls = limit.clamp(1, 50).to_string();
    let mut q = vec![("type", "artist"), ("limit", ls.as_str())];
    if let Some(a) = &after {
        q.push(("after", a.as_str()));
    }
    call(&app, Method::GET, "/me/following", &q, None).await
}

#[tauri::command]
pub async fn get_my_top(
    app: AppHandle,
    kind: String,
    limit: i64,
    offset: i64,
) -> Result<serde_json::Value, String> {
    let kind = match kind.as_str() {
        "tracks" => "tracks",
        _ => "artists",
    };
    paged(&app, Method::GET, &format!("/me/top/{kind}"), &[], limit, offset).await
}

#[tauri::command]
pub async fn get_recently_played(
    app: AppHandle,
    limit: i64,
) -> Result<serde_json::Value, String> {
    let ls = limit.clamp(1, 50).to_string();
    let q = [("limit", ls.as_str())];
    call(&app, Method::GET, "/me/player/recently-played", &q, None).await
}

#[tauri::command]
pub async fn get_playlist(app: AppHandle, playlist_id: String) -> Result<serde_json::Value, String> {
    call(
        &app,
        Method::GET,
        &format!("/playlists/{playlist_id}"),
        &[],
        None,
    )
    .await
}

/// Playlist track reads, newest endpoint first. `/items` is the documented
/// read path and serves owned/collaborator playlists on apps of any age;
/// `/tracks` is the legacy path that still serves grandfathered apps.
/// Spotify answers 403 on both for other people's playlists (owner-only
/// reads since Feb 2026), so callers must treat terminal 403 as a wall,
/// not a scope problem.
fn playlist_items_primary(playlist_id: &str) -> String {
    format!("/playlists/{playlist_id}/items")
}

fn playlist_items_fallback(playlist_id: &str) -> String {
    format!("/playlists/{playlist_id}/tracks")
}

/// Follow-up read only when the refusal looks like an endpoint/ownership
/// wall. Auth (401), throttling (429), and server errors surface at once
/// instead of spending quota on a second call.
fn playlist_items_should_retry(err: &str) -> bool {
    err.contains("403")
}

#[tauri::command]
pub async fn get_playlist_items(
    app: AppHandle,
    playlist_id: String,
    limit: i64,
    offset: i64,
) -> Result<serde_json::Value, String> {
    match paged(
        &app,
        Method::GET,
        &playlist_items_primary(&playlist_id),
        &[],
        limit,
        offset,
    )
    .await
    {
        Ok(v) => Ok(v),
        Err(e) if playlist_items_should_retry(&e) => {
            paged(
                &app,
                Method::GET,
                &playlist_items_fallback(&playlist_id),
                &[],
                limit,
                offset,
            )
            .await
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn add_playlist_items(
    app: AppHandle,
    playlist_id: String,
    uris: Vec<String>,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({ "uris": uris });
    call(
        &app,
        Method::POST,
        &format!("/playlists/{playlist_id}/items"),
        &[],
        Some(body),
    )
    .await
}

#[tauri::command]
pub async fn remove_playlist_items(
    app: AppHandle,
    playlist_id: String,
    uris: Vec<String>,
) -> Result<serde_json::Value, String> {
    let items: Vec<serde_json::Value> = uris.into_iter().map(|u| serde_json::json!({ "uri": u })).collect();
    let body = serde_json::json!({ "items": items });
    call(
        &app,
        Method::DELETE,
        &format!("/playlists/{playlist_id}/items"),
        &[],
        Some(body),
    )
    .await
}

#[tauri::command]
pub async fn reorder_playlist_items(
    app: AppHandle,
    playlist_id: String,
    range_start: i64,
    insert_before: i64,
    range_length: i64,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({
        "range_start": range_start,
        "insert_before": insert_before,
        "range_length": range_length,
    });
    call(
        &app,
        Method::PUT,
        &format!("/playlists/{playlist_id}/items"),
        &[],
        Some(body),
    )
    .await
}

#[tauri::command]
pub async fn get_track(app: AppHandle, track_id: String) -> Result<serde_json::Value, String> {
    call(&app, Method::GET, &format!("/tracks/{track_id}"), &[], None).await
}

#[tauri::command]
pub async fn get_artist(app: AppHandle, artist_id: String) -> Result<serde_json::Value, String> {
    call(&app, Method::GET, &format!("/artists/{artist_id}"), &[], None).await
}

#[tauri::command]
pub async fn get_related_artists(
    app: AppHandle,
    artist_id: String,
) -> Result<serde_json::Value, String> {
    call(
        &app,
        Method::GET,
        &format!("/artists/{artist_id}/related-artists"),
        &[],
        None,
    )
    .await
}

#[tauri::command]
pub async fn get_artist_albums(
    app: AppHandle,
    artist_id: String,
    limit: i64,
    offset: i64,
) -> Result<serde_json::Value, String> {
    paged(
        &app,
        Method::GET,
        &format!("/artists/{artist_id}/albums"),
        &[("include_groups", "album,single")],
        limit,
        offset,
    )
    .await
}

#[tauri::command]
pub async fn get_album(app: AppHandle, album_id: String) -> Result<serde_json::Value, String> {
    // Always fetch explicit and URI types for badges and ±15s layouts.
    call(&app, Method::GET, &format!("/albums/{album_id}"), &[], None).await
}

#[tauri::command]
pub async fn get_album_tracks(
    app: AppHandle,
    album_id: String,
    limit: i64,
    offset: i64,
) -> Result<serde_json::Value, String> {
    paged(
        &app,
        Method::GET,
        &format!("/albums/{album_id}/tracks"),
        &[],
        limit,
        offset,
    )
    .await
}

#[tauri::command]
pub async fn get_show(app: AppHandle, show_id: String) -> Result<serde_json::Value, String> {
    call(&app, Method::GET, &format!("/shows/{show_id}"), &[], None).await
}

#[tauri::command]
pub async fn get_show_episodes(
    app: AppHandle,
    show_id: String,
    limit: i64,
    offset: i64,
) -> Result<serde_json::Value, String> {
    paged(
        &app,
        Method::GET,
        &format!("/shows/{show_id}/episodes"),
        &[],
        limit,
        offset,
    )
    .await
}

#[tauri::command]
pub async fn get_episode(app: AppHandle, episode_id: String) -> Result<serde_json::Value, String> {
    call(&app, Method::GET, &format!("/episodes/{episode_id}"), &[], None).await
}

#[tauri::command]
pub async fn get_audiobook(
    app: AppHandle,
    audiobook_id: String,
) -> Result<serde_json::Value, String> {
    call(&app, Method::GET, &format!("/audiobooks/{audiobook_id}"), &[], None).await
}

#[tauri::command]
pub async fn get_audiobook_chapters(
    app: AppHandle,
    audiobook_id: String,
    limit: i64,
    offset: i64,
) -> Result<serde_json::Value, String> {
    paged(
        &app,
        Method::GET,
        &format!("/audiobooks/{audiobook_id}/chapters"),
        &[],
        limit,
        offset,
    )
    .await
}

#[tauri::command]
pub async fn get_chapter(app: AppHandle, chapter_id: String) -> Result<serde_json::Value, String> {
    call(&app, Method::GET, &format!("/chapters/{chapter_id}"), &[], None).await
}

#[tauri::command]
pub async fn search(
    app: AppHandle,
    query: String,
    limit: i64,
    offset: i64,
) -> Result<serde_json::Value, String> {
    // Search capped: limit max 10, default 5, paginate by offset.
    // Shelves cap at 20 items downstream. Cache briefly, refresh on view.
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(serde_json::json!({ "empty": true }));
    }
    let ls = limit.clamp(1, 10).to_string();
    let os = offset.max(0).to_string();
    let types = "album,artist,playlist,track,show,episode,audiobook";
    let qq = [
        ("q", q.as_str()),
        ("type", types),
        ("limit", ls.as_str()),
        ("offset", os.as_str()),
    ];
    call(&app, Method::GET, "/search", &qq, None).await
}

#[tauri::command]
pub async fn play_context(
    app: AppHandle,
    context_uri: String,
    device_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let q: Vec<(&str, &str)> = match &device_id {
        Some(d) => vec![("device_id", d.as_str())],
        None => vec![],
    };
    let body = serde_json::json!({ "context_uri": context_uri });
    call(&app, Method::PUT, "/me/player/play", &q, Some(body)).await
}

#[tauri::command]
pub async fn play_uris(
    app: AppHandle,
    uris: Vec<String>,
    device_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let q: Vec<(&str, &str)> = match &device_id {
        Some(d) => vec![("device_id", d.as_str())],
        None => vec![],
    };
    let body = serde_json::json!({ "uris": uris });
    call(&app, Method::PUT, "/me/player/play", &q, Some(body)).await
}

#[cfg(test)]
mod tests {
    use super::{cache_ttl, classify_result, decide, inflight_key, parse_retry_after, playlist_items_fallback, playlist_items_primary, playlist_items_should_retry};
    use reqwest::{Method, StatusCode};

    #[test]
    fn playlist_track_reads_prefer_items_then_tracks() {
        // `/items` is the documented read path; `/tracks` is the legacy
        // fallback for grandfathered apps. Both 403 other people's
        // playlists, so the order only decides which wall is hit first.
        assert_eq!(playlist_items_primary("abc"), "/playlists/abc/items");
        assert_eq!(playlist_items_fallback("abc"), "/playlists/abc/tracks");
    }

    #[test]
    fn playlist_track_retry_only_on_forbidden() {
        assert!(playlist_items_should_retry("spotify 403 Forbidden: {\"error\":{}}"));
        assert!(!playlist_items_should_retry("rate-limited: retry after 7s"));
        assert!(!playlist_items_should_retry("quota-exceeded: back off"));
        assert!(!playlist_items_should_retry("unauthorized: token rejected"));
        assert!(!playlist_items_should_retry("spotify 502 Bad Gateway: boom"));
        assert!(!playlist_items_should_retry(""));
    }

    #[test]
    fn serde_mechanism_matches_user_screenshot() {
        // Proves the pre-fix toast text came from this path: a non-JSON
        // 2xx body surfaces the raw serde error verbatim.
        let raw: Result<serde_json::Value, _> =
            serde_json::from_str("<html><body>gateway</body></html>");
        assert_eq!(
            raw.unwrap_err().to_string(),
            "expected value at line 1 column 1"
        );
    }

    #[test]
    fn command_success_with_opaque_body_stays_quiet() {
        // The screenshot toast: a transport press answers 200 with a
        // non-JSON body. Commands must treat any 2xx as worked.
        assert_eq!(
            decide(&Method::PUT, StatusCode::OK, None, "QH5I6kkdObcuRF50pH4EJULmB0").unwrap(),
            serde_json::json!({"empty": true})
        );
        assert_eq!(
            decide(&Method::POST, StatusCode::OK, None, "QH5I6kkdObcuRF50pH4EJULmB0").unwrap(),
            serde_json::json!({"empty": true})
        );
    }

    #[test]
    fn query_success_with_opaque_body_still_errors() {
        // Queries stay strict: a corrupt player/queue payload must error,
        // never silently wipe on-screen state to empty.
        let err = decide(&Method::GET, StatusCode::OK, None, "QH5I6kkdObcuRF50pH4EJULmB0")
            .unwrap_err();
        assert!(err.contains("not JSON"), "unfriendly: {err}");
    }

    #[test]
    fn command_failure_still_errors() {
        // Non-2xx stays an error for commands too.
        let err = decide(&Method::PUT, StatusCode::FORBIDDEN, None, "nope").unwrap_err();
        assert!(err.contains("403"), "status lost: {err}");
    }

    #[test]
    fn probe_valid_json_still_parses() {
        // Rules out C2 (valid-JSON mishandling): a JSON body on 200
        // must keep parsing, before and after the fix.
        let v = decide(&Method::GET, StatusCode::OK, None, r#"{"snapshot_id":"abc"}"#).unwrap();
        assert_eq!(v, serde_json::json!({"snapshot_id": "abc"}));
    }

    #[test]
    fn html_body_on_success_does_not_leak_serde_error() {
        let err =
            decide(&Method::GET, StatusCode::OK, None, "<html><body>gateway</body></html>")
                .unwrap_err();
        assert!(
            !err.contains("line 1 column 1"),
            "raw serde error leaked: {err}"
        );
        assert!(err.contains("not JSON"), "unfriendly: {err}");
    }

    #[test]
    fn forbidden_names_missing_scope() {
        let body =
            r#"{"error":{"status":403,"message":"Insufficient client scope: user-top-read"}}"#;
        let err = decide(&Method::GET, StatusCode::FORBIDDEN, None, body).unwrap_err();
        assert!(err.contains("user-top-read"), "scope lost: {err}");
        assert!(err.contains("login again"), "no action: {err}");
    }

    #[test]
    fn other_errors_keep_status_and_snippet() {
        let err =
            decide(&Method::GET, StatusCode::BAD_GATEWAY, None, "<html>bad gateway</html>")
                .unwrap_err();
        assert!(err.contains("502"), "status lost: {err}");
    }

    #[test]
    fn empty_success_stays_empty() {
        assert_eq!(
            decide(&Method::GET, StatusCode::OK, None, "  ").unwrap(),
            serde_json::json!({"empty": true})
        );
    }

    #[test]
    fn rate_limit_uses_header() {
        assert_eq!(
            decide(&Method::GET, StatusCode::TOO_MANY_REQUESTS, Some("7"), "").unwrap_err(),
            "rate-limited: retry after 7s"
        );
    }

    #[test]
    fn quota_exceeded_is_distinct_from_rate_limit() {
        let body = r#"{"error":{"status":429,"message":"QUOTA_EXCEEDED"}}"#;
        let err =
            decide(&Method::GET, StatusCode::TOO_MANY_REQUESTS, Some("30"), body).unwrap_err();
        assert!(err.contains("quota-exceeded"), "quota lost: {err}");
        assert!(err.contains("30s"), "backoff lost: {err}");
    }

    #[test]
    fn retry_after_defaults_are_safe() {
        assert_eq!(
            parse_retry_after(None, false),
            std::time::Duration::from_millis(1000)
        );
        assert_eq!(
            parse_retry_after(Some("0"), false),
            std::time::Duration::from_millis(1000)
        );
        assert_eq!(
            parse_retry_after(None, true),
            std::time::Duration::from_secs(30)
        );
        assert_eq!(
            parse_retry_after(Some("7"), false),
            std::time::Duration::from_secs(7)
        );
    }

    #[test]
    fn result_classes_cover_plan_buckets() {
        assert_eq!(
            classify_result(StatusCode::OK, "{}"),
            "ok"
        );
        assert_eq!(
            classify_result(StatusCode::TOO_MANY_REQUESTS, "{}"),
            "429-rate"
        );
        assert_eq!(
            classify_result(StatusCode::TOO_MANY_REQUESTS, "QUOTA_EXCEEDED"),
            "429-quota"
        );
        assert_eq!(
            classify_result(StatusCode::UNAUTHORIZED, ""),
            "401"
        );
        assert_eq!(
            classify_result(StatusCode::BAD_GATEWAY, "x"),
            "other"
        );
    }

    #[test]
    fn player_and_search_bypass_the_cache() {
        assert!(cache_ttl("/me/player").is_none());
        assert!(cache_ttl("/search").is_none());
        assert!(cache_ttl("/playlists/abc").is_some());
        assert!(cache_ttl("/me/tracks").is_some());
    }

    #[test]
    fn inflight_key_separates_offsets() {
        let a = inflight_key(&Method::GET, "/playlists/x/items", &[("limit", "50"), ("offset", "0")]);
        let b = inflight_key(&Method::GET, "/playlists/x/items", &[("limit", "50"), ("offset", "50")]);
        assert_ne!(a, b);
    }
}
