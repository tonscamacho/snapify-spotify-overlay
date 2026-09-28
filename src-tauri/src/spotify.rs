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
    retry_after: Option<u64>,
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
    retry_after: Option<u64>,
) {
    if let Ok(mut log) = request_log().lock() {
        if log.len() >= REQUEST_LOG_CAP {
            log.pop_front();
        }
        log.push_back(RequestEntry {
            method: method.to_string(),
            path: path.to_string(),
            result,
            retry_after,
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

/// Split read/write gates (Track B): player/queue/library reads take the
/// read permit while transport writes take the write permit, so a slow
/// library page never parks a play/pause/next/previous press behind it
/// (and a slow write never stalls a poll). Token refresh and the 429
/// cooldown still serialize through shared state in `call_inner`, so this
/// only removes head-of-line blocking, never coherence. No command
/// signature changes: the two-side `invoke` contract is untouched.
fn spotify_read_gate() -> &'static tokio::sync::Semaphore {
    static READ_GATE: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    READ_GATE.get_or_init(|| tokio::sync::Semaphore::new(1))
}

fn spotify_write_gate() -> &'static tokio::sync::Semaphore {
    static WRITE_GATE: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    WRITE_GATE.get_or_init(|| tokio::sync::Semaphore::new(1))
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

/// Typed numeric parse of the `Retry-After` header. Returns the raw
/// seconds when the header is a plain integer, otherwise None. The
/// cooldown fallback policy lives in [`parse_retry_after`]; this helper is
/// the typed value surfaced through `request_log_recent` and the
/// `rate-limited` / `quota-exceeded` error strings so the frontend can
/// route on a number instead of string-matching.
fn retry_after_secs(raw: Option<&str>) -> Option<u64> {
    raw.and_then(|s| s.trim().parse::<u64>().ok())
}

fn parse_retry_after(raw: Option<&str>, is_quota: bool) -> Duration {
    let secs: u64 = retry_after_secs(raw).unwrap_or(0);
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
    // Recently-played is a stable shelf, not live transport state: cache it
    // 60 s even though it lives under the uncached /me/player prefix.
    if path.starts_with("/me/player/recently-played") {
        return Some(Duration::from_secs(60));
    }
    if path.starts_with("/me/player") || path.starts_with("/search") {
        return None;
    }
    if path.contains("/contains") {
        return None;
    }
    if path == "/me" {
        return Some(Duration::from_secs(60));
    }
    // Top tracks/artists change slowly; keep them 60 s while the rest of
    // the library shelves stay at 30 s.
    if path.starts_with("/me/top") {
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
            // Reads and writes serialize on separate permits: transport
            // takes the fast lane past a parked library read, and polls
            // never wait behind a slow write. GET is the read set; every
            // PUT/POST/DELETE is a write.
            let gate = if method == Method::GET {
                spotify_read_gate()
            } else {
                spotify_write_gate()
            };
            let _permit = gate.acquire().await.map_err(|e| e.to_string())?;
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
                retry_after_secs(retry_raw.as_deref()),
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
        retry_after_secs(retry_after.as_deref()),
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
    // Feb 2026: Get Followed Artists only supports type=artist. Other kinds
    // follow via PUT /me/library, so force artist here instead of sending
    // an invalid type that Spotify rejects.
    let _ = kind;
    let ls = limit.clamp(1, 50).to_string();
    let mut q = vec![("type", "artist"), ("limit", ls.as_str())];
    if let Some(a) = &after {
        q.push(("after", a.as_str()));
    }
    call(&app, Method::GET, "/me/following", &q, None).await
}

fn library_uris_arg(uris: &[String]) -> Result<String, String> {
    if uris.is_empty() {
        return Err("no uris to check".into());
    }
    if uris.len() > 40 {
        return Err("at most 40 uris per library call".into());
    }
    for u in uris {
        let parts: Vec<&str> = u.split(':').collect();
        if parts.len() != 3 || parts[0] != "spotify" || parts[1].is_empty() || parts[2].is_empty() {
            return Err(format!("not a Spotify URI: {u}"));
        }
    }
    Ok(uris.join(","))
}

#[tauri::command]
pub async fn library_contains(
    app: AppHandle,
    uris: Vec<String>,
) -> Result<serde_json::Value, String> {
    // Feb 2026 generic check: GET /me/library/contains?uris=... (max 40).
    // Replaces the removed per-type /me/{tracks,albums,...}/contains?ids=.
    let joined = library_uris_arg(&uris)?;
    let q = [("uris", joined.as_str())];
    match call(&app, Method::GET, "/me/library/contains", &q, None).await {
        Ok(v) => {
            let flags = v
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|x| x.as_bool().unwrap_or(false))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if flags.len() == uris.len() {
                Ok(serde_json::Value::Array(
                    flags.into_iter().map(serde_json::Value::Bool).collect(),
                ))
            } else {
                Err("spotify contains: short batch response".into())
            }
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn library_save(app: AppHandle, uris: Vec<String>) -> Result<serde_json::Value, String> {
    // Feb 2026 generic save: PUT /me/library?uris=... Accepts track, album,
    // episode, show, audiobook, artist, user, and playlist URIs in one call.
    // Never save liked content locally; the server is the source of truth.
    let joined = library_uris_arg(&uris)?;
    let q = [("uris", joined.as_str())];
    call(&app, Method::PUT, "/me/library", &q, None).await
}

#[tauri::command]
pub async fn library_remove(
    app: AppHandle,
    uris: Vec<String>,
) -> Result<serde_json::Value, String> {
    // Feb 2026 generic remove: DELETE /me/library?uris=...
    let joined = library_uris_arg(&uris)?;
    let q = [("uris", joined.as_str())];
    call(&app, Method::DELETE, "/me/library", &q, None).await
}

#[tauri::command]
pub async fn follow_put(app: AppHandle, uris: Vec<String>) -> Result<serde_json::Value, String> {
    // Feb 2026: follow/unfollow ride the generic library endpoints.
    // Artist, user, and playlist follows all save via PUT /me/library.
    let joined = library_uris_arg(&uris)?;
    let q = [("uris", joined.as_str())];
    call(&app, Method::PUT, "/me/library", &q, None).await
}

#[tauri::command]
pub async fn follow_delete(app: AppHandle, uris: Vec<String>) -> Result<serde_json::Value, String> {
    let joined = library_uris_arg(&uris)?;
    let q = [("uris", joined.as_str())];
    call(&app, Method::DELETE, "/me/library", &q, None).await
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

/// Friend/public playlist alternate source: the public Spotify embed page.
///
/// GO-gate (PR2-G, user-authorized 2026-09-27): third source attempted only
/// after BOTH official reads 403 (`/items`, then legacy `/tracks`). The
/// embed page server-renders up to 50 tracks in
/// `__NEXT_DATA__ → props.pageProps.state.data.entity.trackList`
/// (prototype 2026-09-27; raw capture retained outside the repo).
///
/// Rails (each has a unit test in the `tests` module below):
/// - Kill-switch: [`embed_fallback_enabled`] — env `SNAPIFY_EMBED_FALLBACK`,
///   default ON; `"0"`/`"false"`/`"off"`/`"no"` disables. One-line OFF
///   restores the exact old wall (no embed fetch, no shape change).
/// - Rate-limit: defensive client-side throttle ([`EMBED_MIN_INTERVAL`])
///   between embed fetches; single-shot, never retried, never on 401/429.
/// - 50-track cap: hard cap ([`EMBED_TRACK_CAP`]) with an explicit
///   `truncated: true` in the payload; no pagination illusion.
/// - Cache: separate `embed:`-namespaced entries with their own TTL
///   ([`EMBED_CACHE_TTL`]); embed rows NEVER share keys with official-API
///   entries, so neither direction can poison the other.
/// - Retry only-on-403: [`embed_retry_gate`] admits the attempt only when
///   both official errors are 403s. 401/429/5xx surface at once.
/// - Shape: [`embed_items_payload`] returns the existing `{items, total}`
///   contract (`parsePlaylistItems` untouched); the extra `truncated` bool
///   is additive metadata the UI reads for its cap note.
/// - Fallback: [`try_embed_fallback`] returns `None` on ANY failure (flag
///   off, bad id, network error, timeout, parse fail, shape drift, empty
///   list) and the caller returns the original 403, so the existing wall +
///   Play + Retry + Open-in-Spotify is preserved.
/// - Privacy: the embed fetch sends NO bearer token (public page, browser
///   UA); the Spotify access token never leaves api.spotify.com.
/// - Personalized mixes (Sad/Chill etc.): same path; their embed pages
///   demand personalization, so fetch/parse fails → wall, never a panic or
///   a spinner-forever (all untrusted parsing is panic-free and the fetch
///   is bounded by [`EMBED_TIMEOUT`]).
const EMBED_TRACK_CAP: usize = 50;
const EMBED_CACHE_TTL: Duration = Duration::from_secs(300);
const EMBED_MIN_INTERVAL: Duration = Duration::from_millis(1500);
const EMBED_TIMEOUT: Duration = Duration::from_secs(10);
const EMBED_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// Pure mapping for the kill-switch so tests never mutate process env:
/// unset → ON; explicit off-words → OFF; anything else → ON.
fn embed_flag_from_env(raw: Option<&str>) -> bool {
    match raw {
        None => true,
        Some(s) => {
            let v = s.trim().to_ascii_lowercase();
            !(v == "0" || v == "false" || v == "off" || v == "no")
        }
    }
}

/// Kill-switch: `SNAPIFY_EMBED_FALLBACK=0` (or false/off/no) disables the
/// alternate source and restores the exact old wall. Default ON.
fn embed_fallback_enabled() -> bool {
    embed_flag_from_env(std::env::var("SNAPIFY_EMBED_FALLBACK").ok().as_deref())
}

/// Separate cache namespace: embed entries live under `embed:` keys so they
/// can never overwrite (or be read as) official-API entries.
fn embed_cache_key(playlist_id: &str) -> String {
    format!("embed:/playlists/{playlist_id}/items")
}

/// Guard the embed URL against path injection. Real playlist ids are
/// base62; anything else skips the alternate source and keeps the wall.
fn embed_playlist_id_valid(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Admits the third source only after a double-403 (both official reads
/// refused). 401/429/5xx on either leg keep surfacing at once — the retry
/// discipline stays only-on-403, and the flag gates everything.
fn embed_double_403(primary_err: &str, fallback_err: &str) -> bool {
    playlist_items_should_retry(primary_err) && playlist_items_should_retry(fallback_err)
}

fn embed_retry_gate(primary_err: &str, fallback_err: &str) -> bool {
    embed_fallback_enabled() && embed_double_403(primary_err, fallback_err)
}

/// Pure throttle math: how long to wait before the next embed fetch given
/// the last one. The async wrapper below sleeps this duration.
fn embed_wait_for(
    last: Option<tokio::time::Instant>,
    now: tokio::time::Instant,
) -> Duration {
    match last {
        Some(t) => {
            let earliest = t + EMBED_MIN_INTERVAL;
            if earliest > now {
                earliest - now
            } else {
                Duration::from_secs(0)
            }
        }
        None => Duration::from_secs(0),
    }
}

fn embed_last_fetch() -> &'static tokio::sync::Mutex<Option<tokio::time::Instant>> {
    static LAST: OnceLock<tokio::sync::Mutex<Option<tokio::time::Instant>>> =
        OnceLock::new();
    LAST.get_or_init(|| tokio::sync::Mutex::new(None))
}

/// Defensive throttle: at most one embed fetch per [`EMBED_MIN_INTERVAL`].
/// Burst paging (two offsets at once) serializes here instead of hammering
/// the undocumented page.
async fn enforce_embed_throttle() {
    let wait = {
        let last = embed_last_fetch().lock().await;
        embed_wait_for(*last, tokio::time::Instant::now())
    };
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
    *embed_last_fetch().lock().await = Some(tokio::time::Instant::now());
}

#[derive(Clone, Debug, PartialEq)]
struct EmbedTrack {
    name: String,
    artists: String,
    duration_ms: i64,
    uri: String,
}

#[derive(Clone, Debug, PartialEq)]
enum EmbedParseError {
    MissingData,
    BadShape,
}

impl std::fmt::Display for EmbedParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "embed fallback unavailable")
    }
}

/// Defensive `__NEXT_DATA__.entity.trackList` parse. Missing block, bad
/// JSON, moved fields, or zero usable tracks are all `Err` (→ wall), never
/// a panic and never partial rows. Entries without a track URI are skipped;
/// the list is hard-capped at [`EMBED_TRACK_CAP`] with a truncation flag.
fn parse_embed_track_list(html: &str) -> Result<(Vec<EmbedTrack>, bool), EmbedParseError> {
    const OPEN: &str = "<script id=\"__NEXT_DATA__\" type=\"application/json\">";
    const CLOSE: &str = "</script>";
    let start = html.find(OPEN).ok_or(EmbedParseError::MissingData)? + OPEN.len();
    let rest = html.get(start..).ok_or(EmbedParseError::MissingData)?;
    let end = rest.find(CLOSE).ok_or(EmbedParseError::MissingData)?;
    let raw = rest.get(..end).ok_or(EmbedParseError::MissingData)?;
    let doc: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| EmbedParseError::BadShape)?;
    let list = doc
        .pointer("/props/pageProps/state/data/entity/trackList")
        .and_then(|v| v.as_array())
        .ok_or(EmbedParseError::BadShape)?;
    let mut tracks = Vec::new();
    for entry in list {
        let obj = match entry.as_object() {
            Some(o) => o,
            None => continue,
        };
        let uri = match obj.get("uri").and_then(|u| u.as_str()) {
            Some(u)
                if u.starts_with("spotify:track:") && u.len() > "spotify:track:".len() =>
            {
                u.to_string()
            }
            _ => continue,
        };
        let name = obj
            .get("title")
            .and_then(|t| t.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("Unknown")
            .to_string();
        let artists = obj
            .get("subtitle")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        let duration_ms = obj
            .get("duration")
            .and_then(|d| d.as_i64())
            .unwrap_or(0)
            .max(0);
        tracks.push(EmbedTrack {
            name,
            artists,
            duration_ms,
            uri,
        });
    }
    if tracks.is_empty() {
        return Err(EmbedParseError::MissingData);
    }
    let truncated = tracks.len() > EMBED_TRACK_CAP;
    tracks.truncate(EMBED_TRACK_CAP);
    Ok((tracks, truncated))
}

/// Existing `{items, total}` contract in the official `/items` wrapper
/// shape (`{"track": {...}}`), so `parsePlaylistItems` is untouched. The
/// additive `truncated` bool drives the UI's 50-track note.
fn embed_items_payload(tracks: &[EmbedTrack], truncated: bool) -> serde_json::Value {
    let items: Vec<serde_json::Value> = tracks
        .iter()
        .map(|t| {
            serde_json::json!({
                "track": {
                    "name": t.name,
                    "artists": [{ "name": t.artists }],
                    "duration_ms": t.duration_ms,
                    "uri": t.uri,
                }
            })
        })
        .collect();
    serde_json::json!({ "items": items, "total": items.len(), "truncated": truncated })
}

fn embed_page(
    items: &[serde_json::Value],
    offset: usize,
    limit: usize,
) -> Vec<serde_json::Value> {
    items
        .iter()
        .skip(offset)
        .take(limit.max(1))
        .cloned()
        .collect()
}

/// Serve one page out of a full (≤50) embed payload. `total` stays the full
/// length so the paged list exhausts honestly instead of looping.
fn serve_embed_page(
    full: &serde_json::Value,
    offset: usize,
    limit: usize,
) -> serde_json::Value {
    let items = full
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let total = full
        .get("total")
        .and_then(|v| v.as_u64())
        .map(|t| t as usize)
        .unwrap_or(items.len());
    let truncated = full
        .get("truncated")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    serde_json::json!({ "items": embed_page(&items, offset, limit), "total": total, "truncated": truncated })
}

async fn embed_cache_get(key: &str) -> Option<serde_json::Value> {
    response_cache().lock().await.get(key).cloned().and_then(|entry| {
        if entry.stored_at.elapsed() < entry.ttl {
            Some(entry.body)
        } else {
            None
        }
    })
}

async fn embed_cache_put(key: String, body: serde_json::Value) {
    let mut cache = response_cache().lock().await;
    if cache.len() >= CACHE_CAP {
        if let Some(oldest) = cache.keys().next().cloned() {
            cache.remove(&oldest);
        }
    }
    cache.insert(
        key,
        CacheEntry {
            body,
            etag: None,
            stored_at: tokio::time::Instant::now(),
            ttl: EMBED_CACHE_TTL,
        },
    );
}

/// Public-page fetch: NO bearer token, browser UA (the page 403s/empties
/// bot UAs). Bounded by [`EMBED_TIMEOUT`]; any failure is `Err` → wall.
async fn fetch_embed_html(playlist_id: &str) -> Result<String, String> {
    let url = format!("https://open.spotify.com/embed/playlist/{playlist_id}");
    let res = tokio::time::timeout(
        EMBED_TIMEOUT,
        shared_client()
            .get(&url)
            .header(reqwest::header::USER_AGENT, EMBED_USER_AGENT)
            .send(),
    )
    .await
    .map_err(|_| "embed fallback unavailable: fetch timed out".to_string())?
    .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!(
            "embed fallback unavailable: http {}",
            res.status()
        ));
    }
    res.text().await.map_err(|e| e.to_string())
}

/// Third source after terminal 403. `Some` only on full success; `None` on
/// ANY failure so the caller keeps the original 403 (→ existing wall).
async fn try_embed_fallback(
    playlist_id: &str,
    limit: i64,
    offset: i64,
) -> Option<serde_json::Value> {
    if !embed_fallback_enabled() {
        return None;
    }
    if !embed_playlist_id_valid(playlist_id) {
        return None;
    }
    let key = embed_cache_key(playlist_id);
    let off = offset.max(0) as usize;
    let lim = limit.clamp(1, 50) as usize;
    if let Some(cached) = embed_cache_get(&key).await {
        return Some(serve_embed_page(&cached, off, lim));
    }
    enforce_embed_throttle().await;
    let html = fetch_embed_html(playlist_id).await.ok()?;
    let (tracks, truncated) = parse_embed_track_list(&html).ok()?;
    let full = embed_items_payload(&tracks, truncated);
    embed_cache_put(key, full.clone()).await;
    Some(serve_embed_page(&full, off, lim))
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
            match paged(
                &app,
                Method::GET,
                &playlist_items_fallback(&playlist_id),
                &[],
                limit,
                offset,
            )
            .await
            {
                Ok(v) => Ok(v),
                // Third source (GO-gate): the public embed page, only after
                // a double-403 and only when the kill-switch is on. ANY
                // alternate-source failure keeps the original 403 so the
                // existing wall + Play + Retry + Open-in-Spotify survives.
                Err(e2) if embed_retry_gate(&e, &e2) => {
                    match try_embed_fallback(&playlist_id, limit, offset).await {
                        Some(v) => Ok(v),
                        None => Err(e2),
                    }
                }
                Err(e2) => Err(e2),
            }
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
    use super::{cache_ttl, classify_result, decide, embed_cache_key, embed_double_403, embed_flag_from_env, embed_items_payload, embed_playlist_id_valid, embed_retry_gate, embed_wait_for, inflight_key, library_uris_arg, parse_embed_track_list, parse_retry_after, playlist_items_fallback, playlist_items_primary, playlist_items_should_retry, retry_after_secs, serve_embed_page, EmbedParseError, EMBED_CACHE_TTL, EMBED_MIN_INTERVAL, EMBED_TRACK_CAP};
    use reqwest::{Method, StatusCode};

    #[test]
    fn library_uris_join_and_validate() {
        // Feb 2026 generic library endpoints take comma-joined Spotify URIs.
        let joined = library_uris_arg(&[
            "spotify:track:abc".to_string(),
            "spotify:album:def".to_string(),
        ])
        .unwrap();
        assert_eq!(joined, "spotify:track:abc,spotify:album:def");
        assert!(library_uris_arg(&[]).is_err());
        assert!(library_uris_arg(&["not-a-uri".to_string()]).is_err());
        assert!(library_uris_arg(&["spotify:track:".to_string()]).is_err());
    }

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
        assert!(cache_ttl("/me/player/queue").is_none());
        assert!(cache_ttl("/search").is_none());
        assert!(cache_ttl("/playlists/abc").is_some());
        assert!(cache_ttl("/me/tracks").is_some());
    }

    #[test]
    fn top_and_recently_played_cache_sixty_seconds() {
        // PR3: top + recently-played extend to 60 s; live player + search stay uncached.
        assert_eq!(
            cache_ttl("/me/top/tracks"),
            Some(std::time::Duration::from_secs(60))
        );
        assert_eq!(
            cache_ttl("/me/top/artists"),
            Some(std::time::Duration::from_secs(60))
        );
        assert_eq!(
            cache_ttl("/me/player/recently-played"),
            Some(std::time::Duration::from_secs(60))
        );
        assert!(cache_ttl("/me/player").is_none());
        assert!(cache_ttl("/search").is_none());
    }

    #[test]
    fn retry_after_secs_parses_typed_value() {
        assert_eq!(retry_after_secs(Some("7")), Some(7));
        assert_eq!(retry_after_secs(Some(" 30 ")), Some(30));
        assert_eq!(retry_after_secs(None), None);
        assert_eq!(retry_after_secs(Some("bogus")), None);
        assert_eq!(retry_after_secs(Some("")), None);
    }

    #[test]
    fn inflight_key_separates_offsets() {
        let a = inflight_key(&Method::GET, "/playlists/x/items", &[("limit", "50"), ("offset", "0")]);
        let b = inflight_key(&Method::GET, "/playlists/x/items", &[("limit", "50"), ("offset", "50")]);
        assert_ne!(a, b);
    }

    // Friend/public embed fallback (GO-gate PR2-G): kill-switch, retry gate,
    // parser, payload shape, paging, cache separation, throttle math. Every
    // failure maps to the existing wall (Err/None), never partial rows.

    fn embed_doc(track_entries: &str) -> String {
        format!(
            "<html><head></head><body><script id=\"__NEXT_DATA__\" type=\"application/json\">{{\"props\":{{\"pageProps\":{{\"state\":{{\"data\":{{\"entity\":{{\"trackList\":[{track_entries}]}}}}}}}}}}}}</script></body></html>"
        )
    }

    fn embed_entry(i: usize) -> String {
        format!(
            "{{\"uri\":\"spotify:track:{:022}\",\"title\":\"Song {i}\",\"subtitle\":\"Artist {i}\",\"duration\":180000}}",
            i
        )
    }

    #[test]
    fn embed_kill_switch_defaults_on_and_parses_off_words() {
        assert!(embed_flag_from_env(None));
        for off in ["0", "false", "off", "no", " FALSE ", "Off", "NO"] {
            assert!(!embed_flag_from_env(Some(off)), "should disable: {off}");
        }
        for on in ["1", "true", "yes", "", "anything-else"] {
            assert!(embed_flag_from_env(Some(on)), "should stay on: {on}");
        }
    }

    #[test]
    fn embed_kill_switch_env_round_trip() {
        // Single env-touching test in this binary; no other test reads this
        // var, so no cross-test race. Restores the pre-test state after.
        let prev = std::env::var("SNAPIFY_EMBED_FALLBACK").ok();
        std::env::set_var("SNAPIFY_EMBED_FALLBACK", "0");
        assert!(!embed_retry_gate("403 a", "403 b"));
        std::env::remove_var("SNAPIFY_EMBED_FALLBACK");
        assert!(embed_retry_gate("403 a", "403 b"));
        if let Some(v) = prev {
            std::env::set_var("SNAPIFY_EMBED_FALLBACK", v);
        }
    }

    #[test]
    fn embed_retry_gate_admits_only_double_403() {
        assert!(embed_double_403("spotify 403 Forbidden: x", "spotify 403 Forbidden: y"));
        // 401/429/5xx on either leg stay terminal: never a second call, let
        // alone a third source.
        assert!(!embed_double_403("unauthorized: token rejected", "spotify 403 Forbidden: y"));
        assert!(!embed_double_403("spotify 403 Forbidden: x", "rate-limited: retry after 7s"));
        assert!(!embed_double_403("rate-limited: retry after 7s", "quota-exceeded: back off"));
        assert!(!embed_double_403("spotify 502 Bad Gateway: boom", "spotify 502 Bad Gateway: boom"));
        assert!(!embed_double_403("", ""));
        // The composed gate inherits the same discipline (flag defaults ON
        // when the env var is unset, proven by the test above).
        assert!(!embed_retry_gate("unauthorized: token rejected", "spotify 403 Forbidden: y"));
        assert!(!embed_retry_gate("spotify 403 Forbidden: x", "rate-limited: retry after 7s"));
    }

    #[test]
    fn embed_ids_are_base62_guarded() {
        assert!(embed_playlist_id_valid("37i9dQZF1DXcBWIGoYBM5M"));
        assert!(!embed_playlist_id_valid(""));
        assert!(!embed_playlist_id_valid("../me"));
        assert!(!embed_playlist_id_valid("ab cd"));
        assert!(!embed_playlist_id_valid("a-b_c"));
        assert!(!embed_playlist_id_valid(&"a".repeat(65)));
    }

    #[test]
    fn embed_cache_key_never_collides_with_official_keys() {
        let key = embed_cache_key("abc123");
        assert!(key.starts_with("embed:"), "must live in its own namespace: {key}");
        let official = inflight_key(&Method::GET, "/playlists/abc123/items", &[("limit", "50"), ("offset", "0")]);
        assert_ne!(key, official);
        assert!(!official.starts_with("embed:"));
    }

    #[test]
    fn embed_cache_ttl_is_separate_from_official() {
        assert_eq!(EMBED_CACHE_TTL, std::time::Duration::from_secs(300));
        // Official playlist reads stay at 30 s; the embed namespace never
        // borrows or overwrites that entry.
        assert_eq!(
            cache_ttl("/playlists/abc123/items"),
            Some(std::time::Duration::from_secs(30))
        );
    }

    #[test]
    fn embed_throttle_math_spaces_fetches() {
        let now = tokio::time::Instant::now();
        assert_eq!(embed_wait_for(None, now), std::time::Duration::from_secs(0));
        let wait = embed_wait_for(Some(now), now);
        assert!(wait > std::time::Duration::from_secs(0));
        assert!(wait <= EMBED_MIN_INTERVAL);
        let old = now - EMBED_MIN_INTERVAL - std::time::Duration::from_secs(1);
        assert_eq!(embed_wait_for(Some(old), now), std::time::Duration::from_secs(0));
    }

    #[test]
    fn embed_track_cap_is_fifty() {
        assert_eq!(EMBED_TRACK_CAP, 50);
        assert_eq!(EMBED_MIN_INTERVAL, std::time::Duration::from_millis(1500));
    }

    #[test]
    fn embed_parser_reads_tracks_with_field_mapping() {
        let html = embed_doc(&format!("{},{}", embed_entry(1), embed_entry(2)));
        let (tracks, truncated) = parse_embed_track_list(&html).unwrap();
        assert!(!truncated);
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].name, "Song 1");
        assert_eq!(tracks[0].artists, "Artist 1");
        assert_eq!(tracks[0].duration_ms, 180000);
        assert_eq!(tracks[0].uri, "spotify:track:0000000000000000000001");
    }

    #[test]
    fn embed_parser_missing_block_is_wall() {
        assert!(matches!(
            parse_embed_track_list("<html><body>no data here</body></html>"),
            Err(EmbedParseError::MissingData)
        ));
        assert!(matches!(parse_embed_track_list(""), Err(EmbedParseError::MissingData)));
        // Unclosed script block: never slice into garbage.
        assert!(matches!(
            parse_embed_track_list("<script id=\"__NEXT_DATA__\" type=\"application/json\">{\"a\":1}"),
            Err(EmbedParseError::MissingData)
        ));
    }

    #[test]
    fn embed_parser_bad_json_and_shape_drift_are_wall() {
        let wrap = |inner: &str| {
            format!(
                "<script id=\"__NEXT_DATA__\" type=\"application/json\">{inner}</script>"
            )
        };
        assert!(matches!(
            parse_embed_track_list(&wrap("not json{{")),
            Err(EmbedParseError::BadShape)
        ));
        assert!(matches!(
            parse_embed_track_list(&wrap("{\"props\":{}}")),
            Err(EmbedParseError::BadShape)
        ));
        assert!(matches!(
            parse_embed_track_list(&wrap(
                "{\"props\":{\"pageProps\":{\"state\":{\"data\":{\"entity\":{}}}}}}"
            )),
            Err(EmbedParseError::BadShape)
        ));
        assert!(matches!(
            parse_embed_track_list(&wrap(
                "{\"props\":{\"pageProps\":{\"state\":{\"data\":{\"entity\":{\"trackList\":{}}}}}}}"
            )),
            Err(EmbedParseError::BadShape)
        ));
    }

    #[test]
    fn embed_parser_skips_unusable_entries_and_never_partials() {
        // Episode URIs, missing URIs, and non-objects are skipped; the one
        // good row still parses (mixed degradation, never invented rows).
        let html = embed_doc(
            "{\"uri\":\"spotify:episode:abc\",\"title\":\"Ep\",\"subtitle\":\"Show\"},{\"title\":\"NoUri\"},42,{\"uri\":\"spotify:track:0000000000000000000007\",\"subtitle\":\"Solo\"}",
        );
        let (tracks, truncated) = parse_embed_track_list(&html).unwrap();
        assert!(!truncated);
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].name, "Unknown");
        assert_eq!(tracks[0].artists, "Solo");
        // All-unusable (personalized mixes behave this way) is a wall, never
        // an empty success that would clear the UI to "no tracks".
        let bad = embed_doc(
            "{\"uri\":\"spotify:episode:abc\",\"title\":\"Ep\"},{\"title\":\"NoUri\"}",
        );
        assert!(matches!(
            parse_embed_track_list(&bad),
            Err(EmbedParseError::MissingData)
        ));
        let empty = embed_doc("");
        assert!(matches!(
            parse_embed_track_list(&empty),
            Err(EmbedParseError::MissingData)
        ));
        // Negative durations clamp to zero instead of leaking.
        let neg = embed_doc(
            "{\"uri\":\"spotify:track:0000000000000000000009\",\"title\":\"N\",\"subtitle\":\"A\",\"duration\":-5}",
        );
        let (tracks, _) = parse_embed_track_list(&neg).unwrap();
        assert_eq!(tracks[0].duration_ms, 0);
    }

    #[test]
    fn embed_parser_caps_at_fifty_with_truncation_flag() {
        let many: Vec<String> = (0..55).map(embed_entry).collect();
        let (tracks, truncated) = parse_embed_track_list(&embed_doc(&many.join(","))).unwrap();
        assert_eq!(tracks.len(), 50);
        assert!(truncated);
        let exact: Vec<String> = (0..50).map(embed_entry).collect();
        let (tracks, truncated) = parse_embed_track_list(&embed_doc(&exact.join(","))).unwrap();
        assert_eq!(tracks.len(), 50);
        assert!(!truncated);
    }

    #[test]
    fn embed_payload_keeps_items_total_contract() {
        let html = embed_doc(&format!("{},{}", embed_entry(1), embed_entry(2)));
        let (tracks, truncated) = parse_embed_track_list(&html).unwrap();
        let payload = embed_items_payload(&tracks, truncated);
        // parsePlaylistItems is untouched: the wrapper shape it already
        // reads ({"track": {...}}) is exactly what we emit.
        let items = payload.get("items").and_then(|v| v.as_array()).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(payload.get("total").and_then(|v| v.as_u64()), Some(2));
        assert_eq!(payload.get("truncated").and_then(|v| v.as_bool()), Some(false));
        let first = items[0].get("track").unwrap();
        assert_eq!(first.get("name").and_then(|v| v.as_str()), Some("Song 1"));
        assert_eq!(first.get("uri").and_then(|v| v.as_str()), Some("spotify:track:0000000000000000000001"));
        let capped = embed_items_payload(&tracks, true);
        assert_eq!(capped.get("truncated").and_then(|v| v.as_bool()), Some(true));
    }

    #[test]
    fn embed_paging_serves_slices_with_honest_total() {
        let many: Vec<String> = (0..3).map(embed_entry).collect();
        let html = embed_doc(&many.join(","));
        let (tracks, truncated) = parse_embed_track_list(&html).unwrap();
        let full = embed_items_payload(&tracks, truncated);
        let page = serve_embed_page(&full, 1, 2);
        let items = page.get("items").and_then(|v| v.as_array()).unwrap();
        assert_eq!(items.len(), 2);
        // Total stays the full length so the paged list exhausts honestly.
        assert_eq!(page.get("total").and_then(|v| v.as_u64()), Some(3));
        assert_eq!(page.get("truncated").and_then(|v| v.as_bool()), Some(false));
        let past_end = serve_embed_page(&full, 9, 50);
        assert!(past_end.get("items").and_then(|v| v.as_array()).unwrap().is_empty());
        assert_eq!(past_end.get("total").and_then(|v| v.as_u64()), Some(3));
    }
}
