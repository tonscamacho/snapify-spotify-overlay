import { test, expect } from "@playwright/test";
import { stubTauri } from "./tauri-mock";

// Frozen shell markup mirror (origin/feat/mp3-shell @ 324183a:
// src/components/Mp3Player.tsx + Mp3Lcd.tsx classnames, data hooks).
const MP3_HTML = `
<div class="mp3-body" data-variant="VARIANT" data-motion="on" role="region" aria-label="MP3 player">
  <div class="mp3-top">
    <span class="mp3-led" data-state="play" aria-hidden="true"></span>
    <span class="mp3-brand" aria-hidden="true">DIGITAL MP3 PLAYER</span>
    <span class="mp3-batt" aria-hidden="true"><i></i><i></i><i></i><i></i><em></em></span>
  </div>
  <div class="mp3-lcd" role="status" aria-live="polite" aria-label="Neon Skyline">
    <div class="mp3-sweep" aria-hidden="true"></div>
    <div class="mp3-view mp3-slide">
      <div class="mp3-title" title="Neon Skyline"><span class="mp3-title-inner">Neon Skyline</span></div>
      <div class="mp3-artist" title="Glass Owls">Glass Owls</div>
      <div class="mp3-bar" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuenow="72000" aria-valuemax="180000">
        <div class="mp3-bar-track"><i class="mp3-fill" style="transform: scaleX(0.4)"></i></div>
      </div>
      <div class="mp3-times"><span>1:12</span><span>-1:48</span></div>
    </div>
  </div>
  <div class="mp3-status"><span>PLAY</span><span class="mp3-hold" data-on="off">HOLD</span></div>
  <div class="mp3-wheel" role="group" aria-label="Control wheel">
    <button class="mp3-btn mp3-wheel-btn mp3-wheel-prev" type="button" aria-label="Previous track">Prev</button>
    <button class="mp3-btn mp3-wheel-btn mp3-wheel-next" type="button" aria-label="Next track">Next</button>
    <button class="mp3-btn mp3-center" type="button" aria-label="Pause">Pause</button>
  </div>
  <div class="mp3-subrow" role="group" aria-label="Playback options">
    <button class="mp3-btn mp3-sub-btn" type="button" aria-label="Toggle shuffle" aria-pressed="false" data-on="false">S</button>
    <button class="mp3-btn mp3-sub-btn" type="button" aria-label="Volume down">-</button>
    <button class="mp3-btn mp3-sub-btn" type="button" aria-label="Volume up">+</button>
    <button class="mp3-btn mp3-sub-btn" type="button" aria-label="Cycle repeat mode" aria-pressed="false" data-on="false">R</button>
  </div>
  <div class="mp3-foot" aria-hidden="true">STEREO DIGITAL AUDIO</div>
</div>`;

const EXPECTED_INK: Record<string, string> = {
  purple: "rgb(245, 242, 252)",
  black: "rgb(245, 242, 252)",
  silver: "rgb(26, 26, 32)",
  pink: "rgb(26, 26, 32)",
};

async function mountMp3(page: import("@playwright/test").Page, variant: string) {
  await stubTauri(page);
  await page.goto("/");
  await page.waitForSelector(".app", { timeout: 20000 });
  await page.evaluate(
    ({ html, v }) => {
      const app = document.querySelector(".app")!;
      app.setAttribute("data-overlay-mode", "mp3");
      app.setAttribute("data-variant", v);
      const host = document.createElement("div");
      host.innerHTML = html.split("VARIANT").join(v);
      app.appendChild(host);
    },
    { html: MP3_HTML, v: variant },
  );
  await page.waitForSelector(".mp3-body", { timeout: 5000 });
}

for (const variant of ["purple", "silver", "pink", "black"]) {
  test(`mp3 style proof: ${variant}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await mountMp3(page, variant);

    const ink = await page.evaluate(() => {
      const b = document.querySelector(".mp3-body")!;
      return getComputedStyle(b).color;
    });
    expect(ink, `${variant} body ink`).toBe(EXPECTED_INK[variant]);

    const lcdBox = await page.evaluate(() => {
      const lcd = document.querySelector(".mp3-lcd")!;
      const cs = getComputedStyle(lcd);
      return { w: cs.width, h: cs.height };
    });
    expect(lcdBox, `${variant} LCD geometry`).toEqual({ w: "176px", h: "76px" });

    const scan = await page.evaluate(() => {
      const lcd = document.querySelector(".mp3-lcd")!;
      return getComputedStyle(lcd, "::after").backgroundImage;
    });
    expect(scan).toContain("repeating-linear-gradient");

    const gloss = await page.evaluate(() => {
      const lcd = document.querySelector(".mp3-lcd")!;
      return getComputedStyle(lcd, "::before").backgroundImage;
    });
    expect(gloss).toContain("linear-gradient");

    const bodyBg = await page.evaluate(() => {
      const b = document.querySelector(".mp3-body")!;
      return getComputedStyle(b).backgroundImage;
    });
    expect(bodyBg).toContain("linear-gradient");

    // Single focus ring #0a84ff on a frozen-shell control.
    await page.locator(".mp3-wheel-next").focus();
    const focusColor = await page.evaluate(() => {
      const b = document.querySelector(".mp3-wheel-next")!;
      return getComputedStyle(b).outlineColor;
    });
    expect(focusColor).toBe("rgb(10, 132, 255)");

    // data-motion=off parity: transitions collapse on the shell hook.
    await page.evaluate(() => {
      document.querySelector(".mp3-body")!.setAttribute("data-motion", "off");
    });
    const fillTransition = await page.evaluate(() => {
      const f = document.querySelector(".mp3-fill")!;
      return getComputedStyle(f).transitionDuration;
    });
    expect(fillTransition).toBe("0s");
    const titleAnim = await page.evaluate(() => {
      const t = document.querySelector(".mp3-title-inner")!;
      return getComputedStyle(t).animationName;
    });
    expect(titleAnim).toBe("none");

    expect(errors, JSON.stringify(errors)).toEqual([]);
    await page.locator(".mp3-body").screenshot({
      path: `verify/web/test-results/mp3-${variant}.png`,
    });
  });
}

test("mp3 style proof: reduced-motion collapses animation", async ({ page }) => {
  await mountMp3(page, "purple");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const anim = await page.evaluate(() => {
    const inner = document.querySelector(".mp3-title-inner")!;
    return getComputedStyle(inner).animationName;
  });
  expect(anim).toBe("none");
  await page.locator(".mp3-body").screenshot({
    path: "verify/web/test-results/mp3-reduced-motion.png",
  });
});

test("classic regression: no overlay-mode attr, app boots clean", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await stubTauri(page);
  await page.goto("/");
  await page.waitForSelector(".app", { timeout: 20000 });
  const mode = await page.evaluate(() =>
    document.querySelector(".app")!.getAttribute("data-overlay-mode"),
  );
  expect(mode).toBeNull();
  expect(errors, JSON.stringify(errors)).toEqual([]);
  await page.screenshot({ path: "verify/web/test-results/mp3-classic-baseline.png" });
});
