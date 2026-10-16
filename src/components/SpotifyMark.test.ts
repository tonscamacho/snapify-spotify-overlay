import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import SpotifyMark from "./SpotifyMark";

describe("SpotifyMark minimum size", () => {
  it("clamps the icon variant to the 21px minimum", () => {
    const html = renderToString(createElement(SpotifyMark, { variant: "icon", size: 10 }));
    expect(html).toContain('width="21"');
    expect(html).toContain('height="21"');
  });

  it("passes through larger icon sizes unchanged", () => {
    const html = renderToString(createElement(SpotifyMark, { variant: "icon", size: 32 }));
    expect(html).toContain('width="32"');
    expect(html).toContain('height="32"');
  });

  it("keeps the 70px full-logo floor", () => {
    const html = renderToString(createElement(SpotifyMark, { variant: "full" }));
    expect(html).toContain("min-width:70px");
    expect(html).toContain('width="84"');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Spotify"');
  });
});
