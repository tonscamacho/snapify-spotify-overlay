use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

// Public client ID. This identifier is not a secret and ships with the app.
// The Client Secret must never ship here. Auth uses PKCE so no secret is needed.
pub const CLIENT_ID: &str = "38bf5383c2a84de1a829a91ebd140421";
// Must match the redirect URI allowlisted in the Spotify dashboard exactly.
pub const REDIRECT_URI: &str = "http://127.0.0.1:3000";
const SCOPES: &str =
    "user-read-playback-state user-read-currently-playing user-modify-playback-state playlist-read-private playlist-read-collaborative user-library-read user-top-read user-read-recently-played user-read-private user-read-email user-follow-read user-library-modify user-follow-modify playlist-modify-private playlist-modify-public streaming";
const KEYRING_SERVICE: &str = "spotify-overlay";
const KEYRING_USER: &str = "refresh-token";

/// PKCE verifier survives a restart inside its 120 s window so a mid-login
/// reboot resumes instead of dying with "Login session expired".
/// Stored as a temp-file JSON `{ verifier, created_unix }`, NOT in the OS
/// keychain: the keychain helper in this file is for the long-lived refresh
/// token, and a short-lived verifier must never linger there past its TTL.
const VERIFIER_TTL_SECS: i64 = 120;

fn verifier_path() -> std::path::PathBuf {
    std::env::temp_dir().join("snapify-pkce-verifier.json")
}

fn verifier_is_fresh(created_unix: i64) -> bool {
    now_unix() - created_unix < VERIFIER_TTL_SECS
}

/// Path-parameterized cores so tests can use a scratch file instead of the
/// shared temp-dir slot. The thin `*_verifier_disk` wrappers below are the
/// only production entry points.
fn save_verifier_at(path: &std::path::Path, verifier: &str) {
    let body = serde_json::json!({ "verifier": verifier, "created_unix": now_unix() });
    let _ = std::fs::write(path, body.to_string());
}

fn load_verifier_at(path: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let verifier = v.get("verifier")?.as_str()?.to_string();
    let created = v.get("created_unix")?.as_i64()?;
    if verifier.is_empty() || !verifier_is_fresh(created) {
        let _ = std::fs::remove_file(path);
        return None;
    }
    Some(verifier)
}

fn save_verifier_disk(verifier: &str) {
    save_verifier_at(&verifier_path(), verifier);
}

fn load_verifier_disk() -> Option<String> {
    load_verifier_at(&verifier_path())
}

fn clear_verifier_disk() {
    let _ = std::fs::remove_file(verifier_path());
}

/// Human-readable bind failure for 127.0.0.1:3000. Pure for testability:
/// AddrInUse names the likely holder (another Snapify window or the dev
/// server) plus the fix; anything else reports the raw error.
fn bind_error_message(e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::AddrInUse {
        "Port 3000 is busy — likely another Snapify Overlay instance or `npm run dev` holds 127.0.0.1:3000. Free it: quit the extra Snapify window (check the tray), stop the dev server, or run `netstat -ano | findstr :3000` and stop that PID; then login again.".to_string()
    } else {
        format!("Login listener failed on 127.0.0.1:3000 ({e}). Close what uses it and retry.")
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64,
}

#[derive(Default)]
pub struct AuthState {
    pub tokens: Mutex<Option<Tokens>>,
    pub verifier: Mutex<Option<String>>,
    pub awaiting: Mutex<bool>,
}

#[derive(Clone, serde::Serialize)]
pub struct AuthStatus {
    pub logged_in: bool,
    pub awaiting_callback: bool,
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn new_verifier() -> String {
    let mut buf = vec![0u8; 64];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

fn challenge_for(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

fn save_refresh_token(refresh: &str) {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER);
    if let Ok(entry) = entry {
        let _ = entry.set_password(refresh);
    }
}

fn load_refresh_token() -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .ok()?
        .get_password()
        .ok()
}

fn clear_refresh_token() {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        let _ = entry.delete_credential();
    }
}

fn is_invalid_grant(body: &str) -> bool {
    body.contains("invalid_grant")
}

/// Drop a dead session everywhere: memory, OS keyring, and the frontend gate.
fn kill_session(app: &AppHandle, state: &AuthState) {
    if let Ok(mut tokens) = state.tokens.lock() {
        *tokens = None;
    }
    clear_refresh_token();
    let _ = app.emit("auth-changed", false);
}

#[tauri::command]
pub async fn auth_status(state: State<'_, AuthState>) -> Result<AuthStatus, String> {
    let logged_in = state.tokens.lock().map_err(|e| e.to_string())?.is_some();
    let awaiting = state.awaiting.lock().map_err(|e| e.to_string())?.clone();
    Ok(AuthStatus {
        logged_in,
        awaiting_callback: awaiting,
    })
}

#[tauri::command]
pub async fn start_login(
    app: AppHandle,
    state: State<'_, AuthState>,
) -> Result<String, String> {
    {
        let awaiting = state.awaiting.lock().map_err(|e| e.to_string())?.clone();
        if awaiting {
            // A restart orphans the listener thread while the gate stays shut.
            // A fresh verifier means the 120 s window is still live, so keep
            // the gate; a stale one means the window is gone, so release it
            // instead of wedging login forever.
            let live = state
                .verifier
                .lock()
                .map(|g| g.is_some())
                .unwrap_or(false)
                || load_verifier_disk().is_some();
            if live {
                return Err("Login already in progress. Complete it in the browser.".into());
            }
            *state.awaiting.lock().map_err(|e| e.to_string())? = false;
            clear_verifier_disk();
        }
    }

    let verifier = new_verifier();
    let challenge = challenge_for(&verifier);
    *state.verifier.lock().map_err(|e| e.to_string())? = Some(verifier.clone());
    save_verifier_disk(&verifier);
    *state.awaiting.lock().map_err(|e| e.to_string())? = true;

    let url = format!(
        "https://accounts.spotify.com/authorize?client_id={}&response_type=code&redirect_uri={}&scope={}&code_challenge_method=S256&code_challenge={}",
        CLIENT_ID,
        url::form_urlencoded::byte_serialize(REDIRECT_URI.as_bytes()).collect::<String>(),
        url::form_urlencoded::byte_serialize(SCOPES.as_bytes()).collect::<String>(),
        challenge,
    );

    let app_clone = app.clone();
    std::thread::spawn(move || {
        wait_for_callback(app_clone);
    });

    Ok(url)
}

fn reply_page(stream: &mut std::net::TcpStream, ok: bool, message: &str) {
    let body = format!(
        "<!doctype html><html><body style=\"background:#0b0e13;color:#f2f5f9;font-family:sans-serif;display:grid;place-items:center;height:100vh\"><h2>{}</h2><p>{}</p><p>You can close this tab and return to Snapify.</p></body></html>",
        if ok { "Connected" } else { "Login failed" },
        message
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
}

fn wait_for_callback(app: AppHandle) {
    let finish = |ok: bool| {
        if let Some(state) = app.try_state::<AuthState>() {
            if let Ok(mut awaiting) = state.awaiting.lock() {
                *awaiting = false;
            }
        }
        let _ = app.emit("auth-changed", ok);
    };

    let listener = match TcpListener::bind("127.0.0.1:3000") {
        Ok(l) => l,
        Err(e) => {
            // Name the holder and the fix: the usual squatter is another
            // Snapify Overlay window or `npm run dev`, both of which bind
            // 127.0.0.1:3000 for the same callback. SO_REUSE would only hide
            // the conflict, so report it instead.
            let msg = bind_error_message(&e);
            let _ = app.emit("auth-error", msg);
            finish(false);
            return;
        }
    };
    if listener.set_nonblocking(false).is_err() {
        finish(false);
        return;
    }

    let (mut stream, _) = match listener.accept() {
        Ok(s) => s,
        Err(_) => {
            finish(false);
            return;
        }
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(120)));

    let reader_stream = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => {
            finish(false);
            return;
        }
    };
    let mut reader = BufReader::new(reader_stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        finish(false);
        return;
    }
    // Drain headers so the browser does not hang.
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                if line == "\r\n" || line == "\n" {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("/")
        .to_string();
    let full = format!("http://127.0.0.1:3000{}", path);
    let parsed = match url::Url::parse(&full) {
        Ok(u) => u,
        Err(_) => {
            reply_page(&mut stream, false, "Bad callback URL.");
            finish(false);
            return;
        }
    };

    if let Some(err) = parsed
        .query_pairs()
        .find(|(k, _)| k == "error")
        .map(|(_, v)| v.to_string())
    {
        reply_page(&mut stream, false, &format!("Spotify refused: {err}"));
        finish(false);
        return;
    }

    let code = parsed
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.to_string());
    let code = match code {
        Some(c) => c,
        None => {
            reply_page(&mut stream, false, "No code in callback.");
            finish(false);
            return;
        }
    };

    let verifier: Option<String> = match app.try_state::<AuthState>() {
        Some(s) => match s.verifier.lock() {
            Ok(g) => (*g).clone(),
            Err(_) => None,
        },
        None => None,
    }
    .or_else(|| {
        // Restart inside the 120 s window: in-memory state is gone but the
        // disk copy is still fresh. Repopulate memory so a retry works.
        let v = load_verifier_disk()?;
        if let Some(s) = app.try_state::<AuthState>() {
            if let Ok(mut g) = s.verifier.lock() {
                *g = Some(v.clone());
            }
        }
        Some(v)
    });

    let verifier = match verifier {
        Some(v) => v,
        None => {
            reply_page(&mut stream, false, "Login session expired. Start again.");
            finish(false);
            return;
        }
    };

    let token = tauri::async_runtime::block_on(exchange_code(&code, &verifier));
    match token {
        Ok(t) => {
            if let Some(state) = app.try_state::<AuthState>() {
                if let Ok(mut tokens) = state.tokens.lock() {
                    *tokens = Some(t.clone());
                }
                if let Ok(mut v) = state.verifier.lock() {
                    *v = None;
                }
                clear_verifier_disk();
            }
            if let Some(refresh) = t.refresh_token.clone() {
                save_refresh_token(&refresh);
            }
            reply_page(&mut stream, true, "Spotify is connected.");
            finish(true);
        }
        Err(e) => {
            reply_page(&mut stream, false, &format!("Token exchange failed: {e}"));
            finish(false);
        }
    }
}

async fn exchange_code(code: &str, verifier: &str) -> Result<Tokens, String> {
    let client = reqwest::Client::new();
    let params = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", REDIRECT_URI),
        ("client_id", CLIENT_ID),
        ("code_verifier", verifier),
    ];
    let res = client
        .post("https://accounts.spotify.com/api/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("token endpoint: {body}"));
    }
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(Tokens {
        access_token: body
            .get("access_token")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        refresh_token: body
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        expires_at: now_unix() + body.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(3600),
    })
}

async fn refresh_tokens(refresh: &str) -> Result<Tokens, String> {
    let client = reqwest::Client::new();
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh),
        ("client_id", CLIENT_ID),
    ];
    let res = client
        .post("https://accounts.spotify.com/api/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("refresh failed: {body}"));
    }
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let new_refresh = body
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| refresh.to_string());
    save_refresh_token(&new_refresh);
    Ok(Tokens {
        access_token: body
            .get("access_token")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        refresh_token: Some(new_refresh),
        expires_at: now_unix() + body.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(3600),
    })
}

fn refresh_gate() -> &'static tokio::sync::Mutex<()> {
    static GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn refresh_fail_until() -> &'static Mutex<Option<Instant>> {
    static STATE: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

fn refresh_cooling_down() -> bool {
    refresh_fail_until()
        .lock()
        .ok()
        .and_then(|g| *g)
        .is_some_and(|until| Instant::now() < until)
}

fn mark_refresh_failed() {
    if let Ok(mut g) = refresh_fail_until().lock() {
        *g = Some(Instant::now() + Duration::from_secs(10));
    }
}

fn clear_refresh_failed() {
    if let Ok(mut g) = refresh_fail_until().lock() {
        *g = None;
    }
}

fn cached_token_if_fresh(state: &State<AuthState>) -> Option<String> {
    let tokens = state.tokens.lock().ok()?;
    let t = tokens.clone()?;
    if t.expires_at - 60 > now_unix() && !t.access_token.is_empty() {
        Some(t.access_token)
    } else {
        None
    }
}

/// Force a refresh with the stored credential (used at boot and on 401).
/// Self-heals a revoked or rotated refresh token by clearing the dead
/// session so the login gate reopens instead of retrying forever.
pub async fn refresh_now(app: &AppHandle) -> Result<String, String> {
    if refresh_cooling_down() {
        return Err("refresh cooling down after recent failure".into());
    }
    let state = app.try_state::<AuthState>().ok_or("auth state missing")?;
    let _guard = refresh_gate().lock().await;
    if let Some(token) = cached_token_if_fresh(&state) {
        return Ok(token);
    }
    let refresh = {
        let tokens = state.tokens.lock().map_err(|e| e.to_string())?;
        tokens.clone().and_then(|t| t.refresh_token.clone())
    }
    .or_else(load_refresh_token)
    .ok_or("Not logged in. Start login first.")?;
    match refresh_tokens(&refresh).await {
        Ok(fresh) => {
            let token = fresh.access_token.clone();
            if let Ok(mut tokens) = state.tokens.lock() {
                *tokens = Some(fresh);
            }
            clear_refresh_failed();
            let _ = app.emit("auth-changed", true);
            Ok(token)
        }
        Err(e) => {
            if is_invalid_grant(&e) {
                kill_session(app, &state);
                return Err("Session expired. Please login again.".into());
            }
            mark_refresh_failed();
            Err(e)
        }
    }
}

/// Returns a valid access token, refreshing silently when expired.
pub async fn access_token(app: &AppHandle) -> Result<String, String> {
    let state = app
        .try_state::<AuthState>()
        .ok_or("auth state missing")?;

    let needs_refresh = {
        let tokens = state.tokens.lock().map_err(|e| e.to_string())?;
        match tokens.clone() {
            Some(t) => t.expires_at - 60 <= now_unix() || t.access_token.is_empty(),
            None => true,
        }
    };

    if needs_refresh {
        return refresh_now(app).await;
    }

    let tokens = state.tokens.lock().map_err(|e| e.to_string())?;
    tokens
        .clone()
        .map(|t| t.access_token)
        .ok_or_else(|| "Not logged in. Start login first.".to_string())
}

/// Best-effort restore of a saved session at startup. A fresh disk verifier
/// (login started <120 s ago) re-arms the callback listener so a mid-login
/// restart resumes; a stale one is already deleted by the loader, and the
/// next callback fails clean with "Login session expired. Start again."
pub fn restore_session(app: &AppHandle) {
    if let Some(refresh) = load_refresh_token() {
        if let Some(state) = app.try_state::<AuthState>() {
            if let Ok(mut tokens) = state.tokens.lock() {
                *tokens = Some(Tokens {
                    access_token: String::new(),
                    refresh_token: Some(refresh),
                    expires_at: 0,
                });
            }
        }
    }
    if let Some(v) = load_verifier_disk() {
        if let Some(state) = app.try_state::<AuthState>() {
            if let Ok(mut guard) = state.verifier.lock() {
                if guard.is_none() {
                    *guard = Some(v);
                }
            }
            if let Ok(mut awaiting) = state.awaiting.lock() {
                *awaiting = true;
            }
        }
        let app_clone = app.clone();
        std::thread::spawn(move || {
            wait_for_callback(app_clone);
        });
    }
}

/// Fresh OAuth token for the Web Playback SDK. Reuses `access_token`
/// refresh logic (refresh if `expires_at-60 <= now`), max 60 min lifetime.
/// Union scopes mean one login grants everything, but refresh never widens
/// granted scopes: installs predating a scope addition re-login once via
/// the Reconnect prompt (see the sdk-error listener in App.tsx).
#[tauri::command]
pub async fn get_fresh_token(app: AppHandle) -> Result<String, String> {
    access_token(&app).await
}

#[tauri::command]
pub async fn logout(app: AppHandle, state: State<'_, AuthState>) -> Result<(), String> {
    *state.tokens.lock().map_err(|e| e.to_string())? = None;
    *state.verifier.lock().map_err(|e| e.to_string())? = None;
    *state.awaiting.lock().map_err(|e| e.to_string())? = false;
    clear_refresh_token();
    // A logout must also drop a pending PKCE verifier: it is single-use and
    // bound to the abandoned login, so leaving it on disk would let the next
    // callback attempt a stale exchange instead of failing clean.
    clear_verifier_disk();
    let _ = app.emit("auth-changed", false);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        bind_error_message, load_verifier_at, save_verifier_at, verifier_is_fresh,
        VERIFIER_TTL_SECS, SCOPES,
    };
    use std::sync::atomic::{AtomicU64, Ordering};

    static SCRATCH_SEQ: AtomicU64 = AtomicU64::new(0);

    fn scratch_path() -> std::path::PathBuf {
        let n = SCRATCH_SEQ.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "snapify-pkce-verifier-test-{}-{n}.json",
            std::process::id()
        ))
    }

    #[test]
    fn scopes_cover_sdk_playback() {
        // The Web Playback SDK rejects tokens without `streaming`
        // (authentication_error "Invalid token scopes"). A missing scope
        // here toasts on every built-in playback attempt with recovery
        // only via re-login, so pin it.
        let scopes: Vec<&str> = SCOPES.split_whitespace().collect();
        assert!(
            scopes.contains(&"streaming"),
            "SCOPES lacks streaming: {SCOPES}"
        );
    }

    #[test]
    fn verifier_fresh_inside_ttl_stale_outside() {
        let now = super::now_unix();
        assert!(verifier_is_fresh(now));
        assert!(verifier_is_fresh(now - 10));
        assert!(verifier_is_fresh(now - (VERIFIER_TTL_SECS - 1)));
        // Boundary is exclusive: exactly TTL old is already stale.
        assert!(!verifier_is_fresh(now - VERIFIER_TTL_SECS));
        assert!(!verifier_is_fresh(now - (VERIFIER_TTL_SECS + 60)));
        // Future timestamps (clock skew) count as fresh, never stale-panic.
        assert!(verifier_is_fresh(now + 30));
    }

    #[test]
    fn verifier_disk_fresh_loads_stale_rejects_and_cleans() {
        let path = scratch_path();
        let _ = std::fs::remove_file(&path);

        // Fresh save round-trips.
        save_verifier_at(&path, "verifier-abc");
        assert_eq!(load_verifier_at(&path), Some("verifier-abc".to_string()));
        assert!(path.exists());

        // Stale file rejects AND deletes itself so the next callback fails
        // clean with "Login session expired" instead of retrying a dead code.
        let stale_body = serde_json::json!({
            "verifier": "verifier-old",
            "created_unix": super::now_unix() - (VERIFIER_TTL_SECS + 30),
        });
        std::fs::write(&path, stale_body.to_string()).expect("write stale fixture");
        assert_eq!(load_verifier_at(&path), None);
        assert!(!path.exists(), "stale verifier file must be removed on load");

        // Corrupt JSON rejects without panicking.
        std::fs::write(&path, "{not json").expect("write corrupt fixture");
        assert_eq!(load_verifier_at(&path), None);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn busy_port_error_names_holder_and_fix() {
        let in_use = std::io::Error::new(std::io::ErrorKind::AddrInUse, "address in use");
        let msg = bind_error_message(&in_use);
        assert!(msg.contains("Port 3000"), "must name the port: {msg}");
        assert!(
            msg.contains("127.0.0.1:3000"),
            "must name the bound address: {msg}"
        );
        assert!(
            msg.contains("npm run dev") || msg.contains("Snapify"),
            "must name the likely holder: {msg}"
        );
        assert!(
            msg.contains("netstat") || msg.contains("Free it"),
            "must tell how to free it: {msg}"
        );

        let other = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let msg2 = bind_error_message(&other);
        assert!(msg2.contains("127.0.0.1:3000"), "other errors keep the address: {msg2}");
        assert!(!msg2.contains("netstat"), "other errors must not claim AddrInUse: {msg2}");
    }
}
