import type { LyricCue, LyricWord } from "./types";

/** Last cue with t <= now. Returns -1 when nothing is active yet. */
export function activeCueIndex(cues: LyricCue[], nowMs: number): number {
  return activeIndex(cues, nowMs);
}

/** Last word with t <= now. Returns -1 when nothing is active yet. */
export function activeWordIndex(words: LyricWord[], nowMs: number): number {
  return activeIndex(words, nowMs);
}

function activeIndex(items: Array<{ t: number }>, nowMs: number): number {
  let lo = 0;
  let hi = items.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].t <= nowMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function parseTimestamp(s: string): number | null {
  // mm:ss.xx or mm:ss.xxx
  const colon = s.indexOf(":");
  if (colon < 0 || s.indexOf(":", colon + 1) >= 0) return null;
  const min = Number(s.slice(0, colon));
  const rest = s.slice(colon + 1);
  if (!Number.isInteger(min) || min < 0) return null;
  const dot = rest.indexOf(".");
  const secStr = dot < 0 ? rest : rest.slice(0, dot);
  const fracStr = dot < 0 ? "" : rest.slice(dot + 1);
  if (!/^\d+$/.test(secStr)) return null;
  if (fracStr !== "" && !/^\d+$/.test(fracStr)) return null;
  const sec = Number(secStr);
  let ms = 0;
  if (fracStr.length === 1) ms = Number(fracStr) * 100;
  else if (fracStr.length === 2) ms = Number(fracStr) * 10;
  else if (fracStr.length >= 3) ms = Number(fracStr.slice(0, 3));
  return min * 60_000 + sec * 1000 + ms;
}

const WORD_TAG_RE = /<(\d{1,3}:\d{2}(?:\.\d{1,3})?)>/g;

/**
 * Parses LRC text into sorted cues. Mirrors the Rust `parse_lrc` in
 * src-tauri/src/lyrics.rs: expands multi-tag lines, applies
 * [offset:+/-ms], drops ID tags and malformed lines, and additionally
 * extracts inline `<mm:ss.xx>` word tags (enhanced LRC) into
 * `cue.words`. Lines without word tags leave `words` undefined so the
 * renderer falls back to linear interpolation.
 */
export function parseLrc(text: string): LyricCue[] {
  const cues: LyricCue[] = [];
  let offset = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim().replace(/\r$/, "");
    if (!line) continue;
    // Global offset tag.
    if (line.startsWith("[offset:") && line.endsWith("]")) {
      const v = Number(line.slice(8, -1));
      if (Number.isFinite(v) && Number.isInteger(v)) offset = v;
      continue;
    }
    // Collect leading [..] tags.
    const tags: string[] = [];
    let rest = line;
    while (rest.startsWith("[")) {
      const end = rest.indexOf("]");
      if (end < 0) break;
      tags.push(rest.slice(1, end));
      rest = rest.slice(end + 1).trimStart();
    }
    if (tags.length === 0) continue;
    const times: number[] = [];
    for (const t of tags) {
      const ms = parseTimestamp(t);
      if (ms !== null) times.push(ms);
    }
    if (times.length === 0) continue;
    // Inline word timing: "<00:12.00>word <00:12.40>next".
    let words: LyricWord[] | undefined;
    WORD_TAG_RE.lastIndex = 0;
    const marks: Array<{ t: number; at: number; end: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = WORD_TAG_RE.exec(rest)) !== null) {
      const ms = parseTimestamp(m[1]);
      if (ms !== null) marks.push({ t: ms + offset, at: m.index, end: m.index + m[0].length });
    }
    if (marks.length > 0) {
      const built: LyricWord[] = marks.map((mk, i) => {
        const textStart = mk.end;
        const textEnd = i + 1 < marks.length ? marks[i + 1].at : rest.length;
        return { t: mk.t, text: rest.slice(textStart, textEnd).trim() };
      });
      // Keep only words that carry text; a tag-only tail is a line end.
      const kept = built.filter((w) => w.text !== "");
      if (kept.length > 0) words = kept;
    }
    const plain = rest.replace(WORD_TAG_RE, "").replace(/\s+/g, " ").trim();
    for (const t of times) {
      const cue: LyricCue = { t: t + offset, text: plain };
      if (words) cue.words = words.map((w) => ({ ...w }));
      cues.push(cue);
    }
  }
  cues.sort((a, b) => a.t - b.t);
  return cues;
}
