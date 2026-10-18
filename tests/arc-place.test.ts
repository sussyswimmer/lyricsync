import { describe, expect, it } from "vitest";
import {
  arcLength,
  arcPlacer,
  frameTransform,
  halfLength,
  LETTER_ORIGIN_Y,
  letterPlace,
  pointAt,
  reach,
  visualOffsets,
  wordFrames,
  xAtLength,
  type ArcCurve,
  type ArcWord,
  type LetterMetrics,
  type LetterPlace,
  type WordFrame,
  type WordRun,
} from "../src/overlay/modes/arc-place";

/*
 * Arc's placement, checked the way the browser applies it: a letter's CSS `translate` and `rotate`
 * around its transform-origin (50% of its box's width, LETTER_ORIGIN_Y of its height), inside its word
 * box, whose wrapper puts the middle of the box's baseline on the word's frame, turned by the frame's
 * angle. Where the middle of each letter's advance lands on screen must be on the parabola.
 */

const DEG = Math.PI / 180;
/** A 1920 px stage's path (5% to 95%), the default arch, a sag, and flat. */
const ARCH: ArcCurve = { xm: 960, mid: 470, bend: 172, halfWidth: 864 };
const SAG: ArcCurve = { ...ARCH, bend: -227 };
const FLAT: ArcCurve = { ...ARCH, bend: 0 };
const DEEP: ArcCurve = { ...ARCH, bend: 454 };
/** 58 px Fraunces in a 1.2 line box: the baseline 0.96 em down. */
const M: LetterMetrics = { baseline: 55.7, lineHeight: 69.6, spacing: 0 };

interface Letter {
  x: number;
  w: number;
}

/** A word of `n` letters each `w` px wide, `at` px along its line. */
function word(at: number, n: number, w = 30): { word: ArcWord; letters: Letter[] } {
  return { word: { at, width: n * w }, letters: Array.from({ length: n }, (_, j) => ({ x: j * w, w })) };
}

/** A line of words with `gap` px between them: the words, their letters and the line's advance. */
function line(counts: readonly number[], gap = 16, w = 30): { words: ArcWord[]; letters: Letter[][]; total: number } {
  let at = 0;
  const words: ArcWord[] = [];
  const letters: Letter[][] = [];
  counts.forEach((n, i) => {
    const made = word(at, n, w);
    words.push(made.word);
    letters.push(made.letters);
    at += made.word.width + (i < counts.length - 1 ? gap : 0);
  });
  return { words, letters, total: at };
}

const rot = (x: number, y: number, a: number): [number, number] => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];

/**
 * Where the middle of a letter's advance, on its baseline, lands on screen, and the direction its
 * baseline runs (degrees): the CSS of the letter (translate, rotate around its origin) inside its word
 * box, then the word box's wrapper (the frame).
 */
function onScreen(w: ArcWord, f: WordFrame, l: Letter, p: LetterPlace | null, m: LetterMetrics): { x: number; y: number; angle: number } {
  const ox = l.x + (l.w + m.spacing) / 2;
  const oy = LETTER_ORIGIN_Y * m.lineHeight;
  const cx = l.x + l.w / 2;
  const cy = m.baseline;
  const a = (p?.rotate ?? 0) * DEG;
  const [rx, ry] = rot(cx - ox, cy - oy, a);
  const bx = ox + (p?.dx ?? 0) + rx;
  const by = oy + (p?.dy ?? 0) + ry;
  const phi = f.angle * DEG;
  const [sx, sy] = rot(bx - w.width / 2, by - m.baseline, phi);
  return { x: f.x + sx, y: f.y + sy, angle: f.angle + (p?.rotate ?? 0) };
}

/** Every letter of a laid-out line, on screen, in order. */
function laidOut(c: ArcCurve, l: ReturnType<typeof line>, m = M): { x: number; y: number; angle: number }[] {
  const frames = wordFrames(c, l.words, l.total);
  const place = arcPlacer(c, l.words, frames, l.total, m);
  return l.words.flatMap((w, i) =>
    (l.letters[i] ?? []).map((box, j) => onScreen(w, frames[i] as WordFrame, box, place(i, j, { text: "x", part: 0, ...box }), m)),
  );
}

const yOn = (c: ArcCurve, x: number): number => c.mid + c.bend * ((x - c.xm) / c.halfWidth) ** 2;
const tangentDeg = (c: ArcCurve, x: number): number => Math.atan((2 * c.bend * (x - c.xm)) / c.halfWidth ** 2) / DEG;

describe("arcLength, xAtLength and reach", () => {
  it("is the plain distance on a flat path, and odd: negative to the left", () => {
    expect(arcLength(300, 864, 0)).toBe(300);
    expect(arcLength(-300, 864, 172)).toBeCloseTo(-arcLength(300, 864, 172), 9);
  });

  it("matches the parabola's polyline length", () => {
    for (const bend of [50, 172, 454, -300]) {
      let poly = 0;
      const n = 4000;
      for (let i = 1; i <= n; i++) {
        const x0 = ((i - 1) / n) * 864;
        const x1 = (i / n) * 864;
        poly += Math.hypot(x1 - x0, bend * ((x1 / 864) ** 2 - (x0 / 864) ** 2));
      }
      expect(arcLength(864, 864, bend) / poly).toBeCloseTo(1, 4);
    }
  });

  it("grows monotonically with x, never slower than x itself, and xAtLength inverts it", () => {
    for (const c of [ARCH, SAG, DEEP, FLAT]) {
      let last = -Infinity;
      for (let x = -864; x <= 864; x += 12) {
        const s = arcLength(x, c.halfWidth, c.bend);
        expect(s).toBeGreaterThan(last);
        expect(Math.abs(s)).toBeGreaterThanOrEqual(Math.abs(x) - 1e-9);
        expect(xAtLength(s, c)).toBeCloseTo(x, 6);
        last = s;
      }
    }
  });

  it("reaches as far as half the text along the path, and stops at its end", () => {
    expect(reach(0, 864, 172)).toBe(0);
    expect(reach(1e6, 864, 172)).toBe(1);
    expect(reach(600, 864, 0)).toBeCloseTo(600 / 2 / 864, 9);
    const r = reach(1000, 864, 172);
    expect(arcLength(r * 864, 864, 172)).toBeCloseTo(500, 3);
    expect(reach(1000, 864, 454)).toBeLessThan(r);
    expect(reach(1000, 0, 172)).toBe(0);
  });
});

describe("pointAt: the path, and straight on past its ends", () => {
  it("lies on the parabola with the parabola's tangent, between the ends", () => {
    for (const c of [ARCH, SAG, DEEP]) {
      const half = halfLength(c);
      for (let s = -half; s <= half; s += half / 25) {
        const p = pointAt(c, s);
        expect(p.y).toBeCloseTo(yOn(c, p.x), 6);
        expect(p.angle / DEG).toBeCloseTo(tangentDeg(c, p.x), 6);
        expect(arcLength(p.x - c.xm, c.halfWidth, c.bend)).toBeCloseTo(s, 6);
      }
    }
  });

  it("continues along each end's tangent, at the arc length past it", () => {
    for (const c of [ARCH, SAG]) {
      const half = halfLength(c);
      for (const side of [-1, 1]) {
        const end = pointAt(c, side * half);
        const past = pointAt(c, side * (half + 200));
        expect(Math.hypot(past.x - end.x, past.y - end.y)).toBeCloseTo(200, 6);
        expect(past.angle).toBeCloseTo(end.angle, 9);
        expect((past.y - end.y) / (past.x - end.x)).toBeCloseTo(Math.tan(end.angle), 6);
        expect(Math.sign(past.x - end.x)).toBe(side);
      }
    }
  });

  it("is a flat line on a degenerate stage", () => {
    const c: ArcCurve = { xm: 0, mid: 10, bend: 40, halfWidth: 0 };
    expect(pointAt(c, 30)).toEqual({ x: 30, y: 10, angle: 0 });
    expect(pointAt(c, -30)).toEqual({ x: -30, y: 10, angle: 0 });
  });
});

describe("placing a line's letters on the curve", () => {
  const LINES = [line([10, 3, 3, 6, 4, 3, 5]), line([2, 9, 1, 7]), line([12])];

  it("puts the middle of every letter's advance on the parabola, within 0.5 px", () => {
    for (const c of [ARCH, SAG, DEEP, FLAT])
      for (const l of LINES)
        for (const p of laidOut(c, l)) {
          expect(Math.abs(p.y - yOn(c, p.x)), `curve ${c.bend} at x ${p.x.toFixed(1)}`).toBeLessThan(0.5);
        }
  });

  it("turns every letter to the tangent there, within 0.5°", () => {
    for (const c of [ARCH, SAG, DEEP])
      for (const l of LINES)
        for (const p of laidOut(c, l)) {
          expect(Math.abs(p.angle - tangentDeg(c, p.x)), `curve ${c.bend} at x ${p.x.toFixed(1)}`).toBeLessThan(0.5);
        }
  });

  it("spaces letters along the curve by their advances: no kinks or gaps between words", () => {
    const l = LINES[0] as ReturnType<typeof line>;
    for (const c of [ARCH, DEEP]) {
      const pts = laidOut(c, l);
      const s = pts.map((p) => arcLength(p.x - c.xm, c.halfWidth, c.bend));
      // the advance between consecutive letter middles: 30 px in a word, 30 + 16 across a gap
      const centers = l.words.flatMap((w, i) => (l.letters[i] ?? []).map((b) => w.at + b.x + b.w / 2));
      for (let k = 1; k < s.length; k++) expect((s[k] ?? 0) - (s[k - 1] ?? 0)).toBeCloseTo((centers[k] ?? 0) - (centers[k - 1] ?? 0), 2);
    }
  });

  it("centers the line on the path's middle, as text-anchor: middle does", () => {
    const l = LINES[1] as ReturnType<typeof line>;
    for (const c of [ARCH, SAG]) {
      const pts = laidOut(c, l);
      const first = pts[0] as { x: number };
      const last = pts[pts.length - 1] as { x: number };
      // the first letter's middle is 15 px from the line's start, the last one's 15 px from its end
      expect(arcLength(first.x - c.xm, c.halfWidth, c.bend)).toBeCloseTo(-l.total / 2 + 15, 4);
      expect(arcLength(last.x - c.xm, c.halfWidth, c.bend)).toBeCloseTo(l.total / 2 - 15, 4);
    }
  });

  it("keeps letters within a few px of their word box's baseline, inside the karaoke window's padding", () => {
    for (const c of [ARCH, SAG, DEEP]) {
      const l = LINES[0] as ReturnType<typeof line>;
      const frames = wordFrames(c, l.words, l.total);
      const place = arcPlacer(c, l.words, frames, l.total, M);
      l.words.forEach((_, i) =>
        (l.letters[i] ?? []).forEach((box, j) => {
          const p = place(i, j, { text: "x", part: 0, ...box });
          expect(Math.abs(p?.dy ?? 0)).toBeLessThan(0.5 * 58);
          expect(Math.abs(p?.dx ?? 0)).toBeLessThan(0.25 * 58);
          expect(Math.abs(p?.rotate ?? 0)).toBeLessThan(15);
        }),
      );
    }
  });

  it("follows the extension past the path's ends for a line longer than the path", () => {
    const long = line([10, 10, 10, 10, 10, 10, 10]);
    expect(long.total).toBeGreaterThan(2 * halfLength(ARCH));
    const half = halfLength(ARCH);
    const right = pointAt(ARCH, half);
    const left = pointAt(ARCH, -half);
    const pts = laidOut(ARCH, long);
    const beyond = pts.filter((p) => p.x > right.x + 1 || p.x < left.x - 1);
    expect(beyond.length).toBeGreaterThan(4);
    for (const p of beyond) {
      const end = p.x > right.x ? right : left;
      // on the end's tangent line, turned like it
      expect(p.y - end.y).toBeCloseTo(Math.tan(end.angle) * (p.x - end.x), 1);
      expect(p.angle).toBeCloseTo(end.angle / DEG, 2);
    }
  });

  it("takes letter-spacing into each letter's box (its origin moves with it)", () => {
    const m: LetterMetrics = { ...M, spacing: 6 };
    const l = line([5, 4], 22, 36);
    for (const p of laidOut(ARCH, l, m)) expect(Math.abs(p.y - yOn(ARCH, p.x))).toBeLessThan(0.5);
  });

  it("gives a word drawn whole no placement: its frame puts its middle on the path", () => {
    const l = line([6, 4]);
    const frames = wordFrames(ARCH, l.words, l.total);
    const place = arcPlacer(ARCH, l.words, frames, l.total, M);
    expect(place(1, 0, { text: "word", x: 0, w: l.words[1]?.width ?? 0, part: 0 })).toBeNull();
    // and placing it as a letter would change nothing anyway
    const p = letterPlace(ARCH, l.words[1] as ArcWord, frames[1] as WordFrame, l.total, { x: 0, w: l.words[1]?.width ?? 0 }, M);
    expect(Math.abs(p.dx) + Math.abs(p.dy) + Math.abs(p.rotate)).toBeLessThan(1e-9);
    expect(place(5, 0, { text: "x", x: 0, w: 1, part: 0 })).toBeNull();
  });

  it("frames each word at the middle of its advance, turned to the tangent there", () => {
    const l = line([4, 4]);
    const frames = wordFrames(SAG, l.words, l.total);
    frames.forEach((f, i) => {
      const w = l.words[i] as ArcWord;
      const p = pointAt(SAG, -l.total / 2 + w.at + w.width / 2);
      expect(f.x).toBeCloseTo(p.x, 9);
      expect(f.y).toBeCloseTo(p.y, 9);
      expect(f.angle).toBeCloseTo(p.angle / DEG, 9);
    });
    // a flat path lays words out straight, centered on the middle
    const flat = wordFrames(FLAT, l.words, l.total);
    expect(flat.map((f) => f.angle)).toEqual([0, 0]);
    expect(flat[0]?.x).toBeCloseTo(960 - l.total / 2 + 60, 9);
  });

  it("writes the frame as one transform list, with a scale only when asked (keyframes)", () => {
    const f: WordFrame = { x: 100.004, y: 20.5, angle: -3.25 };
    expect(frameTransform(f, 80, 55.7)).toBe("translate(100.00px, 20.50px) rotate(-3.250deg) translate(-40.00px, -55.70px)");
    expect(frameTransform(f, 80, 55.7, 1)).toBe("translate(100.00px, 20.50px) rotate(-3.250deg) scale(1.0000) translate(-40.00px, -55.70px)");
  });
});

describe("visualOffsets: words in visual order", () => {
  const run = (width: number, rtl = false, ltr = !rtl): WordRun => ({ width, space: 10, rtl, ltr });

  it("lays a left-to-right line out in order, each space after its word", () => {
    const { at, total } = visualOffsets([run(50), run(30), run(40)], false);
    expect(at).toEqual([0, 60, 100]);
    expect(total).toBe(150);
  });

  it("lays a right-to-left line out from the right: the first word rightmost, each space on its left", () => {
    const { at, total } = visualOffsets([run(50, true), run(30, true), run(40, true)], true);
    expect(total).toBe(150);
    expect(at[0]).toBeGreaterThan(at[1] ?? Infinity);
    expect(at[1]).toBeGreaterThan(at[2] ?? Infinity);
    expect(at).toEqual([100, 60, 10]);
    // mirrored from the left-to-right layout
    expect(at[0]).toBe(total - 50);
  });

  it("keeps a run in the other direction in its own order", () => {
    // a right-to-left line with two left-to-right words in it: they read left to right, as a block
    const { at } = visualOffsets([run(50, true), run(30), run(40), run(20, true)], true);
    expect(at[1]).toBeLessThan(at[2] ?? -Infinity);
    expect(at[0]).toBeGreaterThan(at[2] ?? Infinity);
    expect(at[3]).toBeLessThan(at[1] ?? -Infinity);
    // a left-to-right line with a right-to-left run in it: the run reads right to left
    const mixed = visualOffsets([run(50), run(30, true), run(40, true), run(20)], false);
    expect(mixed.at[2]).toBeLessThan(mixed.at[1] ?? -Infinity);
    expect(mixed.at[0]).toBe(0);
    expect(mixed.at[3]).toBeGreaterThan(mixed.at[1] ?? Infinity);
  });

  it("treats weak words (numbers, punctuation) as the line's direction", () => {
    const { at } = visualOffsets([run(50, true), { width: 20, space: 10, rtl: false, ltr: false }, run(40, true)], true);
    expect(at[0]).toBeGreaterThan(at[1] ?? Infinity);
    expect(at[1]).toBeGreaterThan(at[2] ?? Infinity);
  });
});
