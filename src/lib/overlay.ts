import { invoke } from "@tauri-apps/api/core";

interface OverlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const SELECTORS = [
  "section.pane",
  ".dock",
  ".modal",
  ".gate-card",
  ".toasts .toast",
  // Coach pill (PR1 gap): display-only until it resolves to a region. Once
  // listed here the pill is clickable in interactive mode; passive mode is
  // unaffected because the Rust side ignores regions unless interactive.
  ".hint-chip",
] as const;

function collectOverlayRegions(): OverlayRect[] {
  const out: OverlayRect[] = [];
  for (const sel of SELECTORS) {
    const nodes = document.querySelectorAll(sel);
    for (const el of Array.from(nodes)) {
      const html = el as HTMLElement;
      if (!html.isConnected) continue;
      const style = getComputedStyle(html);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (html instanceof HTMLElement && html.offsetParent === null) {
        const pos = style.position;
        if (pos !== "fixed") continue;
      }
      const r = html.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      out.push({
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
      if (out.length >= 64) return out;
    }
  }
  return out;
}

function signatureFor(rects: OverlayRect[], dpr: number, ox: number, oy: number): string {
  return `${dpr}|${ox},${oy}|` + rects.map((r) => `${r.x},${r.y},${r.w},${r.h}`).join(";");
}

// Last reported signature. The Rust applied-signature dedupe is a backstop,
// not the fix: the frontend skips the invoke entirely when the resolved
// regions (plus the additive DPR/origin tags) are unchanged, so toast churn
// and no-op state writes never reach Rust.
let lastSignature: string | null = null;

/** Test seam: forget the last report so the next call always invokes. */
export function resetOverlayRegionDiff(): void {
  lastSignature = null;
}

// Startup timing, frontend half of the Rust `note_boot` /
// `note_first_report` pair in src-tauri/src/overlay.rs. Module load runs
// before first paint (imported by main.tsx), so it approximates app boot.
const BOOT_T0 = Date.now();
let firstReportLogged = false;
try {
  if (typeof performance !== "undefined" && typeof performance.mark === "function") {
    performance.mark("snapify-boot");
  }
} catch {
  // Marks are best-effort; reporting must never depend on them.
}

function logFirstRegionReport(): void {
  if (firstReportLogged) return;
  firstReportLogged = true;
  try {
    // eslint-disable-next-line no-console
    console.info(`snapify: boot-to-first-region-report ${Date.now() - BOOT_T0}ms`);
    if (typeof performance !== "undefined" && typeof performance.mark === "function") {
      performance.mark("snapify-first-region-report");
    }
  } catch {
    // Logging never breaks reporting.
  }
}

export async function reportOverlayRegions(): Promise<boolean> {
  const rects = collectOverlayRegions();
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
  const ox = typeof window !== "undefined" ? Math.round(window.screenX) : 0;
  const oy = typeof window !== "undefined" ? Math.round(window.screenY) : 0;
  const sig = signatureFor(rects, dpr, ox, oy);
  if (sig === lastSignature) return false;
  lastSignature = sig;
  try {
    // devicePixelRatio + monitor origin ride the Rust applied-signature so
    // a same-CSS-rects hop across mixed-DPI monitors still re-applies.
    // Scaling math is untouched: Rust converts with its live scale factor.
    await invoke("set_overlay_regions", {
      regions: rects,
      devicePixelRatio: dpr,
      monitorOrigin: { x: ox, y: oy },
    });
    logFirstRegionReport();
    return true;
  } catch {
    // Web / mocked runs have no Rust side. CSS pointer-events still keeps
    // in-window hit-testing honest for the Playwright repro.
    return false;
  }
}

/**
 * ResizeObserver over the region elements so size changes that never touch
 * layout state (toast growth, uiScale zoom reflow, font load) still
 * schedule a report. Position-only changes (drags) already flow through the
 * App layout effect; callers must pass the same debounced scheduler so the
 * observer can never exceed the <10/s report bound on its own.
 */
export function watchRegionElementSizes(onDirty: () => void): () => void {
  if (typeof document === "undefined" || typeof ResizeObserver === "undefined") {
    return () => {};
  }
  const seen = new Set<Element>();
  let ro: ResizeObserver | null = null;
  try {
    ro = new ResizeObserver(() => {
      onDirty();
    });
  } catch {
    return () => {};
  }
  const scan = () => {
    let nodes: NodeListOf<Element>;
    try {
      nodes = document.querySelectorAll(SELECTORS.join(", "));
    } catch {
      return;
    }
    for (const n of Array.from(nodes)) {
      if (seen.has(n)) continue;
      seen.add(n);
      try {
        ro?.observe(n);
      } catch {
        // Detached mid-scan; the next mutation rescan picks it up.
      }
    }
  };
  scan();
  let mo: MutationObserver | null = null;
  try {
    if (typeof MutationObserver !== "undefined" && document.body) {
      mo = new MutationObserver(() => {
        scan();
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  } catch {
    // The observer is best-effort; state effects still report.
  }
  return () => {
    try {
      ro?.disconnect();
    } catch {
      // Teardown must not throw.
    }
    try {
      mo?.disconnect();
    } catch {
      // Teardown must not throw.
    }
  };
}

export async function reportOverlayMode(interactive: boolean): Promise<void> {
  try {
    await invoke("set_overlay_mode", { interactive });
  } catch {
    // Same fallback as above.
  }
}
