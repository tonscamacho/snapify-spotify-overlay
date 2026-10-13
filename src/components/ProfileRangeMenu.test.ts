import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import ProfileRangeMenu from "./ProfileRangeMenu";

function renderMenu(value: "today" | "week" | "fourWeeks" | "sixMonths" | "year2026" | "lifetime"): string {
  return renderToString(
    createElement(ProfileRangeMenu, { value, onChange: () => {}, labelId: "profile-range-label" }),
  );
}

describe("ProfileRangeMenu", () => {
  it("renders a listbox button with six options", () => {
    const html = renderMenu("fourWeeks");
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('role="listbox"');
    for (const v of ["today", "week", "fourWeeks", "sixMonths", "year2026", "lifetime"]) {
      expect(html).toContain(`data-value="${v}"`);
    }
    expect(html).toContain("4 weeks");
  });

  it("labels every option verbatim", () => {
    const html = renderMenu("today");
    for (const label of ["Today", "Week", "4 weeks", "6 months", "2026", "Lifetime"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Today");
  });

  it("marks the committed value selected", () => {
    const html = renderMenu("lifetime");
    expect(html).toContain('data-value="lifetime"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("Lifetime");
  });
});
