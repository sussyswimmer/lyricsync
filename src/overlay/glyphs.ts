/**
 * The word glyphs' drawings (core/wordglyphs.ts says which word gets which): line icons in a
 * 24 × 24 box, drawn with a round 2 px stroke in the lyric color, a few of them filled. Each is a
 * single SVG path, so a glyph is one element beside its word in the word's slot (modes/lens.ts
 * buildRow), scaled with the word on the compositor. Drawn here by hand, in the plain style of a
 * road sign: nothing a reader has to work out.
 */
import type { GlyphId } from "../core/wordglyphs";
import { h, s } from "./dom";

/** A glyph is this many em across, this far after its word. */
export const GLYPH_EM = 0.72;
export const GLYPH_GAP_EM = 0.24;

/** A circle of radius r at (cx, cy), as path data. */
const circle = (cx: number, cy: number, r: number): string => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
/** A dot (a zero-length stroke, round-capped). */
const dot = (x: number, y: number): string => `M${x} ${y}h.01`;

const PATHS: Readonly<Record<GlyphId, string>> = {
  building: "M4 21V6a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v15 M13 10h5a1 1 0 0 1 1 1v10 M2 21h20 M7.5 8.5h2 M7.5 12h2 M7.5 15.5h2 M16 14h.5 M16 17.5h.5",
  house: "M3 11 12 3l9 8 M5 10v11h14V10 M10 21v-6h4v6",
  "arrow-left": "M20 12H4 M10 6l-6 6 6 6",
  "arrow-right": "M4 12h16 M14 6l6 6-6 6",
  "arrow-up": "M12 20V4 M6 10l6-6 6 6",
  "arrow-down": "M12 4v16 M6 14l6 6 6-6",
  play: "M7 4v16l13-8z",
  plus: "M12 5v14 M5 12h14",
  shirt: "M8 3 3 6l2 4 2-1v12h10V9l2 1 2-4-5-3a4 4 0 0 1-8 0z",
  glasses: `${circle(6, 13, 4)} ${circle(18, 13, 4)} M10 13h4 M2 12l2-5 M22 12l-2-5`,
  wine: "M7 3h10v5a5 5 0 0 1-10 0z M12 13v8 M8 21h8",
  dancer: `${circle(13, 4, 1.6)} M11.5 7 9 12l-3 9 M11.5 7l4.5 2 3-4 M9 12l5 2 2 7 M11.5 7 6 9`,
  music: `M9 18V5l11-2v13 ${circle(6, 18, 3)} ${circle(17, 16, 3)}`,
  heart: "M12 20s-7-4.5-7-10a3.5 3.5 0 0 1 7-1 3.5 3.5 0 0 1 7 1c0 5.5-7 10-7 10z",
  "broken-heart": "M12 20s-7-4.5-7-10a3.5 3.5 0 0 1 7-1 3.5 3.5 0 0 1 7 1c0 5.5-7 10-7 10z M12 9l-1.5 3 2.5 2-1 4",
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z",
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
  sun: `${circle(12, 12, 4.5)} M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4`,
  cloud: "M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 11a3.5 3.5 0 0 0 1 7z",
  rain: "M7 14h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 7a3.5 3.5 0 0 0 1 7z M8 17l-1 3 M12 17l-1 3 M16 17l-1 3",
  snow: "M12 2v20 M3.3 7l17.4 10 M3.3 17 20.7 7 M12 2l-2 2 M12 2l2 2 M12 22l-2-2 M12 22l2-2 M3.3 7l2.8.3 M3.3 7l.3 2.8 M20.7 17l-2.8-.3 M20.7 17l-.3-2.8 M3.3 17l2.8-.3 M3.3 17l.3-2.8 M20.7 7l-2.8.3 M20.7 7l-.3 2.8",
  fire: "M12 22c-4 0-7-3-7-7 0-3 2-5 3-7 0 2 1 3 2 3 0-4 2-7 5-8 0 3 1 5 3 7 1.5 2 2 3 2 5 0 4-3 7-8 7z",
  lightning: "M13 2 4 14h7l-1 8 9-12h-7z",
  phone: "M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2z",
  clock: `${circle(12, 12, 9)} M12 7v5l3 2`,
  hourglass: "M6 3h12 M6 21h12 M7 3v3c0 3 5 4 5 6s-5 3-5 6v3 M17 3v3c0 3-5 4-5 6s5 3 5 6v3",
  calendar: "M4 5h16v16H4z M4 10h16 M8 3v4 M16 3v4",
  car: `M3 17v-5l2-5h14l2 5v5 M3 12h18 M3 17h18 ${circle(7, 17, 1.5)} ${circle(17, 17, 1.5)}`,
  plane: "M12 2l2 7 7 3v2l-7-1-1 5 2 2v1l-3-1-3 1v-1l2-2-1-5-7 1v-2l7-3z",
  bird: "M2 13c3-4 7-4 10 0 3-4 7-4 10 0",
  rocket: `M12 2c3 2 5 6 5 11l-2 3h-6l-2-3c0-5 2-9 5-11z M9 16l-3 3 M15 16l3 3 M12 16v5 ${circle(12, 9, 1.5)}`,
  eye: `M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z ${circle(12, 12, 3)}`,
  hand: "M8 11V5a1.5 1.5 0 0 1 3 0v6 M11 10V4a1.5 1.5 0 0 1 3 0v7 M14 11V6a1.5 1.5 0 0 1 3 0v6 M17 12a1.5 1.5 0 0 1 3 0v3a7 7 0 0 1-7 7h-2a6 6 0 0 1-5-3L4 14a1.5 1.5 0 0 1 2.5-1.5L8 14v-3",
  person: `${circle(12, 7, 4)} M4 21a8 8 0 0 1 16 0`,
  money: `M2 7h20v10H2z ${circle(12, 12, 3)} ${dot(5.5, 9.5)} ${dot(18.5, 14.5)}`,
  diamond: "M6 3h12l4 6-10 12L2 9z M2 9h20 M9 3l3 6 3-6",
  crown: "M3 18h18l1-11-5 4-5-7-5 7-5-4z M3 18v3h18v-3",
  key: `${circle(8, 11, 4)} M11.5 11H21 M18 11v3 M15 11v2`,
  camera: `M3 8h4l2-3h6l2 3h4v12H3z ${circle(12, 13.5, 3.5)}`,
  pin: `M12 22s7-6 7-12a7 7 0 1 0-14 0c0 6 7 12 7 12z ${circle(12, 10, 3)}`,
  globe: `${circle(12, 12, 9)} M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18`,
  bed: `M3 19V7 M21 19v-5a3 3 0 0 0-3-3h-7v3 M3 14h18 M3 19h18 ${circle(7, 9, 2)}`,
  cup: "M4 8h12v6a5 5 0 0 1-10 0V8z M16 10h2a2 2 0 0 1 0 4h-2 M5 20h10 M8 3c0 1 1 1 1 2 M11 3c0 1 1 1 1 2",
  gift: "M3 10h18v4H3z M5 14v7h14v-7 M12 10v11 M12 10c-2 0-5-1-5-3.5A1.5 1.5 0 0 1 9.5 5c2 0 2.5 3 2.5 5z M12 10c2 0 5-1 5-3.5A1.5 1.5 0 0 0 14.5 5c-2 0-2.5 3-2.5 5z",
  flag: "M5 21V4 M5 4h12l-3 4 3 4H5",
  trophy: "M8 3h8v7a4 4 0 0 1-8 0z M8 5H5a3 3 0 0 0 3 5 M16 5h3a3 3 0 0 1-3 5 M12 14v4 M9 18h6v3H9z",
  speech: "M4 4h16v11H9l-5 4z",
  smile: `${circle(12, 12, 9)} M8 14s1.5 2 4 2 4-2 4-2 ${dot(9, 9)} ${dot(15, 9)}`,
  sad: `${circle(12, 12, 9)} M8 16s1.5-2 4-2 4 2 4 2 ${dot(9, 9)} ${dot(15, 9)}`,
  skull: `M12 2a8 8 0 0 0-8 8c0 3 2 5 3 6v3h10v-3c1-1 3-3 3-6a8 8 0 0 0-8-8z ${circle(9, 10.5, 1.5)} ${circle(15, 10.5, 1.5)} M10 19v3 M14 19v3`,
  ghost: `M12 2a7 7 0 0 0-7 7v13l2.5-2 2.5 2 2-2 2 2 2.5-2 2.5 2V9a7 7 0 0 0-7-7z ${dot(9.5, 10)} ${dot(14.5, 10)}`,
  bell: "M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z M10 21h4 M12 3v2",
  flower: `${circle(12, 10, 2.5)} M12 7.5a3 3.5 0 0 1 0-7 3 3.5 0 0 1 0 7z M12 12.5a3 3.5 0 0 1 0 7 3 3.5 0 0 1 0-7z M9.5 10a3.5 3 0 0 1-7 0 3.5 3 0 0 1 7 0z M14.5 10a3.5 3 0 0 1 7 0 3.5 3 0 0 1-7 0z M12 19.5V23`,
  tree: "M12 22v-6 M12 16H7l2-4H7l3-4H8l4-6 4 6h-2l3 4h-2l2 4h-5",
  mountain: "M2 20 9 7l4 7 2-3 7 9z M9 7l-2 4",
  wave: "M2 10c2-3 4-3 6 0s4 3 6 0 4-3 6 0 M2 16c2-3 4-3 6 0s4 3 6 0 4-3 6 0",
  boat: "M3 15h18l-2 5H5z M12 15V4l7 9 M12 6c-2 3-4 6-4 7",
  train: `M6 3h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M4 10h16 ${dot(8, 14)} ${dot(16, 14)} M8 18l-2 3 M16 18l2 3`,
  bike: `${circle(5, 17, 3.5)} ${circle(19, 17, 3.5)} M5 17l4-8h6l4 8 M9 9l3 8h7 M14 5h3l2 4`,
  door: `M6 3h12v18H6z ${dot(14.5, 12)} M3 21h18`,
  window: "M4 4h16v16H4z M12 4v16 M4 12h16",
  food: "M7 3v18 M4 3v5a3 3 0 0 0 6 0V3 M17 3c-3 2-3 9 0 11v7 M17 3v11",
  cake: "M3 21h18 M4 21v-7h16v7 M4 14a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4 M12 10V7 M12 3c-1 1.3-1 2.7 0 4 1-1.3 1-2.7 0-4z M4 17c2 2 4 2 6 0s4-2 6 0 2 2 4 0",
  bag: "M6 8h12l1 13H5z M9 8V6a3 3 0 0 1 6 0v2",
  shoe: "M2 18h20v2H2z M2 18c0-4 3-6 7-6l2-5c3 1 5 3 7 4 2 1 4 2 4 7 M9 12l2 2 M11 8l3 2",
  ring: `${circle(12, 15, 6)} M9 6l3-3 3 3-3 3z`,
  letter: "M3 5h18v14H3z M3 6l9 7 9-7",
  pen: "M4 20l1-4L16 5l3 3L8 19z M14 7l3 3 M4 20h4",
  book: "M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z M20 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z",
  mic: "M12 15a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v7a3 3 0 0 0 3 3z M6 11a6 6 0 0 0 12 0 M12 17v4 M9 21h6",
  headphones: "M4 15v-3a8 8 0 0 1 16 0v3 M4 15h3v6H4z M17 15h3v6h-3z",
  guitar: `M22 2l-8 8 M13 9c-1.5-.5-3.5 0-4.5 1.5S8 14 9 15c-2 .5-3.5 2-3.5 4s1.5 3 3 3 3.5-1.5 4-3.5c1.5 1 3.5.5 4.5-1s1-3.5-.5-4.5 ${dot(18, 6)}`,
  drum: "M4 9a8 3 0 1 0 16 0 8 3 0 1 0-16 0 M4 9v8a8 3 0 0 0 16 0V9 M8 12v7 M16 12v7 M10 6l9-4 M14 6 5 2",
  piano: "M3 4h18v16H3z M9 4v16 M15 4v16 M7 4v10 M12 4v10 M17 4v10",
  tv: "M3 6h18v12H3z M8 21h8 M12 18v3",
  dice: `M4 4h16v16H4z ${dot(8.5, 8.5)} ${dot(15.5, 8.5)} ${dot(12, 12)} ${dot(8.5, 15.5)} ${dot(15.5, 15.5)}`,
  infinity: "M6 9c-3 0-4 2-4 3s1 3 4 3c4 0 8-6 12-6 3 0 4 2 4 3s-1 3-4 3c-4 0-8-6-12-6z",
  x: "M6 6l12 12 M18 6 6 18",
  check: "M4 12l5 5L20 6",
  question: `M9 9a3 3 0 1 1 4.5 2.6c-1 .6-1.5 1.4-1.5 2.4v1 ${dot(12, 19)}`,
  compass: `${circle(12, 12, 9)} M15.5 8.5l-2 5-5 2 2-5z`,
  anchor: `${circle(12, 5.5, 2.5)} M12 8v14 M9 12h6 M4 14a8 8 0 0 0 16 0`,
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L12 6.3 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7L12 17.7",
  target: `${circle(12, 12, 9)} ${circle(12, 12, 4)} ${dot(12, 12)}`,
  bulb: "M9 18h6 M10 21h4 M8.5 14.5A6 6 0 1 1 15.5 14.5c-.8.7-1.5 1.7-1.5 3.5h-4c0-1.8-.7-2.8-1.5-3.5z",
  dumbbell: "M6 8v8 M3 10v4 M18 8v8 M21 10v4 M6 12h12",
  shield: "M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z M9 12l2 2 4-4",
  heal: `${circle(12, 12, 9)} M12 8v8 M8 12h8`,
  boom: "M12 3l2 5 5-2-2 5 5 2-5 2 2 5-5-2-2 5-2-5-5 2 2-5-5-2 5-2-2-5 5 2z",
  magic: "M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z M19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2-2.2-.8 2.2-.8z M5 15l.6 1.4 1.4.6-1.4.6L5 19l-.6-1.4L3 17l1.4-.6z",
  paw: `M12 20c-3 0-5-1.5-5-3.5 0-2 2.5-4 5-4s5 2 5 4c0 2-2 3.5-5 3.5z ${circle(5.5, 10, 2)} ${circle(9.5, 6.5, 2)} ${circle(14.5, 6.5, 2)} ${circle(18.5, 10, 2)}`,
  balloon: "M12 15a6 7 0 1 0 0-14 6 7 0 0 0 0 14z M11 15l1 2 1-2 M12 17c0 2-2 3-2 5",
  party: "M3 21 9 6l9 9z M10.5 3.5 11 2 M15 4.5l1-1.5 M19 8l1.5-.5 M19.5 12l1.5.5 M15.5 15.5l1.5 1",
  speaker: "M3 9h4l5-4v14l-5-4H3z M16 9a4 4 0 0 1 0 6 M19 6a8 8 0 0 1 0 12",
  signal: `M2 9a16 16 0 0 1 20 0 M5.5 12.5a11 11 0 0 1 13 0 M9 16a6 6 0 0 1 6 0 ${dot(12, 20)}`,
  scissors: `${circle(6, 6, 3)} ${circle(6, 18, 3)} M20 4 8.5 10.5 M8.5 13.5 20 20 M8.5 10.5l3 1.5`,
  send: "M22 2 2 9l9 3 3 9z M11 12l11-10",
  mirror: "M12 21a7 9 0 1 0 0-18 7 9 0 0 0 0 18z M8.5 9c.8-1.2 1.8-2 3-2.5",
  halo: `M6 5a6 2 0 1 0 12 0 6 2 0 1 0-12 0 ${circle(12, 12, 4)} M5 22a7 7 0 0 1 14 0`,
  lips: "M2 12c3-4 7-5 10-3 3-2 7-1 10 3-3 4-7 6-10 6S5 16 2 12z M2 12h20",
};

/** Glyphs drawn as a filled shape, not a stroked line. */
const FILLED: ReadonlySet<GlyphId> = new Set<GlyphId>(["play"]);

/** Glyph `id`'s path data (24 × 24). */
export function glyphPath(id: GlyphId): string {
  return PATHS[id];
}

/**
 * Glyph `id` as an element to put beside its word: an inline SVG (`.kw-glyph`, styles/lens.css),
 * or a plain span where there is no SVG (a test's fake document).
 */
export function glyphElement(id: GlyphId): HTMLElement | SVGSVGElement {
  const cls = `kw-glyph${FILLED.has(id) ? " is-fill" : ""}`;
  if (typeof document.createElementNS !== "function") {
    const el = h("span", cls);
    el.setAttribute("data-glyph", id);
    return el;
  }
  const svg = s("svg", { viewBox: "0 0 24 24", class: cls, "aria-hidden": "true", "data-glyph": id });
  svg.append(s("path", { d: PATHS[id] }));
  return svg;
}
