/**
 * Arc's lines on their curve (pure, no DOM). Every Arc line follows a parabola,
 * y = mid + bend·((x − xm) / halfWidth)² in screen px (y down), from xm − halfWidth to xm + halfWidth,
 * continued straight along its tangent past either end. A line is centered on the curve's middle, the
 * way SVG's `text-anchor: middle` at `startOffset: 50%` centers it, and every letter sits where SVG text
 * on a path puts a glyph: the middle of its advance on the curve, turned to the tangent there.
 *
 * The focus line is HTML, one box per word. Each word box gets a frame: the middle of its baseline on
 * the curve, turned to the tangent there. Each letter inside is then offset and turned the little more
 * it takes to sit on the curve itself (a LetterPlacer for the KaraokeLine), so a word's pop runs along
 * the normal at its middle and a letter's hop along its own. A word whose letters can't move on their
 * own (right to left, or a joining script) is one box, placed by its middle in visual order.
 */
import type { LetterBox } from "../motion/karaoke";
import type { LetterPlacer } from "../motion/line";

/** A line's path: the parabola through (xm, mid), its ends `bend` px below (above, for a negative bend). */
export interface ArcCurve {
  /** x of the path's middle, px */
  xm: number;
  /** baseline y at the path's middle, px from the top */
  mid: number;
  bend: number;
  /** half the path's horizontal span, px */
  halfWidth: number;
}

/** A point on a path: where, and the tangent's angle there (radians, clockwise on screen). */
export interface ArcPoint {
  x: number;
  y: number;
  angle: number;
}

/** A word box's frame: where the middle of its baseline lands, and the angle it is turned by (degrees, clockwise). */
export interface WordFrame {
  x: number;
  y: number;
  angle: number;
}

/** One letter's static placement, CSS `translate` (px) and `rotate` (degrees), around its transform-origin. */
export interface LetterPlace {
  dx: number;
  dy: number;
  rotate: number;
}

/** A word along its line: where its box starts (visual order, px from the line's left end) and its advance. */
export interface ArcWord {
  at: number;
  width: number;
}

/**
 * How a letter's box sits in its word box (stage.css `.kl`: absolutely placed at the top of the word
 * box, its transform-origin at 50% 64%): the baseline's depth below the box's top and the box's
 * height (the line-height), px; the CSS letter-spacing after each letter, px.
 */
export interface LetterMetrics {
  baseline: number;
  lineHeight: number;
  spacing: number;
}

/** stage.css `.kl { transform-origin: 50% 64% }`. */
export const LETTER_ORIGIN_Y = 0.64;

const DEG = 180 / Math.PI;

/**
 * Length along a path with this `bend` from its middle to `x` px either side (negative to the left):
 * the closed form for the parabola y = bend·(x / halfWidth)².
 */
export function arcLength(x: number, halfWidth: number, bend: number): number {
  const a = halfWidth > 0 ? Math.abs(bend) / (halfWidth * halfWidth) : 0;
  if (a < 1e-9) return x;
  return (x * Math.sqrt(1 + 4 * a * a * x * x) + Math.asinh(2 * a * x) / (2 * a)) / 2;
}

/** How far a text `length` px long, centered on a path with this `bend`, reaches to either side: a share of the half-width, 0..1. */
export function reach(length: number, halfWidth: number, bend: number): number {
  if (halfWidth <= 0 || length <= 0) return 0;
  const target = length / 2;
  if (arcLength(halfWidth, halfWidth, bend) <= target) return 1;
  let lo = 0;
  let hi = halfWidth;
  for (let n = 0; n < 40; n++) {
    const x = (lo + hi) / 2;
    if (arcLength(x, halfWidth, bend) < target) lo = x;
    else hi = x;
  }
  return (lo + hi) / 2 / halfWidth;
}

/** Half the path's length, middle to either end, px. */
export function halfLength(c: ArcCurve): number {
  return Math.abs(arcLength(c.halfWidth, c.halfWidth, c.bend));
}

/**
 * The x offset from the path's middle at arc length `s` from it (negative: to the left), for
 * |s| ≤ halfLength: arcLength inverted by bisection. A path is never shorter than its span, so the
 * answer lies between 0 and |s|.
 */
export function xAtLength(s: number, c: ArcCurve): number {
  const target = Math.min(Math.abs(s), halfLength(c));
  let lo = 0;
  let hi = Math.min(Math.max(0, c.halfWidth), target);
  for (let n = 0; n < 48; n++) {
    const x = (lo + hi) / 2;
    if (arcLength(x, c.halfWidth, c.bend) < target) lo = x;
    else hi = x;
  }
  return Math.sign(s) * ((lo + hi) / 2);
}

/** The point `s` px along the path from its middle (negative: to the left), and its tangent; straight on past either end. */
export function pointAt(c: ArcCurve, s: number): ArcPoint {
  const k = c.halfWidth > 0 ? c.bend / (c.halfWidth * c.halfWidth) : 0;
  const half = halfLength(c);
  if (Math.abs(s) <= half) {
    const x = xAtLength(s, c);
    // (|| 0: no -0 from the left half of a flat path)
    return { x: c.xm + x, y: c.mid + k * x * x, angle: Math.atan(2 * k * x) || 0 };
  }
  // past an end: the end's tangent, carried on (the text still reads left to right)
  const side = Math.sign(s);
  const x = side * Math.max(0, c.halfWidth);
  const angle = Math.atan(2 * k * x) || 0;
  const over = Math.abs(s) - half;
  return { x: c.xm + x + side * over * Math.cos(angle), y: c.mid + k * x * x + side * over * Math.sin(angle), angle };
}

/** Each word's frame on `c`, for a line `total` px long centered on the path's middle. */
export function wordFrames(c: ArcCurve, words: readonly ArcWord[], total: number): WordFrame[] {
  const start = -total / 2;
  return words.map((w) => {
    const p = pointAt(c, start + w.at + w.width / 2);
    return { x: p.x, y: p.y, angle: p.angle * DEG };
  });
}

/**
 * Where letter `box` of word `word` sits, relative to where the word box draws it, so that its
 * advance's middle lands on the path and it turns with the tangent there: the CSS `translate` and
 * `rotate` around its transform-origin (50% of its box's width, which letter-spacing widens, and 64%
 * of the line-height down).
 */
export function letterPlace(c: ArcCurve, word: ArcWord, frame: WordFrame, total: number, box: Pick<LetterBox, "x" | "w">, m: LetterMetrics): LetterPlace {
  const p = pointAt(c, -total / 2 + word.at + box.x + box.w / 2);
  const phi = frame.angle / DEG;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  // the point on the path in the word box: (width/2, baseline) + R(-φ)(P - frame)
  const ex = p.x - frame.x;
  const ey = p.y - frame.y;
  const tx = word.width / 2 + ex * cos + ey * sin;
  const ty = m.baseline - ex * sin + ey * cos;
  // the letter turns by α about its origin o; its baseline's middle c must land on t:
  // o + T + R(α)(c - o) = t
  const alpha = p.angle - phi;
  const ox = box.x + (box.w + m.spacing) / 2;
  const oy = LETTER_ORIGIN_Y * m.lineHeight;
  const cx = box.x + box.w / 2 - ox;
  const cy = m.baseline - oy;
  const ca = Math.cos(alpha);
  const sa = Math.sin(alpha);
  return { dx: tx - ox - (cx * ca - cy * sa), dy: ty - oy - (cx * sa + cy * ca), rotate: alpha * DEG };
}

/**
 * A LetterPlacer for a line laid out on `c`: its words (visual offsets and advances), their frames, the
 * line's total advance and how letters sit in their boxes. A word drawn whole (one "letter", the word
 * itself) gets no placement: its frame already puts it on the path by its middle.
 */
export function arcPlacer(c: ArcCurve, words: readonly ArcWord[], frames: readonly WordFrame[], total: number, m: LetterMetrics): LetterPlacer {
  return (word, _letter, box) => {
    const w = words[word];
    const f = frames[word];
    if (!w || !f) return null;
    if (box.x <= 0 && Math.abs(box.w - w.width) < 0.01) return null;
    return letterPlace(c, w, f, total, box, m);
  };
}

/** One word for visualOrder: its advance, the space after it, and the direction of its letters. */
export interface WordRun {
  /** advance of the word itself, px */
  width: number;
  /** advance of what follows it in the text (its trailing space and letter-spacing), px */
  space: number;
  /** a right-to-left word */
  rtl: boolean;
  /** has a strong left-to-right letter */
  ltr: boolean;
}

/**
 * Where each word's box starts, px from the line's left end, and the line's advance. A left-to-right
 * line lays its words out in order, a right-to-left one from the right, each word's space on its far
 * side; a run of words in the other direction inside it keeps its own order, the way the bidi
 * algorithm lays out a two-level line (a simplification: numbers and other weak runs take the line's
 * direction).
 */
export function visualOffsets(words: readonly WordRun[], rtlLine: boolean): { at: number[]; total: number } {
  const n = words.length;
  const order: number[] = [];
  // runs against the line's direction, in logical order
  const against = (w: WordRun): boolean => (rtlLine ? w.ltr && !w.rtl : w.rtl);
  let i = 0;
  while (i < n) {
    const w = words[i] as WordRun;
    if (!against(w)) {
      order.push(i++);
      continue;
    }
    const run: number[] = [];
    while (i < n && against(words[i] as WordRun)) run.push(i++);
    // a run in the other direction is drawn in that direction: reversed here, reversed back below for RTL
    order.push(...run.reverse());
  }
  const visual = rtlLine ? order.reverse() : order;
  const at = new Array<number>(n).fill(0);
  let x = 0;
  for (const k of visual) {
    const w = words[k] as WordRun;
    // the space follows a word in the line's direction: to its right in LTR, to its left in RTL
    if (rtlLine) x += w.space;
    at[k] = x;
    x += w.width;
    if (!rtlLine) x += w.space;
  }
  return { at, total: x };
}

/**
 * The CSS transform of a word box's wrapper (transform-origin 0 0) that puts the middle of the box's
 * baseline on its frame. With a `scale` (keyframes, which need one function list throughout) the box
 * is also scaled about that point.
 */
export function frameTransform(f: WordFrame, width: number, baseline: number, scale?: number): string {
  const s = scale === undefined ? "" : ` scale(${scale.toFixed(4)})`;
  return `translate(${f.x.toFixed(2)}px, ${f.y.toFixed(2)}px) rotate(${f.angle.toFixed(3)}deg)${s} translate(${(-width / 2).toFixed(2)}px, ${(-baseline).toFixed(2)}px)`;
}
