use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct LyricWord {
    pub t: i64,
    pub text: String,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct LyricCue {
    pub t: i64,
    pub text: String,
    /// True word timing when the provider ships it (LRCLIB enhanced /
    /// inline word tags). `None` means the frontend falls back to linear
    /// interpolation. `#[serde(default)]` keeps pre-word caches readable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<LyricWord>>,
}

#[derive(Clone, serde::Serialize)]
pub struct LyricsResult {
    pub track_id: String,
    pub synced: bool,
    pub instrumental: bool,
    pub cues: Vec<LyricCue>,
    pub plain: Option<String>,
    pub cached: bool,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct CacheEntry {
    track_id: String,
    duration_ms: i64,
    synced: bool,
    instrumental: bool,
    cues: Vec<LyricCue>,
    plain: Option<String>,
    fetched_at: u64,
    negative: bool,
    /// Per-track user calibration in ms, set from the LyricsPane stepper.
    /// The cache key already embeds `duration_ms`, so a duration change
    /// keys a fresh entry and the old offset is invalidated with it.
    /// `#[serde(default)]` keeps pre-offset caches readable.
    #[serde(default)]
    user_offset_ms: i64,
    /// Last serve time for true-LRU eviction. Pre-LRU entries read 0 and
    /// fall back to `fetched_at` via `effective_recency`.
    #[serde(default)]
    last_access: u64,
}

/// Max tracks held on disk. Eviction is access-ordered (LRU).
const MAX_CACHED_TRACKS: usize = 500;

fn effective_recency(e: &CacheEntry) -> u64 {
    e.last_access.max(e.fetched_at)
}

/// Drops the least-recently-used entries beyond the cap, in place.
fn trim_to_cap(map: &mut HashMap<String, CacheEntry>) {
    if (map.len()) <= MAX_CACHED_TRACKS {
        return;
    }
    let mut keys: Vec<(String, u64)> = map
        .iter()
        .map(|(k, e)| (k.clone(), effective_recency(e)))
        .collect();
    keys.sort_by_key(|(_, r)| *r);
    let drop = map.len() - MAX_CACHED_TRACKS;
    for (k, _) in keys.into_iter().take(drop) {
        map.remove(&k);
    }
}

/// Shifts served cue (and word) timing by the user's calibration.
/// Stored cues stay unshifted so the offset remains adjustable.
fn apply_user_offset(cues: &[LyricCue], offset_ms: i64) -> Vec<LyricCue> {
    if offset_ms == 0 {
        return cues.to_vec();
    }
    cues.iter()
        .map(|c| LyricCue {
            t: c.t + offset_ms,
            text: c.text.clone(),
            words: c.words.as_ref().map(|ws| {
                ws.iter()
                    .map(|w| LyricWord {
                        t: w.t + offset_ms,
                        text: w.text.clone(),
                    })
                    .collect()
            }),
        })
        .collect()
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn cache_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join("lyrics-cache.json"))
}

fn read_cache(app: &AppHandle) -> HashMap<String, CacheEntry> {
    let path = match cache_path(app) {
        Some(p) => p,
        None => return HashMap::new(),
    };
    let text = fs::read_to_string(path).unwrap_or_default();
    if text.is_empty() {
        return HashMap::new();
    }
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_cache(app: &AppHandle, map: &HashMap<String, CacheEntry>) {
    if let Some(path) = cache_path(app) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        // Cap at 500 entries, keep most-recently-used (true LRU: hits
        // bump `last_access` in `get_lyrics`, so hot tracks survive).
        let mut owned: HashMap<String, CacheEntry> =
            map.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        trim_to_cap(&mut owned);
        if let Ok(text) = serde_json::to_string(&owned) {
            let _ = fs::write(path, text);
        }
    }
}

fn cache_key(track_id: &str, duration_ms: i64) -> String {
    format!("spotify:{track_id}:{duration_ms}")
}

fn parse_timestamp(s: &str) -> Option<i64> {
    // mm:ss.xx or mm:ss.xxx
    let mut parts = s.split(':');
    let min: i64 = parts.next()?.parse().ok()?;
    let rest = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let mut sec_parts = rest.split('.');
    let sec: i64 = sec_parts.next()?.parse().ok()?;
    let frac = sec_parts.next().unwrap_or("0");
    let ms: i64 = match frac.len() {
        0 => 0,
        1 => frac.parse::<i64>().ok()? * 100,
        2 => frac.parse::<i64>().ok()? * 10,
        _ => frac[..3].parse::<i64>().ok()?,
    };
    if sec_parts.next().is_some() {
        return None;
    }
    Some(min * 60_000 + sec * 1000 + ms)
}

/// Scans a line body for inline `<mm:ss.xx>` word tags (enhanced LRC).
/// Returns `(word_time, tag_start_byte, tag_end_byte)` per tag.
fn scan_word_marks(rest: &str, offset: i64) -> Vec<(i64, usize, usize)> {
    let mut marks: Vec<(i64, usize, usize)> = Vec::new();
    let mut i = 0;
    while i < rest.len() {
        let tail = &rest[i..];
        if tail.starts_with('<') {
            match tail.find('>') {
                Some(rel) => {
                    let inner = &tail[1..rel];
                    if let Some(ms) = parse_timestamp(inner) {
                        marks.push((ms + offset, i, i + rel + 1));
                    }
                    i += rel + 1;
                }
                None => break,
            }
        } else {
            i += tail.chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        }
    }
    marks
}

/// Strips `<mm:ss.xx>` word tags and collapses whitespace so the line
/// text matches the pre-word rendering exactly.
fn strip_word_tags(rest: &str) -> String {
    let mut out = String::with_capacity(rest.len());
    let mut i = 0;
    while i < rest.len() {
        let tail = &rest[i..];
        if tail.starts_with('<') {
            match tail.find('>') {
                Some(rel) => {
                    if parse_timestamp(&tail[1..rel]).is_some() {
                        i += rel + 1;
                        continue;
                    }
                    out.push('<');
                    i += 1;
                }
                None => {
                    out.push_str(tail);
                    break;
                }
            }
        } else {
            let c = tail.chars().next().unwrap_or(' ');
            out.push(c);
            i += c.len_utf8();
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Parses LRC text into sorted cues. Expands multi-tag lines, applies
/// [offset:+/-ms], drops ID tags and malformed lines. Extracts inline
/// `<mm:ss.xx>` word tags (enhanced LRC) into `LyricCue.words`; lines
/// without word tags leave `words` as `None` so the frontend falls back
/// to linear interpolation.
pub fn parse_lrc(text: &str) -> Vec<LyricCue> {
    let mut cues: Vec<LyricCue> = Vec::new();
    let mut offset: i64 = 0;
    for raw_line in text.lines() {
        let line = raw_line.trim().trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        // Global offset tag.
        if line.starts_with("[offset:") && line.ends_with(']') {
            if let Ok(v) = line[8..line.len() - 1].parse::<i64>() {
                offset = v;
            }
            continue;
        }
        // Collect leading [..] tags.
        let mut tags: Vec<String> = Vec::new();
        let mut rest = line;
        while rest.starts_with('[') {
            if let Some(end) = rest.find(']') {
                tags.push(rest[1..end].to_string());
                rest = rest[end + 1..].trim_start();
            } else {
                break;
            }
        }
        if tags.is_empty() {
            continue;
        }
        // Skip pure ID tags (ti, ar, al, au, length, by, re, ve).
        let times: Vec<i64> = tags.iter().filter_map(|t| parse_timestamp(t)).collect();
        if times.is_empty() {
            continue;
        }
        // Inline word timing: "[00:10.00]<00:10.00>hello <00:10.40>world".
        let marks = scan_word_marks(rest, offset);
        let words: Option<Vec<LyricWord>> = if marks.is_empty() {
            None
        } else {
            let mut built: Vec<LyricWord> = Vec::new();
            for (idx, (t, _, end)) in marks.iter().enumerate() {
                let text_end = if idx + 1 < marks.len() {
                    marks[idx + 1].1
                } else {
                    rest.len()
                };
                let text = rest[*end..text_end].trim().to_string();
                if !text.is_empty() {
                    built.push(LyricWord { t: *t, text });
                }
            }
            if built.is_empty() { None } else { Some(built) }
        };
        let text = strip_word_tags(rest);
        for t in times {
            cues.push(LyricCue {
                t: t + offset,
                text: text.clone(),
                words: words.clone(),
            });
        }
    }
    cues.sort_by_key(|c| c.t);
    cues
}

async fn lrclib_get(
    track: &str,
    artist: &str,
    album: &str,
    duration_secs: i64,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .user_agent("snapify-overlay/1.0.0 (desktop overlay)")
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get("https://lrclib.net/api/get")
        .query(&[
            ("track_name", track),
            ("artist_name", artist),
            ("album_name", album),
            ("duration", &duration_secs.to_string()),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("not-found".into());
    }
    if res.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("lyrics rate-limited".into());
    }
    if !res.status().is_success() {
        return Err(format!("lyrics lookup failed: {}", res.status()));
    }
    res.json().await.map_err(|e| e.to_string())
}

async fn lrclib_search(
    track: &str,
    artist: &str,
    album: &str,
    duration_ms: i64,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .user_agent("snapify-overlay/1.0.0 (desktop overlay)")
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get("https://lrclib.net/api/search")
        .query(&[
            ("track_name", track),
            ("artist_name", artist),
            ("album_name", album),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("lyrics search failed: {}", res.status()));
    }
    let list: Vec<serde_json::Value> = res.json().await.map_err(|e| e.to_string())?;
    // Closest duration wins.
    let mut best: Option<&serde_json::Value> = None;
    let mut best_gap = i64::MAX;
    for item in &list {
        let d = item
            .get("duration")
            .and_then(|v| v.as_f64())
            .map(|s| (s * 1000.0) as i64)
            .unwrap_or(0);
        let gap = (d - duration_ms).abs();
        if gap < best_gap {
            best_gap = gap;
            best = Some(item);
        }
    }
    match best {
        Some(v) if best_gap <= 10_000 => Ok(v.clone()),
        _ => Err("not-found".into()),
    }
}

fn entry_to_result(track_id: &str, e: &CacheEntry, cached: bool) -> LyricsResult {
    LyricsResult {
        track_id: track_id.to_string(),
        synced: e.synced,
        instrumental: e.instrumental,
        cues: apply_user_offset(&e.cues, e.user_offset_ms),
        plain: e.plain.clone(),
        cached,
    }
}

fn value_to_entry(
    track_id: &str,
    duration_ms: i64,
    v: &serde_json::Value,
    user_offset_ms: i64,
) -> CacheEntry {
    let instrumental = v
        .get("instrumental")
        .and_then(|b| b.as_bool())
        .unwrap_or(false);
    // LRCLIB enhanced payload first (true word timing), plain synced
    // LRC second. Either may carry inline `<mm:ss.xx>` word tags; when
    // neither does, cues keep `words: None` and the frontend
    // interpolates as before.
    let synced_text = v
        .get("enhancedSyncedLyrics")
        .and_then(|s| s.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            v.get("syncedLyrics")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string()
        });
    let plain = v
        .get("plainLyrics")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());
    let cues = if synced_text.trim().is_empty() {
        Vec::new()
    } else {
        parse_lrc(&synced_text)
    };
    CacheEntry {
        track_id: track_id.to_string(),
        duration_ms,
        synced: !cues.is_empty(),
        instrumental,
        cues,
        plain,
        fetched_at: now_unix(),
        negative: false,
        user_offset_ms,
        last_access: now_unix(),
    }
}

#[cfg(test)]
mod tests {
    use super::{apply_user_offset, parse_lrc, trim_to_cap, CacheEntry, LyricCue};

    fn entry(key_recency: u64) -> CacheEntry {
        CacheEntry {
            track_id: "t".into(),
            duration_ms: 180_000,
            synced: true,
            instrumental: false,
            cues: Vec::new(),
            plain: None,
            fetched_at: key_recency,
            negative: false,
            user_offset_ms: 0,
            last_access: 0,
        }
    }

    #[test]
    fn parses_basic_lines_in_order() {
        let cues = parse_lrc("[00:12.00]first\n[00:05.50]second\n");
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].t, 5_500);
        assert_eq!(cues[0].text, "second");
        assert_eq!(cues[1].t, 12_000);
    }

    #[test]
    fn expands_multi_tag_lines_and_applies_offset() {
        let cues = parse_lrc("[offset:+500]\n[00:10.00][00:20.000]chorus\n");
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].t, 10_500);
        assert_eq!(cues[1].t, 20_500);
        assert_eq!(cues[1].text, "chorus");
    }

    #[test]
    fn drops_id_tags_and_malformed_lines() {
        let cues = parse_lrc("[ti:Title]\n[ar:Artist]\nno tags here\n[99]bad\n[00:01.00]ok\n");
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "ok");
    }

    #[test]
    fn keeps_empty_text_as_gap() {
        let cues = parse_lrc("[00:01.00]\n[00:02.00]words\n");
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].text, "");
        assert!(cues[0].words.is_none());
    }

    #[test]
    fn plain_lines_carry_no_words() {
        let cues = parse_lrc("[00:01.00]plain line\n");
        assert_eq!(cues.len(), 1);
        assert!(cues[0].words.is_none());
    }

    #[test]
    fn extracts_inline_word_tags_and_strips_them_from_text() {
        let cues = parse_lrc("[00:10.00]<00:10.00>hello <00:10.40>world\n");
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "hello world");
        let words = cues[0].words.clone().expect("words parsed");
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].t, 10_000);
        assert_eq!(words[0].text, "hello");
        assert_eq!(words[1].t, 10_400);
        assert_eq!(words[1].text, "world");
    }

    #[test]
    fn word_times_follow_the_global_offset() {
        let cues = parse_lrc("[offset:-200]\n[00:10.00]<00:10.00>hi <00:10.50>there\n");
        assert_eq!(cues[0].t, 9_800);
        let words = cues[0].words.clone().expect("words parsed");
        assert_eq!(words[0].t, 9_800);
        assert_eq!(words[1].t, 10_300);
    }

    #[test]
    fn user_offset_shifts_cues_and_words() {
        let cues = vec![LyricCue {
            t: 10_000,
            text: "hi".into(),
            words: Some(vec![super::LyricWord {
                t: 10_200,
                text: "hi".into(),
            }]),
        }];
        let shifted = apply_user_offset(&cues, 500);
        assert_eq!(shifted[0].t, 10_500);
        assert_eq!(shifted[0].words.as_ref().unwrap()[0].t, 10_700);
        // Stored cues stay unshifted; zero offset clones as-is.
        assert_eq!(cues[0].t, 10_000);
        let same = apply_user_offset(&cues, 0);
        assert_eq!(same[0].t, 10_000);
    }

    #[test]
    fn trim_keeps_most_recently_used_within_cap() {
        use std::collections::HashMap;
        let mut map: HashMap<String, CacheEntry> = HashMap::new();
        for i in 0..505 {
            let mut e = entry(i);
            // Entry 0 was fetched first but served most recently: the
            // LRU bump must rescue it from eviction.
            if i == 0 {
                e.last_access = 10_000;
            }
            map.insert(format!("k{i}"), e);
        }
        trim_to_cap(&mut map);
        assert_eq!(map.len(), 500);
        assert!(map.contains_key("k0"), "recently served entry survives");
        assert!(!map.contains_key("k1"), "stale entry evicted first");
    }

    #[test]
    fn old_entries_without_lru_fields_still_deserialize() {
        let legacy = serde_json::json!({
            "track_id": "t",
            "duration_ms": 180000,
            "synced": true,
            "instrumental": false,
            "cues": [{ "t": 1000, "text": "hi" }],
            "plain": null,
            "fetched_at": 1,
            "negative": false
        });
        let e: CacheEntry = serde_json::from_value(legacy).expect("legacy entry reads");
        assert_eq!(e.user_offset_ms, 0);
        assert_eq!(e.last_access, 0);
        assert!(e.cues[0].words.is_none());
    }
}

#[tauri::command]
pub async fn get_lyrics(
    app: AppHandle,
    track_id: String,
    track_name: String,
    artist_name: String,
    album_name: String,
    duration_ms: i64,
) -> Result<LyricsResult, String> {
    let key = cache_key(&track_id, duration_ms);
    let mut cache = read_cache(&app);
    // TTL-expired entries still donate their user calibration to the
    // refetch below, so a nudge survives cache refresh. A duration
    // change keys a different entry, invalidating the old offset.
    let mut carried_offset: i64 = 0;
    if let Some(e) = cache.get(&key) {
        let age = now_unix().saturating_sub(e.fetched_at);
        let ttl_ok = if e.negative { age < 24 * 3600 } else { age < 30 * 24 * 3600 };
        if ttl_ok {
            // True-LRU access bump: serving refreshes recency so hot
            // tracks survive the 500-track trim in `write_cache`.
            let result = {
                let entry = cache.get_mut(&key).expect("lyrics cache hit");
                entry.last_access = now_unix();
                entry_to_result(&track_id, entry, true)
            };
            write_cache(&app, &cache);
            return Ok(result);
        }
        carried_offset = e.user_offset_ms;
    }

    let duration_secs = duration_ms / 1000;
    let found = match lrclib_get(&track_name, &artist_name, &album_name, duration_secs).await {
        Ok(v) => Ok(v),
        Err(e) if e == "not-found" => {
            // Fallback: search and take the closest-duration candidate.
            lrclib_search(&track_name, &artist_name, &album_name, duration_ms).await
        }
        Err(e) => Err(e),
    };

    match found {
        Ok(v) => {
            let entry = value_to_entry(&track_id, duration_ms, &v, carried_offset);
            let result = entry_to_result(&track_id, &entry, false);
            cache.insert(key, entry);
            write_cache(&app, &cache);
            Ok(result)
        }
        Err(e) if e == "not-found" => {
            cache.insert(
                key,
                CacheEntry {
                    track_id: track_id.clone(),
                    duration_ms,
                    synced: false,
                    instrumental: false,
                    cues: Vec::new(),
                    plain: None,
                    fetched_at: now_unix(),
                    negative: true,
                    user_offset_ms: 0,
                    last_access: now_unix(),
                },
            );
            write_cache(&app, &cache);
            Err("No lyrics found for this track yet.".into())
        }
        Err(e) => Err(e),
    }
}
