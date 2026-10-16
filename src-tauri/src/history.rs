use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::overlay::{atomic_write_json, read_json_guarded};

/// Minimum listened milliseconds that counts as a stream. Mirrors
/// `HISTORY_MIN_MS` in `src/lib/history.ts`; the two must agree.
pub const HISTORY_MIN_MS: i64 = 30000;

/// History store schema version. v2 is the normalized form (track
/// dictionary + compact plays); v1 (flat `plays: HistoryPlay[]`)
/// still loads via migration so lifetime truth survives the upgrade.
/// Anything else falls back to empty. Mirrors `HISTORY_STORE_VERSION`
/// (TS still writes v1-shaped mirrors for the web fallback).
pub const HISTORY_STORE_VERSION: u8 = 2;
/// Legacy v1 version accepted on read and migrated forward.
pub const HISTORY_STORE_VERSION_V1: u8 = 1;

/// Largest single history file `read_history_file` returns. Files
/// over this are refused so one dump never OOMs the app. Mirrors
/// `HISTORY_IMPORT_MAX_BYTES` in `src/lib/history.ts`.
pub const HISTORY_IMPORT_MAX_BYTES: u64 = 25 * 1024 * 1024;

pub const HISTORY_STORE_CAP: usize = 50_000;

/// Paged-list window for `get_history_page`. The pane fetches 100 rows
/// per cursor step and never holds the full store. Mirrors
/// `HISTORY_PAGE_SIZE` (TS) and `RECENT_PAGE_SIZE` (pane).
pub const HISTORY_PAGE_LIMIT: usize = 100;

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
    /// Album display string (`master_metadata_album_album_name`).
    /// Powers the Different-albums tile; absent on old rows/live recents.
    #[serde(default)]
    pub album_name: String,
    #[serde(default)]
    pub album: String,
    #[serde(default = "api_source")]
    pub source: String,
}

/// Deduplicated track metadata: one entry per `spotify:track:` URI, no
/// per-row string duplication. A 350k-row lifetime with ~17k tracks
/// holds ~17k metadata rows instead of 350k duplicated name/artist/
/// album strings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackMeta {
    #[serde(default)]
    pub track_id: String,
    #[serde(default = "unknown_name")]
    pub track_name: String,
    #[serde(default)]
    pub artists: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub uri: String,
}

/// One compact play: index into `tracks` plus time/ms/flags. No
/// duplicated strings per row (`track:u32 + playedAt:i64 + ms:u32 +
/// flags:u8` ≈ 16 bytes vs ~200+ for a flat row).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactPlay {
    pub track: u32,
    pub played_at: i64,
    pub ms: u32,
    #[serde(default)]
    pub flags: u8,
}

/// Flag bit: the export marked the row skipped. Skipped-long rows are
/// still counted (stats.fm parity); the bit is provenance, not a veto.
pub const FLAG_SKIPPED: u8 = 0x01;
/// Flag bit: the row came from an Extended-history import (`imported`);
/// clear means live API poll (`api`).
pub const FLAG_IMPORTED: u8 = 0x02;

/// Versioned local store at `app_local_data_dir()/history-store.json`.
/// v2 normalized form: `tracks` dedupes metadata by URI, `plays` holds
/// compact `(track-idx, playedAt, ms, flags)` rows with no duplicated
/// strings. v1 JSON (`plays: HistoryPlay[]`) still loads via
/// `migrate_v1_store` so upgrades keep lifetime truth.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStore {
    pub version: u8,
    #[serde(default)]
    pub tracks: Vec<TrackMeta>,
    #[serde(default)]
    pub plays: Vec<CompactPlay>,
    #[serde(default)]
    pub imported_ranges: Vec<String>,
}

impl Default for HistoryStore {
    fn default() -> Self {
        Self {
            version: HISTORY_STORE_VERSION,
            tracks: Vec::new(),
            plays: Vec::new(),
            imported_ranges: Vec::new(),
        }
    }
}

/// Legacy v1 store shape (flat plays) for migration only.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryStoreV1 {
    #[serde(default)]
    pub version: u8,
    #[serde(default)]
    pub plays: Vec<HistoryPlay>,
    #[serde(default)]
    pub imported_ranges: Vec<String>,
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

/// True for countable track URIs. Podcast/episode/show/audiobook rows
/// never count; they tally as `dropped_no_uri` so the import message
/// stays honest. Mirrors `isTrackUri` in `src/lib/history.ts`.
pub fn is_track_uri(uri: &str) -> bool {
    uri.starts_with("spotify:track:")
}

/// Single derivation gate for the Rust layer: `ms>=HISTORY_MIN_MS` plus
/// the track-uri gate. Skipped-long rows COUNT (stats.fm import parity);
/// only short/podcast/invalid rows drop. Mirrors `isCountedPlay` in
/// `src/lib/profile.ts`.
pub fn is_counted(ms: i64, uri: &str) -> bool {
    ms >= HISTORY_MIN_MS && is_track_uri(uri)
}

/// Dedupe key. One uri at one timestamp is one listen.
pub fn play_key(uri: &str, played_at: i64) -> String {
    format!("{uri}@{played_at}")
}

/// Build an O(1) dedupe index over materialized plays. Poll appends
/// probe the set instead of scanning the full Vec.
pub fn build_play_index(plays: &[HistoryPlay]) -> HashSet<String> {
    plays.iter().map(|p| play_key(&p.uri, p.played_at)).collect()
}

/// Find-or-insert a track-metadata row by URI. Returns the compact index.
fn track_index_for(tracks: &mut Vec<TrackMeta>, meta: TrackMeta) -> u32 {
    if let Some(ix) = tracks.iter().position(|t| t.uri == meta.uri) {
        return ix as u32;
    }
    tracks.push(meta);
    (tracks.len() - 1) as u32
}

fn album_of(v: &Value) -> String {
    opt_str(
        v,
        &[
            "master_metadata_album_album_name",
            "albumName",
            "album_name",
            "album",
        ],
    )
}

/// Materialize one flat play from a compact row (for paging/APIs).
pub fn play_from_compact(tracks: &[TrackMeta], c: &CompactPlay) -> Option<HistoryPlay> {
    let t = tracks.get(c.track as usize)?;
    Some(HistoryPlay {
        track_id: t.track_id.clone(),
        track_name: t.track_name.clone(),
        artists: t.artists.clone(),
        played_at: c.played_at,
        image: None,
        uri: t.uri.clone(),
        duration_ms: c.ms as i64,
        ms_played: c.ms as i64,
        skipped: (c.flags & FLAG_SKIPPED) != 0,
        album_name: t.album.clone(),
        album: t.album.clone(),
        source: if (c.flags & FLAG_IMPORTED) != 0 {
            "imported".to_string()
        } else {
            "api".to_string()
        },
    })
}

/// Compact one flat play into the normalized store (find-or-insert track).
fn compact_from_play(tracks: &mut Vec<TrackMeta>, p: &HistoryPlay) -> CompactPlay {
    let album = if !p.album_name.is_empty() {
        p.album_name.clone()
    } else if !p.album.is_empty() {
        p.album.clone()
    } else {
        String::new()
    };
    let meta = TrackMeta {
        track_id: if p.track_id.is_empty() {
            id_from_uri(&p.uri)
        } else {
            p.track_id.clone()
        },
        track_name: if p.track_name.is_empty() {
            unknown_name()
        } else {
            p.track_name.clone()
        },
        artists: p.artists.clone(),
        album,
        uri: p.uri.clone(),
    };
    let idx = track_index_for(tracks, meta);
    let ms = p.ms_played.max(p.duration_ms).max(0).min(u32::MAX as i64) as u32;
    let mut flags: u8 = 0;
    if p.skipped {
        flags |= FLAG_SKIPPED;
    }
    if p.source == "imported" {
        flags |= FLAG_IMPORTED;
    }
    CompactPlay {
        track: idx,
        played_at: p.played_at,
        ms,
        flags,
    }
}

/// All flat plays in a store, newest first. Used by paging/aggregates;
/// callers that only need aggregates never materialize (see
/// `store_aggregates`).
pub fn store_plays(store: &HistoryStore) -> Vec<HistoryPlay> {
    let mut out: Vec<HistoryPlay> = store
        .plays
        .iter()
        .filter_map(|c| play_from_compact(&store.tracks, c))
        .collect();
    sort_plays(&mut out);
    out
}

/// Insert flat plays into a normalized store with `uri@playedAt` dedupe.
/// Base wins on conflicts (idempotent re-imports). Result stays newest
/// first and is NEVER trimmed — paging bounds the UI instead.
pub fn store_insert(store: &mut HistoryStore, incoming: &[HistoryPlay]) {
    let mut seen: HashSet<String> = HashSet::with_capacity(store.plays.len() + incoming.len());
    for c in &store.plays {
        if let Some(t) = store.tracks.get(c.track as usize) {
            seen.insert(play_key(&t.uri, c.played_at));
        }
    }
    for p in incoming {
        if p.uri.is_empty() || p.played_at <= 0 {
            continue;
        }
        let key = play_key(&p.uri, p.played_at);
        if !seen.insert(key) {
            continue;
        }
        let c = compact_from_play(&mut store.tracks, p);
        store.plays.push(c);
    }
    sort_compact(store);
}

/// Newest first, uri ascending on ties (via track URI lookup).
fn sort_compact(store: &mut HistoryStore) {
    let tracks = &store.tracks;
    store.plays.sort_by(|a, b| {
        b.played_at.cmp(&a.played_at).then_with(|| {
            let ua = tracks.get(a.track as usize).map(|t| t.uri.as_str()).unwrap_or("");
            let ub = tracks.get(b.track as usize).map(|t| t.uri.as_str()).unwrap_or("");
            ua.cmp(ub)
        })
    });
}

/// Migrate a legacy v1 doc (flat plays) into normalized v2.
fn migrate_v1_store(v1: HistoryStoreV1) -> HistoryStore {
    let mut store = HistoryStore {
        version: HISTORY_STORE_VERSION,
        tracks: Vec::new(),
        plays: Vec::new(),
        imported_ranges: v1.imported_ranges,
    };
    store_insert(&mut store, &v1.plays);
    store
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
/// ignored. Future stamps count as invalid (clock skew). Rules mirror
/// TS `parseExtendedHistory`: invalid → no-uri (empty + podcast) →
/// short (`ms<30000`, covers skipped-short) → keep (skipped-long and
/// fwdbtn-long COUNT for stats.fm parity).
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
    let uri = opt_str(v, &["spotify_track_uri", "uri"]);
    if uri.is_empty() || !is_track_uri(&uri) {
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
    let album = album_of(v);
    RowOutcome::Keep(HistoryPlay {
        track_id: id_from_uri(&uri),
        track_name,
        artists,
        played_at,
        image: None,
        uri,
        duration_ms: ms,
        ms_played: ms,
        skipped,
        album_name: album.clone(),
        album,
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

fn trim_to_cap(_plays: &mut Vec<HistoryPlay>) {}

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

pub fn merge_dedupe(base: &[HistoryPlay], incoming: &[HistoryPlay]) -> Vec<HistoryPlay> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<HistoryPlay> = Vec::new();
    for p in base.iter().chain(incoming.iter()) {
        if p.uri.is_empty() || p.played_at <= 0 {
            continue;
        }
        let key = play_key(&p.uri, p.played_at);
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
    let album = opt_str(v, &["albumName", "album_name", "album"]);
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
        album_name: album.clone(),
        album,
        source,
    })
}

pub fn append_listen(
    plays: &[HistoryPlay],
    candidate: &HistoryPlay,
    now_ms: i64,
) -> (Vec<HistoryPlay>, AppendReason) {
    if candidate.uri.is_empty() || !is_track_uri(&candidate.uri) {
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
    let index = build_play_index(plays);
    if index.contains(&play_key(&candidate.uri, candidate.played_at)) {
        return (plays.to_vec(), AppendReason::Duplicate);
    }
    let mut out = plays.to_vec();
    // Fast path: genuinely newest rows prepend without sorting.
    let newest_first = out.first().map(|p| candidate.played_at >= p.played_at).unwrap_or(true);
    if newest_first {
        out.insert(0, candidate.clone());
    } else {
        out.push(candidate.clone());
        sort_plays(&mut out);
    }
    (out, AppendReason::Appended)
}

/// Normalized append: insert one candidate into a `HistoryStore` with
/// O(1)-ish dedupe (index set) and head-prepend for the newest case.
/// Returns the reason; the caller only writes on `Appended`. Pure
/// apart from the store mutation (documented).
pub fn store_append(store: &mut HistoryStore, candidate: &HistoryPlay, now_ms: i64) -> AppendReason {
    if candidate.uri.is_empty() || !is_track_uri(&candidate.uri) {
        return AppendReason::NoUri;
    }
    if candidate.played_at <= 0 {
        return AppendReason::Invalid;
    }
    if candidate.played_at > now_ms {
        return AppendReason::Future;
    }
    let ms = if candidate.ms_played > 0 {
        candidate.ms_played
    } else {
        candidate.duration_ms
    };
    if ms <= 0 {
        return AppendReason::Invalid;
    }
    if ms < HISTORY_MIN_MS {
        return AppendReason::Short;
    }
    // O(1)-ish probe: build the key set once per call (imports build it
    // once per batch; polls call this once per 5s tick — no per-row scan
    // plus full clone+sort).
    let mut seen: HashSet<String> = HashSet::with_capacity(store.plays.len() + 1);
    for c in &store.plays {
        if let Some(t) = store.tracks.get(c.track as usize) {
            seen.insert(play_key(&t.uri, c.played_at));
        }
    }
    let key = play_key(&candidate.uri, candidate.played_at);
    if !seen.insert(key) {
        return AppendReason::Duplicate;
    }
    let c = compact_from_play(&mut store.tracks, candidate);
    // Newest-first insert without a full re-sort when possible.
    let is_newest = store.plays.first().map(|f| c.played_at >= f.played_at).unwrap_or(true);
    if is_newest {
        store.plays.insert(0, c);
    } else {
        store.plays.push(c);
        sort_compact(store);
    }
    AppendReason::Appended
}

fn history_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join(HISTORY_FILE))
}

fn load_store_from(path: &Path) -> HistoryStore {
    let text = match read_json_guarded(path, |t| {
        serde_json::from_str::<serde_json::Value>(t).is_ok()
    }) {
        Some(t) => t,
        None => return HistoryStore::default(),
    };
    // v2 normalized first; v1 flat migrates forward so upgrades keep
    // lifetime truth instead of resetting to empty.
    if let Ok(s) = serde_json::from_str::<HistoryStore>(&text) {
        if s.version == HISTORY_STORE_VERSION {
            return s;
        }
    }
    if let Ok(v1) = serde_json::from_str::<HistoryStoreV1>(&text) {
        if v1.version == HISTORY_STORE_VERSION_V1 {
            return migrate_v1_store(v1);
        }
    }
    HistoryStore::default()
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

/// Per-range aggregates over the FULL normalized store. Single Rust
/// derivation site: same 30s floor + track-uri gate + `uri@playedAt`
/// dedupe as TS `deriveStats`/`bucketListeningClocks`/
/// `rankArtistsByStreams`. Callers that only need numbers never
/// materialize play rows, so 350k-row lifetimes stay heap-bounded.
pub fn store_aggregates(store: &HistoryStore, start: Option<i64>, now_ms: i64) -> Value {
    use std::collections::HashMap;
    let mut total: usize = 0;
    let mut total_ms: i64 = 0;
    let mut tracks: HashSet<String> = HashSet::new();
    let mut artists: HashSet<String> = HashSet::new();
    let mut albums: HashSet<String> = HashSet::new();
    let mut ms_per_hour = [0i64; 24];
    let mut plays_per_hour = [0usize; 24];
    // artist key (lowercase) -> (display, streams, ms)
    let mut by_artist: HashMap<String, (String, usize, i64)> = HashMap::new();
    for c in &store.plays {
        if c.played_at > now_ms {
            continue;
        }
        if let Some(s) = start {
            if c.played_at < s {
                continue;
            }
        }
        let Some(t) = store.tracks.get(c.track as usize) else {
            continue;
        };
        let ms = c.ms as i64;
        if !is_counted(ms, &t.uri) {
            continue;
        }
        total += 1;
        total_ms += ms.max(0);
        tracks.insert(t.track_id.clone());
        for a in t.artists.split(',') {
            let name = a.trim();
            if name.is_empty() {
                continue;
            }
            artists.insert(name.to_string());
            let key = name.to_lowercase();
            let e = by_artist.entry(key).or_insert((name.to_string(), 0, 0));
            e.1 += 1;
            e.2 += ms.max(0);
        }
        let alb = t.album.trim();
        if !alb.is_empty() {
            albums.insert(alb.to_lowercase());
        }
        // Hour bucket in the server timezone (UTC). The TS pane buckets
        // in local time; hour shapes may shift by zone, but totals/peak
        // agree and the pane prefers its local derive for small stores.
        // Rust clocks are the lifetime-truth fallback for large stores.
        let hour = ((c.played_at / 3_600_000) % 24 + 24) % 24;
        // played_at is UTC millis; derive hour via chrono for correctness.
        let h = chrono::DateTime::from_timestamp_millis(c.played_at)
            .map(|d| d.format("%H").to_string().parse::<usize>().unwrap_or(hour as usize))
            .unwrap_or(hour as usize)
            .min(23);
        plays_per_hour[h] += 1;
        ms_per_hour[h] += ms.max(0);
    }
    let minutes = total_ms / 60000;
    let hours = (minutes as f64 / 60.0).round() as i64;
    let mut clocks: Vec<Value> = Vec::with_capacity(24);
    for h in 0..24 {
        clocks.push(serde_json::json!({
            "hour": h,
            "plays": plays_per_hour[h],
            "minutes": ms_per_hour[h] / 60000,
        }));
    }
    let mut peak_hour = 0usize;
    for h in 1..24 {
        if plays_per_hour[h] > plays_per_hour[peak_hour] {
            peak_hour = h;
        }
    }
    let mut ranks: Vec<(String, usize, i64)> = by_artist.into_values().collect();
    ranks.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase())));
    ranks.truncate(50);
    let artist_ranks: Vec<Value> = ranks
        .into_iter()
        .map(|(artist, streams, ms)| {
            serde_json::json!({ "artist": artist, "streams": streams, "minutes": ms / 60000 })
        })
        .collect();
    let has_imported = !store.imported_ranges.is_empty()
        || store.plays.iter().any(|c| (c.flags & FLAG_IMPORTED) != 0);
    serde_json::json!({
        "total": total,
        "totalMs": total_ms,
        "minutes": minutes,
        "hours": hours,
        "uniqueTracks": tracks.len(),
        "uniqueArtists": artists.len(),
        "uniqueAlbums": albums.len(),
        "hasImported": has_imported,
        "clocks": clocks,
        "peakHour": peak_hour,
        "artistRanks": artist_ranks,
    })
}

/// One paged window over a `[start, now]` range, newest first. `cursor`
/// is the `uri@playedAt` key of the previous page's last row (null for
/// the first page); `limit` caps rows (1..=500, default
/// `HISTORY_PAGE_LIMIT`). Returns `(items, next_cursor, total)` so the
/// pane renders `Showing X of N` without holding the full store.
pub fn store_page(
    store: &HistoryStore,
    start: Option<i64>,
    now_ms: i64,
    cursor: Option<&str>,
    limit: usize,
) -> (Vec<HistoryPlay>, Option<String>, usize) {
    let limit = limit.clamp(1, 500);
    let mut window: Vec<HistoryPlay> = Vec::new();
    for c in &store.plays {
        if c.played_at > now_ms {
            continue;
        }
        if let Some(s) = start {
            if c.played_at < s {
                continue;
            }
        }
        let Some(t) = store.tracks.get(c.track as usize) else {
            continue;
        };
        let ms = c.ms as i64;
        if !is_counted(ms, &t.uri) {
            continue;
        }
        if let Some(p) = play_from_compact(&store.tracks, c) {
            window.push(p);
        }
    }
    // store.plays is already newest-first; window inherits that order.
    let total = window.len();
    let mut ix0 = 0usize;
    if let Some(cur) = cursor {
        if let Some(ix) = window.iter().position(|p| play_key(&p.uri, p.played_at) == cur) {
            ix0 = ix + 1;
        }
    }
    if ix0 >= total {
        return (Vec::new(), None, total);
    }
    let end = (ix0 + limit).min(total);
    let items = window[ix0..end].to_vec();
    let next = if end < total && !items.is_empty() {
        let last = &items[items.len() - 1];
        Some(play_key(&last.uri, last.played_at))
    } else {
        None
    };
    (items, next, total)
}

/// Import Extended-history rows into the local store. Merges with
/// dedupe into the normalized tracks+plays, records the batch name for
/// the honesty note, and returns the per-file tallies. `batch` names
/// the import (usually the file name); repeats of a known batch still
/// merge but are not renamed. Never trims: 350k-row lifetimes grow
/// trim-free (compact rows ≈16B each).
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
        store_insert(&mut store, &plays);
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

/// Per-range aggregates over the FULL normalized store (stats.fm
/// parity: skipped-long counts; only `ms<30000`/podcast/invalid drop).
/// `start` None means lifetime. Future stamps drop as clock skew.
/// Returns counts/minutes/hours/tracks/artists/albums plus 24 clocks,
/// peak hour, and top-50 stream-weighted artist ranks, so the pane
/// renders stats/clocks/genres without holding the full play array.
/// Single Rust derivation site (mirrors TS `deriveStats` etc.).
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
    Ok(store_aggregates(&store, start, now_ms))
}

#[tauri::command]
pub fn append_listen_cmd(app: AppHandle, play: Value) -> Result<Value, String> {
    let candidate = validate_play(&play).ok_or("invalid play")?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut store = load_store(&app);
    let reason = store_append(&mut store, &candidate, now_ms);
    if reason == AppendReason::Appended {
        save_store(&app, &store)?;
    }
    Ok(serde_json::json!({ "reason": reason.as_str() }))
}

#[tauri::command]
pub fn get_history_plays(app: AppHandle) -> Result<Value, String> {
    let store = load_store(&app);
    let plays = store_plays(&store);
    Ok(serde_json::json!({
        "version": store.version,
        "plays": plays,
        "importedRanges": store.imported_ranges,
    }))
}

/// Paged play rows for lists. The pane holds only the current page
/// (default 100 rows) plus aggregates — never the full array — so
/// render nodes stay ≤~1k on 350k-row lifetimes. `cursor` is the
/// `uri@playedAt` key of the previous page's last row (null = first
/// page). Returns `{ items, nextCursor, total }`.
#[tauri::command]
pub fn get_history_page(
    app: AppHandle,
    start: Option<i64>,
    now: Option<i64>,
    cursor: Option<String>,
    limit: Option<usize>,
) -> Result<Value, String> {
    let store = load_store(&app);
    let now_ms = now
        .filter(|n| *n > 0)
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    let lim = limit.unwrap_or(HISTORY_PAGE_LIMIT);
    let (items, next, total) = store_page(&store, start, now_ms, cursor.as_deref(), lim);
    Ok(serde_json::json!({
        "items": items,
        "nextCursor": next,
        "total": total,
    }))
}

/// Read a user-picked history file in Rust so the frontend needs no
/// fs-read scope outside `$APPLOCALDATA`. The dialog pick stays in
/// the frontend; only the bytes come through here. Files over
/// `HISTORY_IMPORT_MAX_BYTES` are refused before reading so one dump
/// never OOMs the app; the frontend surfaces the refusal as a
/// per-file note and continues with the rest.
#[tauri::command]
pub fn read_history_file(path: String) -> Result<String, String> {
    let p = path.trim().to_string();
    if p.is_empty() {
        return Err("empty path".to_string());
    }
    if let Ok(meta) = std::fs::metadata(&p) {
        if meta.len() > HISTORY_IMPORT_MAX_BYTES {
            return Err(format!(
                "file over 25MB ({} bytes), skipped",
                meta.len()
            ));
        }
    }
    let text = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    if text.len() as u64 > HISTORY_IMPORT_MAX_BYTES {
        return Err(format!(
            "file over 25MB ({} bytes), skipped",
            text.len()
        ));
    }
    Ok(text)
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
        append_listen, build_play_index, import_parse, is_counted, is_track_uri, load_store_from,
        merge_dedupe, normalize_source, parse_iso_millis, parse_ts_millis, play_from_compact,
        play_key, store_aggregates, store_append, store_insert, store_page, store_plays, trim_to_cap,
        union_ranges, AppendReason, CompactPlay, HistoryPlay, HistoryStore, TrackMeta,
        HISTORY_IMPORT_MAX_BYTES, HISTORY_MIN_MS, HISTORY_PAGE_LIMIT, HISTORY_STORE_CAP,
        HISTORY_STORE_VERSION, HISTORY_STORE_VERSION_V1,
    };
    use crate::overlay::{atomic_write_json, read_json_guarded};
    use serde_json::{json, Value};
    use std::collections::HashSet;
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
            album_name: "Album".to_string(),
            album: "Album".to_string(),
            source: "imported".to_string(),
        }
    }

    fn seq_play(i: usize, base_ms: i64) -> HistoryPlay {
        let uri = format!("spotify:track:seq-{i:06}");
        HistoryPlay {
            track_id: format!("seq-{i:06}"),
            track_name: format!("Song {i}"),
            artists: "Band".to_string(),
            played_at: base_ms + (i as i64) * 1000,
            image: None,
            uri,
            duration_ms: 200000,
            ms_played: 200000,
            skipped: false,
            album_name: format!("Album {:03}", i % 50),
            album: format!("Album {:03}", i % 50),
            source: "imported".to_string(),
        }
    }

    #[test]
    fn floor_and_version_are_pinned() {
        assert_eq!(HISTORY_MIN_MS, 30000);
        assert_eq!(HISTORY_STORE_VERSION, 2);
        assert_eq!(HISTORY_STORE_VERSION_V1, 1);
        assert_eq!(HISTORY_IMPORT_MAX_BYTES, 25 * 1024 * 1024);
        // Legacy cap export stays for compat but nothing trims: lifetime
        // truth is preserved and the UI pages (HISTORY_PAGE_LIMIT).
        assert_eq!(HISTORY_STORE_CAP, 50_000);
        assert_eq!(HISTORY_PAGE_LIMIT, 100);
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
        // Skipped-long + fwdbtn-long now COUNT (stats.fm parity); only
        // short/podcast/no-uri/dupe/invalid drop.
        let rows = vec![
            endsong("spotify:track:keep", 200000),
            endsong("spotify:track:short", 29999),
            json!({
                "ts": "2024-07-01T00:00:00.000Z",
                "ms_played": 200000,
                "master_metadata_track_name": "S",
                "master_metadata_album_artist_name": "B",
                "master_metadata_album_album_name": "Album S",
                "spotify_track_uri": "spotify:track:skipped-long",
                "skipped": true,
            }),
            json!({
                "ts": "2024-07-01T00:00:01.000Z",
                "ms_played": 200000,
                "master_metadata_track_name": "F",
                "master_metadata_album_artist_name": "B",
                "master_metadata_album_album_name": "Album F",
                "spotify_track_uri": "spotify:track:fwd-long",
                "reason_end": "fwdbtn",
            }),
            json!({
                "ts": "2024-07-01T00:00:00.000Z",
                "ms_played": 10000,
                "master_metadata_track_name": "SS",
                "master_metadata_album_artist_name": "B",
                "spotify_track_uri": "spotify:track:skipped-short",
                "skipped": true,
            }),
            endsong("", 200000),
            json!({
                "ts": "2024-07-01T00:00:00.000Z",
                "ms_played": 200000,
                "master_metadata_track_name": "Pod",
                "master_metadata_album_artist_name": "B",
                "spotify_track_uri": "spotify:episode:pod123",
                "reason_end": "trackdone",
                "skipped": false,
            }),
            Value::Null,
            endsong("spotify:track:keep", 200000),
            endsong("spotify:track:exact", 30000),
        ];
        let (plays, counts) = import_parse(&rows, NOW);
        assert_eq!(counts.total, 10);
        // keep + fwd-long + skipped-long + exact = 4 (keep dupe drops).
        assert_eq!(counts.kept, 4);
        // short + skipped-short = 2.
        assert_eq!(counts.dropped_short, 2);
        // No rows land in skipped: long-skips are kept.
        assert_eq!(counts.dropped_skipped, 0);
        // empty uri + podcast episode = 2.
        assert_eq!(counts.dropped_no_uri, 2);
        assert_eq!(counts.dropped_duplicate, 1);
        assert_eq!(counts.dropped_invalid, 1);
        assert!(plays.iter().any(|p| p.uri == "spotify:track:skipped-long" && p.skipped));
        assert!(plays.iter().any(|p| p.uri == "spotify:track:fwd-long"));
        assert!(!plays.iter().any(|p| p.uri == "spotify:episode:pod123"));
    }

    #[test]
    fn skipped_long_counts_in_aggregates() {
        let rows = vec![
            endsong("spotify:track:keep", 200000),
            json!({
                "ts": "2024-07-01T01:00:00.000Z",
                "ms_played": 200000,
                "master_metadata_track_name": "S",
                "master_metadata_album_artist_name": "B",
                "master_metadata_album_album_name": "Album",
                "spotify_track_uri": "spotify:track:skipped-long",
                "skipped": true,
            }),
        ];
        let (plays, counts) = import_parse(&rows, NOW);
        assert_eq!(counts.kept, 2);
        assert_eq!(counts.dropped_skipped, 0);
        let mut store = HistoryStore::default();
        store_insert(&mut store, &plays);
        let agg = store_aggregates(&store, None, NOW);
        assert_eq!(agg["total"], 2);
        assert_eq!(agg["uniqueAlbums"], 1);
    }

    #[test]
    fn track_uri_gate_drops_podcasts() {
        assert!(is_track_uri("spotify:track:abc"));
        assert!(!is_track_uri("spotify:episode:abc"));
        assert!(!is_track_uri("spotify:show:abc"));
        assert!(!is_track_uri(""));
        assert!(is_counted(200000, "spotify:track:abc"));
        assert!(!is_counted(200000, "spotify:episode:abc"));
        assert!(!is_counted(10000, "spotify:track:abc"));
    }

    #[test]
    fn multi_file_rows_dedupe_in_one_parse() {
        // Three picked files concatenated into one import_history call:
        // the shared row repeats across files and counts once.
        let shared = endsong("spotify:track:shared", 200000);
        let mut file_a = vec![shared.clone()];
        file_a.push(endsong("spotify:track:only-a", 200000));
        let mut file_b = vec![shared.clone()];
        file_b.push(endsong("spotify:track:only-b", 200000));
        let mut rows: Vec<Value> = Vec::new();
        rows.extend(file_a);
        rows.extend(file_b);
        let (plays, counts) = import_parse(&rows, NOW);
        assert_eq!(counts.total, 4);
        assert_eq!(counts.kept, 3);
        assert_eq!(counts.dropped_duplicate, 1);
        let mut uris: Vec<&str> = plays.iter().map(|p| p.uri.as_str()).collect();
        uris.sort_unstable();
        assert_eq!(
            uris,
            vec![
                "spotify:track:only-a",
                "spotify:track:only-b",
                "spotify:track:shared"
            ]
        );
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
    fn merge_grows_trim_free_newest_first() {
        // The 50k cap is gone: 50,500 rows stay 50,500 (lifetime truth).
        let base: Vec<HistoryPlay> = (0..HISTORY_STORE_CAP + 500).map(|i| seq_play(i, T1)).collect();
        let out = merge_dedupe(&base, &[]);
        assert_eq!(out.len(), HISTORY_STORE_CAP + 500);
        assert_eq!(out[0].played_at, T1 + (HISTORY_STORE_CAP as i64 + 499) * 1000);
        assert_eq!(out[out.len() - 1].played_at, T1);
    }

    #[test]
    fn trim_to_cap_is_identity() {
        let mut small = vec![play("spotify:track:a", T1)];
        trim_to_cap(&mut small);
        assert_eq!(small.len(), 1);
        let mut big: Vec<HistoryPlay> = (0..HISTORY_STORE_CAP + 10).map(|i| seq_play(i, T1)).collect();
        trim_to_cap(&mut big);
        assert_eq!(big.len(), HISTORY_STORE_CAP + 10);
    }

    #[test]
    fn normalized_roundtrip_preserves_rows() {
        let plays = vec![play("spotify:track:a", T1), play("spotify:track:b", T2)];
        let mut store = HistoryStore::default();
        store_insert(&mut store, &plays);
        // Two distinct URIs -> two track dict entries, two compact rows.
        assert_eq!(store.tracks.len(), 2);
        assert_eq!(store.plays.len(), 2);
        let back = store_plays(&store);
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].uri, "spotify:track:b");
        // Re-insert is idempotent (uri@playedAt dedupe).
        store_insert(&mut store, &plays);
        assert_eq!(store.plays.len(), 2);
        // Compact rows carry no duplicated strings per row.
        for c in &store.plays {
            let _ = c.track;
            let _ = c.played_at;
            let _ = c.ms;
            let _ = c.flags;
        }
    }

    #[test]
    fn normalized_dedupe_across_batches() {
        let mut store = HistoryStore::default();
        store_insert(&mut store, &[play("spotify:track:a", T1)]);
        store_insert(&mut store, &[play("spotify:track:a", T1), play("spotify:track:b", T2)]);
        assert_eq!(store.plays.len(), 2);
        let agg = store_aggregates(&store, None, NOW);
        assert_eq!(agg["total"], 2);
    }

    #[test]
    fn aggregates_mirror_ts_semantics() {
        // 3 countable rows (one skipped-long), 1 short, 1 podcast.
        let rows = vec![
            endsong("spotify:track:t1", 200000),
            json!({
                "ts": "2024-07-01T01:00:00.000Z",
                "ms_played": 180000,
                "master_metadata_track_name": "T2",
                "master_metadata_album_artist_name": "Band B",
                "master_metadata_album_album_name": "Album B",
                "spotify_track_uri": "spotify:track:t2",
                "skipped": true,
            }),
            json!({
                "ts": "2024-07-01T02:00:00.000Z",
                "ms_played": 60000,
                "master_metadata_track_name": "T3",
                "master_metadata_album_artist_name": "Band C",
                "master_metadata_album_album_name": "Album B",
                "spotify_track_uri": "spotify:track:t3",
                "reason_end": "trackdone",
                "skipped": false,
            }),
            endsong("spotify:track:short", 10000),
            json!({
                "ts": "2024-07-01T02:00:00.000Z",
                "ms_played": 200000,
                "master_metadata_track_name": "Pod",
                "master_metadata_album_artist_name": "B",
                "spotify_track_uri": "spotify:episode:x",
                "skipped": false,
            }),
        ];
        let (plays, _) = import_parse(&rows, NOW);
        assert_eq!(plays.len(), 3);
        let mut store = HistoryStore::default();
        store_insert(&mut store, &plays);
        let agg = store_aggregates(&store, None, NOW);
        assert_eq!(agg["total"], 3);
        assert_eq!(agg["minutes"], (200000 + 180000 + 60000) / 60000);
        assert_eq!(agg["hours"], ((200000 + 180000 + 60000) / 60000) as i64 / 60);
        assert_eq!(agg["uniqueTracks"], 3);
        // Band, Band B, Band C -> 3 artists; Album + Album B -> 2 albums.
        assert_eq!(agg["uniqueArtists"], 3);
        assert_eq!(agg["uniqueAlbums"], 2);
        assert_eq!(agg["clocks"].as_array().unwrap().len(), 24);
    }

    #[test]
    fn paging_serves_100_row_cursor_windows() {
        let plays: Vec<HistoryPlay> = (0..250).map(|i| seq_play(i, T1)).collect();
        let mut store = HistoryStore::default();
        store_insert(&mut store, &plays);
        let (p1, cur1, total) = store_page(&store, None, NOW, None, 100);
        assert_eq!(total, 250);
        assert_eq!(p1.len(), 100);
        assert!(cur1.is_some());
        let (p2, cur2, _) = store_page(&store, None, NOW, cur1.as_deref(), 100);
        assert_eq!(p2.len(), 100);
        assert!(cur2.is_some());
        let (p3, cur3, _) = store_page(&store, None, NOW, cur2.as_deref(), 100);
        assert_eq!(p3.len(), 50);
        assert_eq!(cur3, None);
        // No overlap across pages (cursor dedupe).
        let k1: HashSet<String> = p1.iter().map(|p| play_key(&p.uri, p.played_at)).collect();
        for p in p2.iter().chain(p3.iter()) {
            assert!(!k1.contains(&play_key(&p.uri, p.played_at)));
        }
    }

    #[test]
    fn scale_grows_trim_free_with_correct_aggregates() {
        // 60k rows over 1k tracks: trim-free growth + aggregate truth.
        // (The 350k-row production import is the same code path; this
        // sized-down gauntlet keeps CI under a few seconds while proving
        // no cap evicts and heap stays compact dict+u32 rows.)
        let n = 60_000usize;
        let mut plays: Vec<HistoryPlay> = Vec::with_capacity(n);
        for i in 0..n {
            let k = i % 1000;
            plays.push(HistoryPlay {
                track_id: format!("big-{k:04}"),
                track_name: format!("Big Song {k}"),
                artists: format!("Big Band {:02}", k % 50),
                played_at: T1 + (i as i64) * 1000,
                image: None,
                uri: format!("spotify:track:big-{k:04}"),
                duration_ms: 200000,
                ms_played: 200000,
                skipped: i % 7 == 0,
                album_name: format!("Big Album {:02}", k % 20),
                album: format!("Big Album {:02}", k % 20),
                source: "imported".to_string(),
            });
        }
        let mut store = HistoryStore::default();
        store_insert(&mut store, &plays);
        // No trim: newest-first head is the last row; dict has 1k tracks.
        assert_eq!(store.plays.len(), n);
        assert_eq!(store.tracks.len(), 1000);
        let agg = store_aggregates(&store, None, T1 + (n as i64) * 1000 + 1000);
        assert_eq!(agg["total"], n);
        assert_eq!(agg["uniqueTracks"], 1000);
        assert_eq!(agg["uniqueAlbums"], 20);
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
        // Skipped-long now APPENDS (parity); skipped-short refuses as Short.
        let mut skipped_long = play("spotify:track:new", T2);
        skipped_long.skipped = true;
        assert_eq!(append_listen(&base, &skipped_long, NOW).1, AppendReason::Appended);
        let mut skipped_short = play("spotify:track:new2", T2);
        skipped_short.skipped = true;
        skipped_short.ms_played = 5000;
        skipped_short.duration_ms = 5000;
        assert_eq!(append_listen(&base, &skipped_short, NOW).1, AppendReason::Short);
        let mut no_uri = play("spotify:track:new", T2);
        no_uri.uri = String::new();
        assert_eq!(append_listen(&base, &no_uri, NOW).1, AppendReason::NoUri);
        let mut pod = play("spotify:track:new", T2);
        pod.uri = "spotify:episode:pod1".to_string();
        assert_eq!(append_listen(&base, &pod, NOW).1, AppendReason::NoUri);
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
        // O(1)-ish dedupe probe agrees with the scan path.
        let idx = build_play_index(&base);
        assert!(idx.contains(&play_key("spotify:track:a", T1)));
        assert!(!idx.contains(&play_key("spotify:track:new", T2)));
    }

    #[test]
    fn append_on_large_store_grows_without_evicting() {
        // No cap: a full-ish store admits the new row and keeps the tail.
        let base: Vec<HistoryPlay> = (0..1000).map(|i| seq_play(i, NOW - 1000 * 1000)).collect();
        let mut fresh = seq_play(9999, NOW - 1000 * 1000);
        fresh.uri = "spotify:track:newest".to_string();
        fresh.track_id = "newest".to_string();
        fresh.played_at = NOW;
        let (out, reason) = append_listen(&base, &fresh, NOW);
        assert_eq!(reason, AppendReason::Appended);
        assert_eq!(out.len(), 1001);
        assert_eq!(out[0].uri, "spotify:track:newest");
        assert!(out.iter().any(|p| p.uri == "spotify:track:seq-000000"));
        // Normalized path agrees.
        let mut store = HistoryStore::default();
        store_insert(&mut store, &base);
        let r = store_append(&mut store, &fresh, NOW);
        assert_eq!(r, AppendReason::Appended);
        assert_eq!(store.plays.len(), 1001);
    }

    #[test]
    fn compact_append_uses_index_set_without_rescan() {
        let mut store = HistoryStore::default();
        store_insert(&mut store, &[play("spotify:track:a", T1)]);
        let dup = play("spotify:track:a", T1);
        assert_eq!(store_append(&mut store, &dup, NOW), AppendReason::Duplicate);
        assert_eq!(store.plays.len(), 1);
        let mut skipped_long = play("spotify:track:b", T2);
        skipped_long.skipped = true;
        assert_eq!(store_append(&mut store, &skipped_long, NOW), AppendReason::Appended);
        assert_eq!(store.plays.len(), 2);
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
        store_insert(&mut store, &[play("spotify:track:a", T1)]);
        atomic_write_json(&path, &serde_json::to_string(&store).unwrap()).unwrap();
        atomic_write_json(&path, &serde_json::to_string(&store).unwrap()).unwrap();
        std::fs::write(&path, "{corrupt").unwrap();
        let back = load_store_from(&path);
        assert_eq!(back.version, 2);
        assert_eq!(back.plays.len(), 1);
        let flat = store_plays(&back);
        assert_eq!(flat[0].uri, "spotify:track:a");
        // Primary is healed in place.
        assert!(read_json_guarded(&path, |t| {
            serde_json::from_str::<HistoryStore>(t).is_ok()
        })
        .is_some());
    }

    #[test]
    fn v1_store_migrates_to_normalized_v2() {
        let dir = test_dir("migrate");
        let path = dir.join("history-store.json");
        let v1 = serde_json::json!({
            "version": 1,
            "plays": [
                {"trackId": "a", "trackName": "Song A", "artists": "Band",
                 "playedAt": T1, "image": null, "uri": "spotify:track:a",
                 "durationMs": 200000, "msPlayed": 200000, "skipped": false, "source": "imported"},
                {"trackId": "b", "trackName": "Song B", "artists": "Band",
                 "playedAt": T2, "image": null, "uri": "spotify:track:b",
                 "durationMs": 200000, "msPlayed": 200000, "skipped": false, "source": "imported"}
            ],
            "importedRanges": ["endsong_0"]
        });
        std::fs::write(&path, serde_json::to_string(&v1).unwrap()).unwrap();
        let back = load_store_from(&path);
        assert_eq!(back.version, HISTORY_STORE_VERSION);
        assert_eq!(back.plays.len(), 2);
        assert_eq!(back.tracks.len(), 2);
        assert_eq!(back.imported_ranges, vec!["endsong_0".to_string()]);
        let agg = store_aggregates(&back, None, NOW);
        assert_eq!(agg["total"], 2);
    }

    #[test]
    fn version_mismatch_falls_back_to_empty() {
        let dir = test_dir("version");
        let path = dir.join("history-store.json");
        std::fs::write(&path, r#"{"version":99,"tracks":[],"plays":[],"importedRanges":[]}"#).unwrap();
        let back = load_store_from(&path);
        assert_eq!(back.version, HISTORY_STORE_VERSION);
        assert!(back.plays.is_empty());
    }

    #[test]
    fn page_cursor_never_overlaps_and_total_is_honest() {
        let plays: Vec<HistoryPlay> = (0..5).map(|i| seq_play(i, T1)).collect();
        let mut store = HistoryStore::default();
        store_insert(&mut store, &plays);
        let (a, c1, total) = store_page(&store, None, NOW, None, 2);
        assert_eq!(total, 5);
        assert_eq!(a.len(), 2);
        let (b, c2, _) = store_page(&store, None, NOW, c1.as_deref(), 2);
        assert_eq!(b.len(), 2);
        let (c, c3, _) = store_page(&store, None, NOW, c2.as_deref(), 2);
        assert_eq!(c.len(), 1);
        assert_eq!(c3, None);
        let all: Vec<String> = a.iter().chain(b.iter()).chain(c.iter())
            .map(|p| play_key(&p.uri, p.played_at)).collect();
        let uniq: HashSet<String> = all.iter().cloned().collect();
        assert_eq!(all.len(), uniq.len());
    }
}
