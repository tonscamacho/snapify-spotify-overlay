import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import * as allIcons from "./icons";
import { LikePlusIcon } from "./icons";

declare const process: { cwd(): string };

import { readdirSync, readFileSync } from "node:fs";

const PACK_DIR = `${process.cwd()}/icon pack/svg/ui`;

type IconComponent = (p: { size?: number; className?: string }) => ReactElement;

function renderIcon(name: keyof typeof allIcons, size = 24): string {
  const C = allIcons[name] as unknown as IconComponent;
  return renderToString(createElement(C, { size }));
}

function innerMarkup(svg: string): string {
  const m = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  const body = m ? (m[1] as string) : svg;
  return body
    .replace(/>\s+</g, "><")
    .replace(/<(path|circle|rect|text)([^>]*?)\/>/g, "<$1$2></$1>")
    .trim();
}

function rootTag(svg: string): string {
  const m = svg.match(/<svg([^>]*)>/);
  return m ? (m[1] as string) : "";
}

describe("LikePlusIcon snapshot", () => {
  it("renders the plain-plus Spotify Like glyph", () => {
    const html = renderToString(createElement(LikePlusIcon, { size: 13 }));
    expect(html).toContain('width="13"');
    expect(html).toContain('height="13"');
    expect(html).toContain('d="M12 5v14"');
    expect(html).toContain('d="M5 12h14"');
    expect(html).not.toContain("heart");
  });

  it("matches the pinned snapshot", () => {
    expect(renderToString(createElement(LikePlusIcon, { size: 13 }))).toMatchSnapshot();
  });
});

describe("icons vs icon pack", () => {
  const mirrored: Array<[string, keyof typeof allIcons]> = [
    ["play.svg", "PlayIcon"],
    ["pause.svg", "PauseIcon"],
    ["next.svg", "NextIcon"],
    ["prev.svg", "PrevIcon"],
    ["shuffle.svg", "ShuffleIcon"],
    ["repeat.svg", "RepeatIcon"],
    ["repeat-1.svg", "RepeatOneIcon"],
    ["volume.svg", "VolumeIcon"],
    ["lyrics-mic.svg", "MicIcon"],
    ["close.svg", "XIcon"],
    ["note.svg", "NoteIcon"],
    ["refresh.svg", "RefreshIcon"],
  ];

  it("ships every mirrored pack file", () => {
    const files = readdirSync(PACK_DIR);
    for (const [file] of mirrored) {
      expect(files).toContain(file);
    }
  });

  it("keeps in-app paths byte-identical to the pack", () => {
    for (const [file, name] of mirrored) {
      const pack = readFileSync(`${PACK_DIR}/${file}`, "utf8");
      expect(innerMarkup(renderIcon(name))).toBe(innerMarkup(pack));
    }
  });

  it("shares one frame language with the pack (24 grid, 1.8 stroke, round caps)", () => {
    for (const [file, name] of mirrored) {
      const pack = readFileSync(`${PACK_DIR}/${file}`, "utf8");
      for (const tag of [rootTag(renderIcon(name)), rootTag(pack)]) {
        expect(tag).toContain('viewBox="0 0 24 24"');
        expect(tag).toContain('stroke-width="1.8"');
        expect(tag).toContain('stroke-linecap="round"');
        expect(tag).toContain('stroke-linejoin="round"');
      }
    }
  });

  it("dock-only glyphs carry no pack counterpart but keep the same language", () => {
    const files = readdirSync(PACK_DIR);
    const dockOnly: Array<[string, keyof typeof allIcons]> = [
      ["eye.svg", "EyeIcon"],
      ["eye-off.svg", "EyeOffIcon"],
      ["pencil.svg", "PencilIcon"],
      ["cursor.svg", "CursorIcon"],
      ["gear.svg", "GearIcon"],
      ["undo.svg", "UndoIcon"],
      ["through.svg", "ThroughIcon"],
    ];
    for (const [file, name] of dockOnly) {
      expect(files).not.toContain(file);
      const tag = rootTag(renderIcon(name));
      expect(tag).toContain('viewBox="0 0 24 24"');
      expect(tag).toContain('stroke-width="1.8"');
    }
  });
});
