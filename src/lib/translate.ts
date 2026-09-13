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
 * Translates one lyric line from English via the MyMemory free tier.
 * Cached per line+language (cap 200) so a replay costs nothing.
 * Resolves null on any failure — the caller keeps the original line.
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
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(line)}&langpair=en|${lang}`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return fail();
    const body = (await res.json()) as {
      responseData?: { translatedText?: string };
      responseStatus?: number;
    };
    const out = body.responseData?.translatedText?.trim();
    if (!out || body.responseStatus === 429) return fail();
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
