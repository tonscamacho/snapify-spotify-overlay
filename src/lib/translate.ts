export type TransLang = "off" | "es" | "fr" | "de" | "pt" | "ja";

export const TRANS_LANGS: Array<{ id: TransLang; label: string }> = [
  { id: "off", label: "Off" },
  { id: "es", label: "Español" },
  { id: "fr", label: "Français" },
  { id: "de", label: "Deutsch" },
  { id: "pt", label: "Português" },
  { id: "ja", label: "日本語" },
];

const STORE_KEY = "snapify-translations-v1";
const MAX_ENTRIES = 200;

type Cache = Record<string, string>;

function load(): Cache {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Cache) : {};
  } catch {
    return {};
  }
}

function persist(cache: Cache): void {
  try {
    const keys = Object.keys(cache);
    if (keys.length > MAX_ENTRIES) {
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete cache[k];
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(cache));
  } catch {
    // Storage full or blocked. Memory cache still serves this session.
  }
}

let mem: Cache | null = null;
function memo(): Cache {
  if (!mem) mem = load();
  return mem;
}

const missCache = new Set<string>();
const MISS_CAP = 500;
function missHas(key: string): boolean {
  return missCache.has(key);
}
function missAdd(key: string): void {
  missCache.add(key);
  if (missCache.size > MISS_CAP) {
    const first = missCache.values().next().value;
    if (first !== undefined) missCache.delete(first);
  }
}

/**
 * Translates one lyric line with source auto-detect via the MyMemory free
 * tier. Cached per line+language (cap 200) so a replay costs nothing.
 * Resolves null on any failure — the caller keeps the original line.
 * A translation identical to the source (e.g. already in the target
 * language) also resolves null so no duplicate line renders.
 */
export async function translateLine(
  text: string,
  lang: Exclude<TransLang, "off">,
  signal?: AbortSignal,
): Promise<string | null> {
  const line = text.trim();
  if (!line) return null;
  const key = `${lang}:${line}`;
  const hit = memo()[key];
  if (hit !== undefined) return hit === "" ? null : hit;
  if (missHas(key)) return null;

  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 8000);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const fail = (): null => {
    missAdd(key);
    return null;
  };
  try {
    // No assumed source language: MyMemory detects it server-side.
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(line)}&langpair=autodetect|${lang}`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return fail();
    const body = (await res.json()) as {
      responseData?: { translatedText?: string };
      responseStatus?: number;
    };
    const out = body.responseData?.translatedText?.trim();
    if (!out || body.responseStatus === 429) return fail();
    // Already in the target language: remember the negative so no
    // duplicate line renders and no request refires.
    if (out.toLowerCase() === line.toLowerCase()) {
      memo()[key] = "";
      persist(memo());
      return null;
    }
    memo()[key] = out;
    persist(memo());
    return out;
  } catch {
    return signal?.aborted ? null : fail();
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Translates a batch of lines with bounded parallelism (default 4),
 * order-preserving. Blanks resolve null without a request; the per-line
 * cache plus miss-set keep it to at most one request per line. Shares one
 * AbortSignal so a track change cancels the whole batch (aborted items
 * resolve null without poisoning the caches).
 */
export async function translateBatch(
  texts: string[],
  lang: Exclude<TransLang, "off">,
  signal?: AbortSignal,
  concurrency = 4,
): Promise<Array<string | null>> {
  const out: Array<string | null> = new Array(texts.length).fill(null);
  let next = 0;
  const workers: Array<Promise<void>> = [];
  const run = async (): Promise<void> => {
    while (next < texts.length) {
      if (signal?.aborted) return;
      const i = next++;
      out[i] = await translateLine(texts[i], lang, signal);
    }
  };
  const n = Math.max(1, Math.min(concurrency, texts.length));
  for (let w = 0; w < n; w++) workers.push(run());
  await Promise.all(workers);
  return out;
}

// ---------- romaji / transliteration ----------

// [romaji, hiragana, katakana] per mora. Covers gojuon, dakuten,
// handakuten, yoon digraphs (via the trailing-i + small ya/yu/yo rule
// in toRomaji), vu, and the small-ka counter forms.
const KANA_ROWS: Array<[string, string, string]> = [
  ["a", "あ", "ア"], ["i", "い", "イ"], ["u", "う", "ウ"], ["e", "え", "エ"], ["o", "お", "オ"],
  ["ka", "か", "カ"], ["ki", "き", "キ"], ["ku", "く", "ク"], ["ke", "け", "ケ"], ["ko", "こ", "コ"],
  ["sa", "さ", "サ"], ["shi", "し", "シ"], ["su", "す", "ス"], ["se", "せ", "セ"], ["so", "そ", "ソ"],
  ["ta", "た", "タ"], ["chi", "ち", "チ"], ["tsu", "つ", "ツ"], ["te", "て", "テ"], ["to", "と", "ト"],
  ["na", "な", "ナ"], ["ni", "に", "ニ"], ["nu", "ぬ", "ヌ"], ["ne", "ね", "ネ"], ["no", "の", "ノ"],
  ["ha", "は", "ハ"], ["hi", "ひ", "ヒ"], ["fu", "ふ", "フ"], ["he", "へ", "ヘ"], ["ho", "ほ", "ホ"],
  ["ma", "ま", "マ"], ["mi", "み", "ミ"], ["mu", "む", "ム"], ["me", "め", "メ"], ["mo", "も", "モ"],
  ["ya", "や", "ヤ"], ["yu", "ゆ", "ユ"], ["yo", "よ", "ヨ"],
  ["ra", "ら", "ラ"], ["ri", "り", "リ"], ["ru", "る", "ル"], ["re", "れ", "レ"], ["ro", "ろ", "ロ"],
  ["wa", "わ", "ワ"], ["wo", "を", "ヲ"], ["n", "ん", "ン"],
  ["ga", "が", "ガ"], ["gi", "ぎ", "ギ"], ["gu", "ぐ", "グ"], ["ge", "げ", "ゲ"], ["go", "ご", "ゴ"],
  ["za", "ざ", "ザ"], ["ji", "じ", "ジ"], ["zu", "ず", "ズ"], ["ze", "ぜ", "ゼ"], ["zo", "ぞ", "ゾ"],
  ["da", "だ", "ダ"], ["de", "で", "デ"], ["do", "ど", "ド"],
  ["ba", "ば", "バ"], ["bi", "び", "ビ"], ["bu", "ぶ", "ブ"], ["be", "べ", "ベ"], ["bo", "ぼ", "ボ"],
  ["pa", "ぱ", "パ"], ["pi", "ぴ", "ピ"], ["pu", "ぷ", "プ"], ["pe", "ぺ", "ペ"], ["po", "ぽ", "ポ"],
  ["kya", "きゃ", "キャ"], ["kyu", "きゅ", "キュ"], ["kyo", "きょ", "キョ"],
  ["sha", "しゃ", "シャ"], ["shu", "しゅ", "シュ"], ["sho", "しょ", "ショ"],
  ["cha", "ちゃ", "チャ"], ["chu", "ちゅ", "チュ"], ["cho", "ちょ", "チョ"],
  ["nya", "にゃ", "ニャ"], ["nyu", "にゅ", "ニュ"], ["nyo", "にょ", "ニョ"],
  ["hya", "ひゃ", "ヒャ"], ["hyu", "ひゅ", "ヒュ"], ["hyo", "ひょ", "ヒョ"],
  ["mya", "みゃ", "ミャ"], ["myu", "みゅ", "ミュ"], ["myo", "みょ", "ミョ"],
  ["rya", "りゃ", "リャ"], ["ryu", "りゅ", "リュ"], ["ryo", "りょ", "リョ"],
  ["gya", "ぎゃ", "ギャ"], ["gyu", "ぎゅ", "ギュ"], ["gyo", "ぎょ", "ギョ"],
  ["ja", "じゃ", "ジャ"], ["ju", "じゅ", "ジュ"], ["jo", "じょ", "ジョ"],
  ["bya", "びゃ", "ビャ"], ["byu", "びゅ", "ビュ"], ["byo", "びょ", "ビョ"],
  ["pya", "ぴゃ", "ピャ"], ["pyu", "ぴゅ", "ピュ"], ["pyo", "ぴょ", "ピョ"],
  ["vu", "ゔ", "ヴ"], ["ka", "ヵ", "ヶ"],
  ["a", "ぁ", "ァ"], ["i", "ぃ", "ィ"], ["u", "ぅ", "ゥ"], ["e", "ぇ", "ェ"], ["o", "ぉ", "ォ"],
];

const KANA_MAP: Map<string, string> = new Map();
for (const [ro, h, k] of KANA_ROWS) {
  if (!KANA_MAP.has(h)) KANA_MAP.set(h, ro);
  KANA_MAP.set(k, ro);
}
// Small ya/yu/yo compose digraphs with the preceding i-mora.
const SMALL_Y: Record<string, string> = {
  "ゃ": "ya", "ゅ": "yu", "ょ": "yo", "ャ": "ya", "ュ": "yu", "ョ": "yo",
};
const VOWELS = new Set(["a", "i", "u", "e", "o"]);

function isKana(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (c >= 0x3040 && c <= 0x309f) || (c >= 0x30a0 && c <= 0x30ff);
}

/**
 * Romanizes Japanese kana (Hepburn-style) where available. Kanji pass
 * through untouched, so mixed lines come back partial; lines without
 * any kana (including Korean/Chinese-only text) return null. Pure,
 * offline, and deterministic — no network, no key.
 */
export function toRomaji(text: string): string | null {
  if (!text || ![...text].some(isKana)) return null;
  let out = "";
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (!isKana(ch)) {
      out += ch;
      continue;
    }
    // Sokuon: duplicate the next mora's initial consonant.
    if (ch === "っ" || ch === "ッ") {
      const ro = KANA_MAP.get(chars[i + 1] ?? "");
      if (ro && !VOWELS.has(ro[0]) && ro[0] !== "n") out += ro[0];
      continue;
    }
    // Prolonged sound mark: repeat the previous vowel.
    if (ch === "ー") {
      const m = out.match(/[aiueo]$/) ?? out.match(/[AIUEO]$/);
      if (m) out += m[0].toLowerCase();
      continue;
    }
    // Yoon digraph: i-mora + small ya/yu/yo.
    const small = SMALL_Y[chars[i + 1] ?? ""];
    const base = KANA_MAP.get(ch);
    if (small && base && base.endsWith("i")) {
      out += base.slice(0, -1) + small.slice(1);
      i++;
      continue;
    }
    if (base) {
      // Syllabic n before a vowel/glide takes an apostrophe so e.g.
      // ほんい reads hon'i, not honi.
      const nxt = chars[i + 1] ?? "";
      if ((ch === "ん" || ch === "ン") && /^[aiueoyAIUEOY]$/.test(KANA_MAP.get(nxt) ?? nxt)) {
        out += "n'";
        continue;
      }
      out += base;
    } else {
      out += ch;
    }
  }
  return out === text ? null : out;
}
