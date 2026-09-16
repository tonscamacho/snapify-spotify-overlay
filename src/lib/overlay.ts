import { invoke } from "@tauri-apps/api/core";

export interface OverlayRect {
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
] as const;

export function collectOverlayRegions(): OverlayRect[] {
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

export async function reportOverlayRegions(): Promise<void> {
  try {
    await invoke("set_overlay_regions", { regions: collectOverlayRegions() });
  } catch {
    // Web / mocked runs have no Rust side. CSS pointer-events still keeps
    // in-window hit-testing honest for the Playwright repro.
  }
}

export async function reportOverlayMode(interactive: boolean): Promise<void> {
  try {
    await invoke("set_overlay_mode", { interactive });
  } catch {
    // Same fallback as above.
  }
}
