use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::overlay::{atomic_write_json, read_json_guarded};

/// Minimum listened milliseconds that counts as a stream. Mirrors
/// `HISTORY_MIN_MS` in `src/lib/history.ts`; the two must agree.
pub const HISTORY_MIN_MS: i64 = 30000;

/// History store schema version. Only v1 loads; anything else falls
/// back to an empty store. Mirrors `HISTORY_STORE_VERSION`.
pub const HISTORY_STORE_VERSION: u8 = 1;

const HISTORY_FILE: &str = "history-store.json";

fn unknown_name() -> String {
    "Unknown".to_string()
}

fn api_source() -> String {
    "api".to_string()
}

/// One countable listen. Field names are camelCase to match the
/// TypeScript `HistoryPlay` the frontend already renders.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPlay {
    #[serde(default)]
    pub track_id: String,
    #[serde(default = "unknown_name")]
    pub track_name: String,
    #[serde(default)]
    pub artists: String,
    #[serde(default)]
    pub played_at: i64,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub uri: String,
    #[serde(default)]
    pub duration_ms: i64,
    #[serde(default)]
    pub ms_played: i64,
    #[serde(default)]
    pub skipped: bool,
    #[serde(default = "api_source")]
    pub source: String,
}

/// Versioned local store at `app_local_data_dir()/history-store.json`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStore {
    pub version: u8,
    #[serde(default)]
    pub plays: Vec<HistoryPlay>,
    #[serde(default)]
    pub imported_ranges: Vec<String>,
}

impl Default for HistoryStore {
    fn default() -> Self {
        Self {
            version: HISTORY_STORE_VERSION,
            plays: Vec::new(),
            imported_ranges: Vec::new(),
        }
    }
}

/// Per-file import tallies. Mirrors `ImportCounts` in
/// `src/lib/history.ts`; every dropped row lands in exactly one bucket.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCounts {
    pub total: usize,
    pub kept: usize,
    pub dropped_short: usize,
    pub dropped_skipped: usize,
    pub dropped_no_uri: usize,
    pub dropped_duplicate: usize,
    pub dropped_invalid: usize,
}

/// Why `append_listen` kept or refused a single listen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppendReason {
    Appended,
    Duplicate,
    Short,
    Skipped,
    NoUri,
    Future,
    Invalid,
}

impl AppendReason {
    pub fn as_str(self) -> &'static str {
        match self {
            AppendReason::Appended => "appended",
            AppendReason::Duplicate => "duplicate",
            AppendReason::Short => "short",
            AppendReason::Skipped => "skipped",
            AppendReason::NoUri => "no-uri",
            AppendReason::Future => "future",
            AppendReason::Invalid => "invalid",
        }
    }
}

/// Trimmed string field, trying each key in order. Missing or
/// non-string values read as empty; the caller decides whether empty
/// is a fallback (names) or a refusal (uris).
fn opt_str(v: &Value, keys: &[&str]) -> String {
    for k in keys {
        if let Some(s) = v.get(*k).and_then(Value::as_str) {
            let t = s.trim();
            if !t.is_empty() {
                return t.to_string();
            }
        }
    }
    String::new()
}

/// Listened milliseconds: `ms_played`, then `msPlayed`, then
/// `durationMs`. Accepts integers and floats; negatives fail.
fn ms_field(v: &Value) -> Option<i64> {
    let n = v
        .get("ms_played")
        .or_else(|| v.get("msPlayed"))
        .or_else(|| v.get("durationMs"))?;
    if let Some(m) = n.as_i64() {
        return if m >= 0 { Some(m) } else { None };
    }
    n.as_f64()
        .filter(|f| f.is_finite() && *f >= 0.0)
        .map(|f| f as i64)
}

/// Export timestamp in epoch millis. Accepts numbers (`playedAt`,
/// `played_at`) and strings: all-digit strings read as millis,
/// otherwise ISO 8601 (`ts`). Returns None when nothing parses.
fn parse_ts_millis(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => {
            if let Some(m) = n.as_i64() {
                if m > 0 {
                    return Some(m);
                }
            }
            n.as_f64().map(|f| f as i64).filter(|m| *m > 0)
        }
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                return None;
            }
            if t.bytes().all(|b| b.is_ascii_digit()) {
                return t.parse::<i64>().ok().filter(|m| *m > 0);
            }
            parse_iso_millis(t)
        }
        _ => None,
    }
}

/// ISO 8601 to epoch millis. Accepts `Z`, explicit offsets, and the
/// space-separated endsong variant (read as UTC). Anything else fails.
fn parse_iso_millis(raw: &str) -> Option<i64> {
    let s = raw.trim().replace(' ', "T");
    let after_t = s.split('T').nth(1).unwrap_or("");
    let has_zone = s.ends_with('Z')
        || s.ends_with('z')
        || after_t.contains('+')
        || after_t.contains('-');
    let norm = if has_zone { s } else { format!("{s}Z") };
    chrono::DateTime::parse_from_rfc3339(&norm)
        .ok()
        .map(|d| d.timestamp_millis())
        .filter(|m| *m > 0)
}

/// Track id from a `spotify:track:<id>` uri, else the raw uri.
fn id_from_uri(uri: &str) -> String {
    uri.rsplit(':')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(uri)
        .to_string()
}

enum RowOutcome {
    Invalid,
    NoUri,
    Short,
    Skipped,
    Keep(HistoryPlay),
}

/// Allowlist one raw export entry into a bucket. Accepts endsong rows
/// and Streaming_History_Audio minimal rows; unknown fields are
/// ignored. Future stamps count as invalid (clock skew).
fn classify_row(v: &Value, now_ms: i64) -> RowOutcome {
    if v.as_object().is_none() {
        return RowOutcome::Invalid;
    }
    let played_at = v
        .get("ts")
        .or_else(|| v.get("playedAt"))
        .or_else(|| v.get("played_at"))
        .and_then(parse_ts_millis);
    let Some(played_at) = played_at else {
        return RowOutcome::Invalid;
    };
    if played_at > now_ms {
        return RowOutcome::Invalid;
    }
    let Some(ms) = ms_field(v) else {
        return RowOutcome::Invalid;
    };
    // Empty here on purpose: the caller tallies empty uris apart from
    // corrupt rows so the honesty count can name them.
    let uri = opt_str(v, &["spotify_track_uri", "uri"]);
    if uri.is_empty() {
        return RowOutcome::NoUri;
    }
    if ms < HISTORY_MIN_MS {
        return RowOutcome::Short;
    }
    let reason_end = opt_str(v, &["reason_end", "reasonEnd"]);
    let skipped = v
        .get("skipped")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || reason_end == "fwdbtn";
    if skipped {
        return RowOutcome::Skipped;
    }
    let mut track_name = opt_str(
        v,
        &[
            "master_metadata_track_name",
            "trackName",
            "track_name",
            "name",
        ],
    );
    if track_name.is_empty() {
        track_name = unknown_name();
    }
    let artists = opt_str(
        v,
        &[
            "master_metadata_album_artist_name",
            "artists",
            "artistName",
        ],
    );
    RowOutcome::Keep(HistoryPlay {
        track_id: id_from_uri(&uri),
        track_name: track_name,
        artists,
        played_at,
        image: None,
        uri,
        duration_ms: ms,
        ms_played: ms,
        skipped: false,
        source: "imported".to_string(),
    })
}

/// Newest first, uri ascending on ties so the order is deterministic.
fn sort_plays(plays: &mut [HistoryPlay]) {
    plays.sort_by(|a, b| {
        b.played_at
            .cmp(&a.played_at)
            .then_with(|| a.uri.cmp(&b.uri))
    });
}

/// Full import pipeline: classify, dedupe on `uri@playedAt`, sort.
/// Pure; file IO lives in `import_history`.
pub fn import_parse(rows: &[Value], now_ms: i64) -> (Vec<HistoryPlay>, ImportCounts) {
    let mut counts = ImportCounts {
        total: rows.len(),
        kept: 0,
        dropped_short: 0,
        dropped_skipped: 0,
        dropped_no_uri: 0,
        dropped_duplicate: 0,
        dropped_invalid: 0,
    };
    let mut seen: HashSet<String> = HashSet::new();
    let mut plays: Vec<HistoryPlay> = Vec::new();
    for r in rows {
        match classify_row(r, now_ms) {
            RowOutcome::Invalid => counts.dropped_invalid += 1,
            RowOutcome::NoUri => counts.dropped_no_uri += 1,
            RowOutcome::Short => counts.dropped_short += 1,
            RowOutcome::Skipped => counts.dropped_skipped += 1,
            RowOutcome::Keep(p) => {
                let key = format!("{}@{}", p.uri, p.played_at);
                if seen.insert(key) {
                    plays.push(p);
                } else {
                    counts.dropped_duplicate += 1;
                }
            }
        }
    }
    sort_plays(&mut plays);
    counts.kept = plays.len();
    (plays, counts)
}

/// Merge two play slices with `uri@playedAt` dedupe. Base wins on key
/// conflicts, so repeat imports are idempotent. Pure.
pub fn merge_dedupe(base: &[HistoryPlay], incoming: &[HistoryPlay]) -> Vec<HistoryPlay> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<HistoryPlay> = Vec::new();
    for p in base.iter().chain(incoming.iter()) {
        if p.uri.is_empty() || p.played_at <= 0 {
            continue;
        }
        let key = format!("{}@{}", p.uri, p.played_at);
        if seen.insert(key) {
            out.push(p.clone());
        }
    }
    sort_plays(&mut out);
    out
}

/// Validate one frontend play value into a countable row. Unknown
/// fields are ignored; display fields fall back like the TS parser.
fn validate_play(v: &Value) -> Option<HistoryPlay> {
    let uri = opt_str(v, &["uri"]);
    if uri.is_empty() {
        return None;
    }
    let played_at = v.get("playedAt").and_then(parse_ts_millis)?;
    if played_at <= 0 {
        return None;
    }
    let duration_ms = v
        .get("durationMs")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let ms_played = v
        .get("msPlayed")
        .and_then(Value::as_i64)
        .unwrap_or(duration_ms);
    let mut track_id = opt_str(v, &["trackId", "track_id"]);
    if track_id.is_empty() {
        track_id = id_from_uri(&uri);
    }
    let mut track_name = opt_str(v, &["trackName", "track_name", "name"]);
    if track_name.is_empty() {
        track_name = unknown_name();
    }
    let source = normalize_source(v.get("source").and_then(Value::as_str)).to_string();
    Some(HistoryPlay {
        track_id,
        track_name,
        artists: opt_str(v, &["artists"]),
        played_at,
        image: v
            .get("image")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        uri,
        duration_ms,
        ms_played,
        skipped: v
            .get("skipped")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        source,
    })
}

/// Append one poll-observed listen. Returns the new list plus the
/// reason; the caller only writes on `Appended`. Pure.
pub fn append_listen(
    plays: &[HistoryPlay],
    candidate: &HistoryPlay,
    now_ms: i64,
) -> (Vec<HistoryPlay>, AppendReason) {
    if candidate.uri.is_empty() {
        return (plays.to_vec(), AppendReason::NoUri);
    }
    if candidate.played_at <= 0 {
        return (plays.to_vec(), AppendReason::Invalid);
    }
    if candidate.played_at > now_ms {
        return (plays.to_vec(), AppendReason::Future);
    }
    let ms = if candidate.ms_played > 0 {
        candidate.ms_played
    } else {
        candidate.duration_ms
    };
    if ms <= 0 {
        return (plays.to_vec(), AppendReason::Invalid);
    }
    if ms < HISTORY_MIN_MS {
        return (plays.to_vec(), AppendReason::Short);
    }
    if candidate.skipped {
        return (plays.to_vec(), AppendReason::Skipped);
    }
    if plays
        .iter()
        .any(|p| p.uri == candidate.uri && p.played_at == candidate.played_at)
    {
        return (plays.to_vec(), AppendReason::Duplicate);
    }
    let mut out = plays.to_vec();
    out.push(candidate.clone());
    sort_plays(&mut out);
    (out, AppendReason::Appended)
}

fn history_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join(HISTORY_FILE))
}

fn load_store_from(path: &Path) -> HistoryStore {
    match read_json_guarded(path, |t| {
        serde_json::from_str::<HistoryStore>(t)
            .map(|s| s.version == HISTORY_STORE_VERSION)
            .unwrap_or(false)
    }) {
        Some(text) => serde_json::from_str(&text).unwrap_or_default(),
        None => HistoryStore::default(),
    }
}

fn load_store(app: &AppHandle) -> HistoryStore {
    match history_path(app) {
        Some(p) => load_store_from(&p),
        None => HistoryStore::default(),
    }
}

fn save_store(app: &AppHandle, store: &HistoryStore) -> Result<(), String> {
    let path = history_path(app).ok_or("history dir unavailable")?;
    let text = serde_json::to_string(store).map_err(|e| e.to_string())?;
    // Temp-file plus rename with one `.bak`; readers never see a
    // half-written store even on kill mid-write.
    atomic_write_json(&path, &text).map_err(|e| e.to_string())
}

/// Import Extended-history rows into the local store. Merges with
/// dedupe, records the batch name for the honesty note, and returns
/// the per-file tallies. `batch` names the import (usually the file
/// name); repeats of a known batch still merge but are not renamed.
#[tauri::command]
pub fn import_history(
    app: AppHandle,
    rows: Vec<Value>,
    batch: Option<String>,
) -> Result<ImportCounts, String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut store = load_store(&app);
    let (plays, counts) = import_parse(&rows, now_ms);
    if !plays.is_empty() {
        store.plays = merge_dedupe(&store.plays, &plays);
    }
    if let Some(b) = batch {
        let b = b.trim().to_string();
        if !b.is_empty() {
            store.imported_ranges = union_ranges(&store.imported_ranges, &[b]);
        }
    }
    save_store(&app, &store)?;
    Ok(counts)
}

/// Stats over an inclusive `[start, now]` window. `start` None means
/// lifetime. Short and skipped plays never count. Future stamps drop
/// as clock skew.
#[tauri::command]
pub fn get_history_stats(
    app: AppHandle,
    start: Option<i64>,
    now: Option<i64>,
) -> Result<Value, String> {
    let store = load_store(&app);
    let now_ms = now
        .filter(|n| *n > 0)
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    let mut total: usize = 0;
    let mut total_ms: i64 = 0;
    let mut tracks: HashSet<String> = HashSet::new();
    let mut artists: HashSet<String> = HashSet::new();
    for p in &store.plays {
        if p.played_at > now_ms {
            continue;
        }
        if let Some(s) = start {
            if p.played_at < s {
                continue;
            }
        }
        let ms = if p.ms_played > 0 {
            p.ms_played
        } else {
            p.duration_ms
        };
        if p.skipped || ms < HISTORY_MIN_MS {
            continue;
        }
        total += 1;
        total_ms += ms.max(0);
        tracks.insert(p.track_id.clone());
        for a in p.artists.split(',') {
            let t = a.trim();
            if !t.is_empty() {
                artists.insert(t.to_string());
            }
        }
    }
    let has_imported = !store.imported_ranges.is_empty()
        || store.plays.iter().any(|p| p.source == "imported");
    Ok(serde_json::json!({
        "total": total,
        "totalMs": total_ms,
        "minutes": total_ms / 60000,
        "uniqueTracks": tracks.len(),
        "uniqueArtists": artists.len(),
        "hasImported": has_imported,
    }))
}

/// Append one poll-observed listen. Returns the reason (`appended`,
/// `duplicate`, `short`, `skipped`, `no-uri`, `future`, `invalid`);
/// only `appended` touches the disk.
#[tauri::command]
pub fn append_listen_cmd(app: AppHandle, play: Value) -> Result<Value, String> {
    let candidate = validate_play(&play).ok_or("invalid play")?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut store = load_store(&app);
    let (plays, reason) = append_listen(&store.plays, &candidate, now_ms);
    if reason == AppendReason::Appended {
        store.plays = plays;
        save_store(&app, &store)?;
    }
    Ok(serde_json::json!({ "reason": reason.as_str() }))
}

/// Full play list for a fresh client mirror. The ProfilePane loads
/// this on mount so a reload keeps imports and the poll dedupe sees
/// the persisted rows; stats derive from the loaded store. Read-only:
/// never writes.
#[tauri::command]
pub fn get_history_plays(app: AppHandle) -> Result<Value, String> {
    let store = load_store(&app);
    Ok(serde_json::json!({
        "version": store.version,
        "plays": store.plays,
        "importedRanges": store.imported_ranges,
    }))
}

/// Read a user-picked history file in Rust so the frontend needs no
/// fs-read scope outside `$APPLOCALDATA`. The dialog pick stays in
/// the frontend; only the bytes come through here.
#[tauri::command]
pub fn read_history_file(path: String) -> Result<String, String> {
    let p = path.trim().to_string();
    if p.is_empty() {
        return Err("empty path".to_string());
    }
    std::fs::read_to_string(&p).map_err(|e| e.to_string())
}

/// Allowlist for stored `source` values. Anything outside the two
/// known origins reads back as `api` so a hand-edited store can never
/// invent a third provenance.
fn normalize_source(raw: Option<&str>) -> &'static str {
    match raw.map(str::trim) {
        Some("imported") => "imported",
        _ => "api",
    }
}

/// Merge helper for `imported_ranges`: unions two batches without
/// repeats, preserving first-seen order.
fn union_ranges(base: &[String], extra: &[String]) -> Vec<String> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for r in base.iter().chain(extra.iter()) {
        if !r.trim().is_empty() && seen.insert(r.as_str()) {
            out.push(r.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{
        append_listen, import_parse, load_store_from, merge_dedupe, normalize_source,
        parse_iso_millis, parse_ts_millis, union_ranges, AppendReason, HistoryPlay,
        HistoryStore, HISTORY_MIN_MS, HISTORY_STORE_VERSION,
    };
    use crate::overlay::{atomic_write_json, read_json_guarded};
    use serde_json::{json, Value};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIRS: AtomicU64 = AtomicU64::new(0);

    const T1: i64 = 1719792000000; // 2024-07-01T00:00:00Z
    const T2: i64 = 1719795600000; // 2024-07-01T01:00:00Z
    const NOW: i64 = 1719802800000; // 2024-07-01T03:00:00Z

    fn test_dir(name: &str) -> PathBuf {
        let n = TEST_DIRS.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "snapify-history-test-{name}-{}-{n}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    fn endsong(uri: &str, ms: i64) -> Value {
        json!({
            "ts": "2024-07-01T00:00:00.000Z",
            "ms_played": ms,
            "master_metadata_track_name": "Song",
            "master_metadata_album_artist_name": "Band",
            "master_metadata_album_album_name": "Album",
            "spotify_track_uri": uri,
            "reason_start": "trackdone",
            "reason_end": "trackdone",
            "skipped": false,
            "mystery_future_field": [1, 2, 3],
        })
    }

    fn play(uri: &str, at: i64) -> HistoryPlay {
        HistoryPlay {
            track_id: uri.rsplit(':').next().unwrap_or(uri).to_string(),
            track_name: uri.to_string(),
            artists: "Band".to_string(),
            played_at: at,
            image: None,
            uri: uri.to_string(),
            duration_ms: 200000,
            ms_played: 200000,
            skipped: false,
            source: "imported".to_string(),
        }
    }

    #[test]
    fn floor_and_version_are_pinned() {
        assert_eq!(HISTORY_MIN_MS, 30000);
        assert_eq!(HISTORY_STORE_VERSION, 1);
    }

    #[test]
    fn allowlist_ignores_unknown_fields() {
        // `mystery_future_field` must not leak into the row or fail it.
        let (plays, counts) = import_parse(&[endsong("spotify:track:aaa", 200000)], NOW);
        assert_eq!(counts.kept, 1);
        assert_eq!(plays[0].uri, "spotify:track:aaa");
        assert_eq!(plays[0].track_id, "aaa");
        assert_eq!(plays[0].played_at, T1);
        assert_eq!(plays[0].source, "imported");
    }

    #[test]
    fn import_counts_drops_by_bucket() {
        let rows = vec![
            endsong("spotify:track:keep", 200000),
            endsong("spotify:track:short", 29999),
            json!({
                "ts": "2024-07-01T00:00:00.000Z",
                "ms_played": 200000,
                "master_metadata_track_name": "S",
                "master_metadata_album_artist_name": "B",
                "spotify_track_uri": "spotify:track:skipped",
                "skipped": true,
            }),
            json!({
                "ts": "2024-07-01T00:00:00.000Z",
                "ms_played": 200000,
                "master_metadata_track_name": "F",
                "master_metadata_album_artist_name": "B",
                "spotify_track_uri": "spotify:track:fwd",
                "reason_end": "fwdbtn",
            }),
            endsong("", 200000),
            Value::Null,
            endsong("spotify:track:keep", 200000),
            endsong("spotify:track:exact", 30000),
        ];
        let (plays, counts) = import_parse(&rows, NOW);
        assert_eq!(counts.total, 8);
        assert_eq!(counts.kept, 2);
        assert_eq!(counts.dropped_short, 1);
        assert_eq!(counts.dropped_skipped, 2);
        assert_eq!(counts.dropped_no_uri, 1);
        assert_eq!(counts.dropped_duplicate, 1);
        assert_eq!(counts.dropped_invalid, 1);
        // Newest first; the two survivors share T1 so uri order decides.
        assert_eq!(plays[0].uri, "spotify:track:exact");
        assert_eq!(plays[1].uri, "spotify:track:keep");
    }

    #[test]
    fn merge_is_idempotent_and_sorted() {
        let once = merge_dedupe(&[play("spotify:track:a", T1)], &[play("spotify:track:b", T2)]);
        assert_eq!(once.len(), 2);
        assert_eq!(once[0].uri, "spotify:track:b");
        let twice = merge_dedupe(
            &once,
            &[play("spotify:track:a", T1), play("spotify:track:b", T2)],
        );
        assert_eq!(twice, once);
    }

    #[test]
    fn append_reasons_cover_every_refusal() {
        let base = vec![play("spotify:track:a", T1)];
        let mut dup = play("spotify:track:a", T1);
        dup.source = "api".to_string();
        assert_eq!(append_listen(&base, &dup, NOW).1, AppendReason::Duplicate);
        let mut short = play("spotify:track:new", T2);
        short.ms_played = 10000;
        short.duration_ms = 10000;
        assert_eq!(append_listen(&base, &short, NOW).1, AppendReason::Short);
        let mut skipped = play("spotify:track:new", T2);
        skipped.skipped = true;
        assert_eq!(append_listen(&base, &skipped, NOW).1, AppendReason::Skipped);
        let mut no_uri = play("spotify:track:new", T2);
        no_uri.uri = String::new();
        assert_eq!(append_listen(&base, &no_uri, NOW).1, AppendReason::NoUri);
        let future = play("spotify:track:new", NOW + 5000);
        assert_eq!(append_listen(&base, &future, NOW).1, AppendReason::Future);
        let mut bad = play("spotify:track:new", T2);
        bad.played_at = -1;
        assert_eq!(append_listen(&base, &bad, NOW).1, AppendReason::Invalid);
        let fresh = play("spotify:track:new", T2);
        let (out, reason) = append_listen(&base, &fresh, NOW);
        assert_eq!(reason, AppendReason::Appended);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].uri, "spotify:track:new");
    }

    #[test]
    fn stamps_accept_iso_and_millis() {
        assert_eq!(parse_ts_millis(&json!("2024-07-01T00:00:00.000Z")), Some(T1));
        assert_eq!(parse_ts_millis(&json!(T1)), Some(T1));
        assert_eq!(parse_ts_millis(&json!(T1.to_string())), Some(T1));
        assert_eq!(parse_ts_millis(&json!("not-a-date")), None);
        assert_eq!(parse_ts_millis(&json!(-5)), None);
        assert_eq!(parse_iso_millis("2024-07-01 00:00:00"), Some(T1));
    }

    #[test]
    fn source_allowlist_falls_back_to_api() {
        assert_eq!(normalize_source(Some("imported")), "imported");
        assert_eq!(normalize_source(Some("spotify")), "api");
        assert_eq!(normalize_source(None), "api");
    }

    #[test]
    fn ranges_union_without_repeats() {
        assert_eq!(
            union_ranges(
                &["a".to_string()],
                &["b".to_string(), "a".to_string(), "".to_string()]
            ),
            vec!["a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn corrupt_primary_restores_from_backup() {
        let dir = test_dir("restore");
        let path = dir.join("history-store.json");
        let mut store = HistoryStore::default();
        store.plays = vec![play("spotify:track:a", T1)];
        atomic_write_json(&path, &serde_json::to_string(&store).unwrap()).unwrap();
        atomic_write_json(&path, &serde_json::to_string(&store).unwrap()).unwrap();
        std::fs::write(&path, "{corrupt").unwrap();
        let back = load_store_from(&path);
        assert_eq!(back.version, 1);
        assert_eq!(back.plays.len(), 1);
        assert_eq!(back.plays[0].uri, "spotify:track:a");
        // Primary is healed in place.
        assert!(read_json_guarded(&path, |t| {
            serde_json::from_str::<HistoryStore>(t).is_ok()
        })
        .is_some());
    }

    #[test]
    fn version_mismatch_falls_back_to_empty() {
        let dir = test_dir("version");
        let path = dir.join("history-store.json");
        std::fs::write(&path, r#"{"version":99,"plays":[],"importedRanges":[]}"#).unwrap();
        let back = load_store_from(&path);
        assert_eq!(back.version, HISTORY_STORE_VERSION);
        assert!(back.plays.is_empty());
    }
}
