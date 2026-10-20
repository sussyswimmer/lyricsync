/**
 * A word scene (Graphics, core/wordscenes.ts), planned ahead as keyframes like the karaoke (pure, no
 * DOM): what a word of fire, sun, moon, snow, rain, lightning, hearts, gold, water or stars becomes as
 * it's sung. Every piece is drawn in the word's own box (`.kw-scene` in its overlay, line.ts), behind
 * its letters or in front of them, so the scene moves with the word wherever the style puts it; and
 * the lit letters take the scene's colors (`colors`: the word's `--ut-hl`, `--ut-hl2` and bloom).
 *
 * - fire: the word catches fire from left to right: flames lick up behind its letters, in its glow,
 *   and embers rise off it.
 * - sun: a half sun rises behind the word on a horizon at its baseline, its rays turning, and sets
 *   again as the line ends.
 * - moon: a pale moon rises behind it the same way, in its halo, with stars coming out around it.
 * - snow: flakes fall around the word and a drift piles up at its feet; the word shivers.
 * - rain: rain streaks past behind it and drops gather under its letters and fall.
 * - electric: bolts crackle around it, and the word jolts with every flash.
 * - love: little hearts rise off it while it beats like a heart.
 * - gold: it glitters, sparkles winking on and off over its letters.
 * - water: it stands in water that rises to its middle and sloshes, bubbles rising; the word bobs.
 * - stars: stars twinkle all around it.
 *
 * Every piece runs on transform and opacity, on its own song-time window, so the compositor draws it
 * and pause, seek and drift carry it with the song. Without motion (reduced motion, Effects 0) a
 * scene fades in and out where it stands, and the word itself doesn't move. Sizes are px for a word
 * `size` px tall; a seed makes each scene its own, and the same every time the song plays.
 */
import type { SceneId } from "../../core/wordscenes";
import { randomOf, reachOf } from "./decor";
import type { Track } from "./karaoke";
import { framesOf, keyPoints, num, sampleTimes, thin } from "./keyframes";

/** The word's box, px: its width, its font size, and its baseline's depth from the box's top. */
export interface SceneBox {
  w: number;
  size: number;
  baseline: number;
}

/** One piece of a scene, in the word's box. */
export interface ScenePiece {
  /** its CSS class (stage.css), which draws it */
  cls: string;
  /** behind the letters, or in front of them */
  layer: "back" | "front";
  /** where it is anchored (its transform-origin), px in the word's box... */
  x: number;
  y: number;
  /** ...its size, px... */
  w: number;
  h: number;
  /** ...and where in it the anchor is, 0..1 across and down */
  ox: number;
  oy: number;
  /** drawn inside this window only (a horizon, a pool of water), px in the word's box; `x` and `y` stay in the word's box */
  clip?: { x: number; y: number; w: number; h: number };
  track: Track;
}

/** The colors the word's lit letters and bloom take while it is its scene. */
export interface SceneColors {
  hl: string;
  hl2: string;
  /** its glow, behind the word */
  glow: string;
}

export interface Scene {
  id: SceneId;
  colors: SceneColors;
  pieces: ScenePiece[];
  /** the word's own answer (a shiver, a beat, a jolt, a bob) on its box's translate, rotate and scale; null for none */
  word: Track | null;
  /** song time the scene is over by */
  until: number;
}

export const SCENE_COLORS: Readonly<Record<SceneId, SceneColors>> = {
  fire: { hl: "#fff1b0", hl2: "#ff5a1f", glow: "rgba(255, 110, 30, 0.55)" },
  // over their own bright discs: near-white letters, the sun's going gold and the moon's blue
  sun: { hl: "#ffffff", hl2: "#ffe0a8", glow: "rgba(255, 150, 60, 0.4)" },
  moon: { hl: "#f4f6ff", hl2: "#93a6ff", glow: "rgba(170, 190, 255, 0.35)" },
  snow: { hl: "#ffffff", hl2: "#8fd3ff", glow: "rgba(160, 215, 255, 0.4)" },
  rain: { hl: "#e6f6ff", hl2: "#5aaeff", glow: "rgba(120, 190, 255, 0.35)" },
  electric: { hl: "#f2fbff", hl2: "#56c8ff", glow: "rgba(110, 200, 255, 0.5)" },
  love: { hl: "#ffc8d8", hl2: "#ff3d71", glow: "rgba(255, 80, 130, 0.45)" },
  gold: { hl: "#fff4b8", hl2: "#d49a14", glow: "rgba(255, 200, 80, 0.45)" },
  water: { hl: "#d2f6ff", hl2: "#1e9bd7", glow: "rgba(80, 180, 240, 0.35)" },
  stars: { hl: "#fffbe8", hl2: "#b6a4ff", glow: "rgba(170, 150, 255, 0.35)" },
};

/** A scene shows at least this long from its word's start, at most this long, and leaves this long after its line is sung, ms. */
const MIN_MS = 2600;
const MAX_MS = 9000;
const AFTER_MS = 500;
/** Every piece is gone by the scene's end, fading out over at least this long, ms. */
const SCENE_FADE_MS = 250;
/** Pieces are sampled this often; the compositor eases in between. */
const SCENE_MS = 1000 / 30;
/** Keyframes are kept where a straight line would miss by more than this: x and y px, degrees, scale across and along, opacity. */
const SCENE_THIN = [0.4, 0.4, 0.8, 0.01, 0.01, 0.02];
const WORD_THIN = [0.3, 0.3, 0.4, 0.006];

type Pose = [x: number, y: number, deg: number, sx: number, sy: number, opacity: number];

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);
const easeOut = (u: number): number => 1 - (1 - clamp01(u)) ** 3;
const easeIn = (u: number): number => clamp01(u) ** 2;

/** In over `fadeIn` ms from `t0`, out over `fadeOut` ms before `t1`. */
function presence(t: number, t0: number, t1: number, fadeIn: number, fadeOut: number): number {
  return Math.min(clamp01((t - t0) / fadeIn), clamp01((t1 - t) / fadeOut));
}

/**
 * A piece's track over [t0, t1]: sampled every SCENE_MS (and at `keys`, times that must land
 * exactly, such as a flash's edges), thinned. Without motion, it stands still in its pose at `rest`
 * and only fades in and out.
 */
function trackOf(t0: number, t1: number, still: boolean, rest: number, at: (t: number) => Pose, keys: readonly number[] = []): Track {
  const duration = Math.max(1, t1 - t0);
  const pose = still
    ? ((): ((t: number) => Pose) => {
        const p = at(rest);
        const shown = p[5] > 0.05 ? p[5] : 1;
        return (t) => [p[0], p[1], p[2], p[3], p[4], shown * presence(t, t0, t1, 220, 400)];
      })()
    : // whatever a piece is doing as the scene ends (a heart still rising), it fades out with it
      (t: number): Pose => {
        const p = at(t);
        return [p[0], p[1], p[2], p[3], p[4], p[5] * clamp01((t1 - t) / SCENE_FADE_MS)];
      };
  const extra = still ? [] : keys.map((t) => t - t0).filter((ms) => ms > 0 && ms < duration);
  const times = extra.length > 0 ? [...new Set([...sampleTimes(duration, SCENE_MS), ...extra])].sort((a, b) => a - b) : sampleTimes(duration, SCENE_MS);
  const samples = times.map((ms) => pose(t0 + ms));
  const channels = SCENE_THIN.map((_, c) => samples.map((s) => s[c] ?? 0));
  const keep = thin(times, channels, SCENE_THIN);
  const points = keyPoints(times, keep, channels, null);
  return {
    t0,
    duration,
    frames: framesOf(points, duration, ([x, y, r, a, b, o]) => ({
      transform: `translate(${num(x ?? 0, 2)}px, ${num(y ?? 0, 2)}px) rotate(${num(r ?? 0, 2)}deg) scale(${num(a ?? 1, 3)}, ${num(b ?? 1, 3)})`,
      opacity: num(clamp01(o ?? 0), 3),
    })),
  };
}

/** The word's own answer over [t0, t1]: dx, dy px and a uniform scale; at rest at both ends. */
function wordTrack(t0: number, t1: number, at: (t: number) => [dx: number, dy: number, deg: number, s: number]): Track {
  const duration = Math.max(1, t1 - t0);
  const times = sampleTimes(duration, SCENE_MS);
  const samples = times.map((ms, i): [number, number, number, number] => (i === 0 || i === times.length - 1 ? [0, 0, 0, 1] : at(t0 + ms)));
  const channels = WORD_THIN.map((_, c) => samples.map((s) => s[c] ?? 0));
  const keep = thin(times, channels, WORD_THIN);
  const points = keyPoints(times, keep, channels, null);
  return {
    t0,
    duration,
    frames: framesOf(points, duration, ([dx, dy, r, s]) => ({
      translate: `${num(dx ?? 0, 2)}px ${num(dy ?? 0, 2)}px`,
      rotate: `${num(r ?? 0, 2)}deg`,
      scale: `${num(s ?? 1, 4)} ${num(s ?? 1, 4)}`,
    })),
  };
}

/** The scene word `id` becomes, sung from `at`, its line sung by `until`. */
export function planScene(id: SceneId, at: number, until: number, box: SceneBox, amp: number, seed: number): Scene {
  const k = reachOf(amp);
  const still = k === 0;
  const end = at + clamp(until + AFTER_MS - at, MIN_MS, MAX_MS);
  const t0 = at - 80;
  const rand = randomOf(seed ^ 0x2c9277b5);
  const plan = SCENES[id];
  const { pieces, word } = plan({ at, t0, end, box, k, still, rand });
  return { id, colors: SCENE_COLORS[id], pieces, word: still ? null : word, until: end };
}

interface Ctx {
  at: number;
  t0: number;
  end: number;
  box: SceneBox;
  /** how far things travel: 0 without motion */
  k: number;
  still: boolean;
  rand: () => number;
}

type Planner = (c: Ctx) => { pieces: ScenePiece[]; word: Track | null };

/** The word's glow, behind it, in the scene's color. */
function glow(c: Ctx, flicker: (t: number) => number = () => 1): ScenePiece {
  const { box, at, t0, end, still } = c;
  const L = box.size;
  return {
    cls: "sc-glow",
    layer: "back",
    x: box.w / 2,
    y: box.baseline - 0.35 * L,
    w: box.w + 1.6 * L,
    h: 1.7 * L,
    ox: 0.5,
    oy: 0.5,
    track: trackOf(t0, end, still, at + 600, (t) => [0, 0, 0, 1, 1, presence(t, at - 40, end, 260, 500) * flicker(t)]),
  };
}

/** A half disc rising behind the word on a horizon at its baseline (the sun, the moon), and the line of that horizon. */
function horizon(c: Ctx, cls: string, radius: number, extras: (sink: (t: number) => number, clip: ScenePiece["clip"], cx: number, cy: number) => ScenePiece[]): ScenePiece[] {
  const { box, at, t0, end, still } = c;
  const L = box.size;
  const R = radius;
  const B = box.baseline;
  const clip = { x: box.w / 2 - 1.7 * R, y: B - 1.7 * R, w: 3.4 * R, h: 1.7 * R };
  // risen over its first 0.9 s, setting again over the last 0.7 s
  const sink = (t: number): number => R * (0.96 * (1 - easeOut((t - at) / 900)) + easeIn((t - (end - 700)) / 700));
  const disc: ScenePiece = {
    cls,
    layer: "back",
    x: box.w / 2,
    y: B,
    w: 2 * R,
    h: 2 * R,
    ox: 0.5,
    oy: 0.5,
    clip,
    track: trackOf(t0, end, still, at + 1200, (t) => {
      const breathe = 1 + 0.015 * Math.sin((t - at) / 600);
      return [0, sink(t), 0, breathe, breathe, 0.9 * presence(t, at - 40, end, 200, 260)];
    }),
  };
  const line: ScenePiece = {
    cls: "sc-line",
    layer: "back",
    x: box.w / 2,
    y: B + 0.02 * L,
    w: 3.4 * R,
    h: Math.max(2, 0.05 * L),
    ox: 0.5,
    oy: 0.5,
    track: trackOf(t0, end, still, at + 800, (t) => [0, 0, 0, 0.4 + 0.6 * easeOut((t - at) / 700), 1, presence(t, at, end, 300, 500)]),
  };
  return [...extras(sink, clip, box.w / 2, B), disc, line];
}

/** Four-point stars that twinkle around the word. */
function twinkles(c: Ctx, n: number, layer: ScenePiece["layer"], band: { above: number; below: number }, cls = "sc-twinkle"): ScenePiece[] {
  const { box, at, t0, end, still, rand } = c;
  const L = box.size;
  const out: ScenePiece[] = [];
  for (let i = 0; i < n; i++) {
    const x = -0.45 * L + (box.w + 0.9 * L) * ((i + 0.15 + 0.7 * rand()) / n);
    const y = box.baseline - band.above * L + (band.above - band.below) * L * rand();
    const side = (0.16 + 0.18 * rand()) * L;
    const period = 700 + 700 * rand();
    const ph = rand() * Math.PI * 2;
    const from = at + 120 + 900 * rand();
    out.push({
      cls,
      layer,
      x,
      y,
      w: side,
      h: side,
      ox: 0.5,
      oy: 0.5,
      track: trackOf(t0, end, still, from + 200, (t) => {
        const tw = 0.55 + 0.45 * Math.sin(ph + ((t - from) / period) * Math.PI * 2);
        const s = easeOut((t - from) / 300) * tw;
        return [0, 0, 20 * Math.sin(ph + (t - from) / 900), s, s, presence(t, from, end, 200, 400) * (0.5 + 0.5 * tw)];
      }),
    });
  }
  return out;
}

const SCENES: Readonly<Record<SceneId, Planner>> = {
  fire(c) {
    const { box, at, t0, end, still, rand, k } = c;
    const L = box.size;
    const n = Math.round(clamp(box.w / (0.3 * L), 3, 14));
    const pieces: ScenePiece[] = [glow(c, (t) => 0.85 + 0.15 * Math.sin((t - at) / 47) * Math.sin((t - at) / 113))];
    // flames lick up behind the letters, catching from left to right
    for (let i = 0; i < n; i++) {
      const lit = at + (220 * i) / n;
      const tall = (1.15 + 0.6 * rand()) * L;
      const ph = [rand(), rand(), rand(), rand()].map((v) => v * Math.PI * 2) as [number, number, number, number];
      pieces.push({
        cls: "sc-flame",
        layer: "back",
        x: (box.w * (i + 0.5)) / n + (rand() - 0.5) * 0.12 * L,
        y: box.baseline - 0.3 * L,
        w: (0.36 + 0.14 * rand()) * L,
        h: tall,
        ox: 0.5,
        oy: 1,
        track: trackOf(t0, end, still, lit + 500, (t) => {
          const grow = easeOut((t - lit) / 260) * (1 - easeIn((t - (end - 450)) / 450));
          const sy = grow * (0.9 + 0.14 * Math.sin(ph[0] + (t - lit) / 57) + 0.08 * Math.sin(ph[1] + (t - lit) / 23));
          const sx = 1 + 0.07 * Math.sin(ph[2] + (t - lit) / 41);
          return [0.03 * L * k * Math.sin(ph[3] + (t - lit) / 77), 0, 5 * k * Math.sin(ph[0] + (t - lit) / 95), sx, Math.max(0.05, sy), presence(t, lit, end, 120, 450)];
        }),
      });
    }
    // embers rise off it
    const embers = Math.round(clamp((end - at) / 260, 5, 16));
    for (let j = 0; j < embers; j++) {
      const from = at + 150 + Math.max(0, end - at - 1500) * rand();
      const life = 900 + 500 * rand();
      const sway = (rand() - 0.5) * 0.4 * L;
      const side = (0.06 + 0.05 * rand()) * L;
      pieces.push({
        cls: "sc-ember",
        layer: "front",
        x: box.w * rand(),
        y: box.baseline - 0.75 * L,
        w: side,
        h: side,
        ox: 0.5,
        oy: 0.5,
        track: trackOf(t0, end, still, from + 200, (t) => {
          const u = clamp01((t - from) / life);
          return [sway * Math.sin(u * Math.PI), -1.3 * L * k * u, 0, 1 - 0.5 * u, 1 - 0.5 * u, presence(t, from, from + life, 80, 0.6 * life)];
        }),
      });
    }
    // the word shimmers in the heat
    const word = wordTrack(at, Math.min(end, at + 2200), (t) => [0, 0, 0, 1 + 0.012 * k * Math.sin((t - at) / 37) * Math.sin((t - at) / 91 + 1)]);
    return { pieces, word };
  },

  sun(c) {
    const { box, at, t0, end, still } = c;
    const L = box.size;
    const R = clamp(0.6 * box.w, 0.85 * L, 1.7 * L);
    const pieces = horizon(c, "sc-sun", R, (sink, clip, cx, cy) => [
      glow(c),
      {
        cls: "sc-rays",
        layer: "back",
        x: cx,
        y: cy,
        w: 3.3 * R,
        h: 3.3 * R,
        ox: 0.5,
        oy: 0.5,
        clip,
        track: trackOf(t0, end, still, at + 1200, (t) => [0, sink(t), ((t - at) / 1000) * 9, 1, 1, 0.85 * presence(t, at + 150, end, 500, 300)]),
      },
    ]);
    return { pieces, word: null };
  },

  moon(c) {
    const { box, at, t0, end, still } = c;
    const L = box.size;
    const R = clamp(0.48 * box.w, 0.7 * L, 1.35 * L);
    const pieces = horizon(c, "sc-moon", R, (sink, clip, cx, cy) => [
      {
        cls: "sc-halo",
        layer: "back",
        x: cx,
        y: cy,
        w: 3.2 * R,
        h: 3.2 * R,
        ox: 0.5,
        oy: 0.5,
        clip,
        track: trackOf(t0, end, still, at + 1200, (t) => [0, sink(t), 0, 1, 1, presence(t, at + 100, end, 600, 300)]),
      },
    ]);
    return { pieces: [...pieces, ...twinkles(c, 5, "back", { above: 1.9, below: 1.05 })], word: null };
  },

  snow(c) {
    const { box, at, t0, end, still, rand, k } = c;
    const L = box.size;
    const pieces: ScenePiece[] = [glow(c)];
    // flakes fall around the word, all the while it shows
    const n = Math.round(clamp((end - at) / 200, 10, 28));
    for (let i = 0; i < n; i++) {
      const life = 1800 + 900 * rand();
      const from = at - 200 + Math.max(0, end - at - life) * (i / n) + 300 * rand();
      const side = (0.16 + 0.16 * rand()) * L;
      const sway = (0.1 + 0.12 * rand()) * L;
      const ph = rand() * Math.PI * 2;
      const fall = (1.9 + 0.5 * rand()) * L;
      pieces.push({
        cls: "sc-flake",
        layer: rand() < 0.35 ? "back" : "front",
        x: -0.35 * L + (box.w + 0.7 * L) * rand(),
        y: box.baseline - 1.75 * L,
        w: side,
        h: side,
        ox: 0.5,
        oy: 0.5,
        track: trackOf(t0, end, still, from + life / 2, (t) => {
          const u = clamp01((t - from) / life);
          return [sway * k * Math.sin(ph + (t - from) / 420), fall * u, 120 * u, 1, 1, presence(t, from, from + life, 200, 400) * presence(t, t0, end, 1, 400)];
        }),
      });
    }
    // a drift piles up at its feet
    pieces.push({
      cls: "sc-drift",
      layer: "front",
      x: box.w / 2,
      y: box.baseline + 0.26 * L,
      w: box.w + 0.6 * L,
      h: 0.5 * L,
      ox: 0.5,
      oy: 1,
      track: trackOf(t0, end, still, at + 2000, (t) => [0, 0, 0, 1, 0.15 + 0.85 * easeOut((t - at) / Math.max(800, Math.min(2600, end - at - 600))), presence(t, at, end, 300, 450)]),
    });
    // a shiver as it's sung
    const word = wordTrack(at, at + 520, (t) => [0.012 * L * k * Math.sin((t - at) / 17) * (1 - (t - at) / 520), 0, 0, 1]);
    return { pieces, word };
  },

  rain(c) {
    const { box, at, t0, end, still, rand, k } = c;
    const L = box.size;
    const pieces: ScenePiece[] = [glow(c)];
    // rain streaks past behind it
    const n = Math.round(clamp((end - at) / 110, 10, 40));
    for (let i = 0; i < n; i++) {
      const from = at - 100 + Math.max(0, end - at - 600) * (i / n) + 120 * rand();
      const life = 380 + 160 * rand();
      const drop = 2.3 * L;
      pieces.push({
        cls: "sc-streak",
        layer: "back",
        x: -0.5 * L + (box.w + 1.0 * L) * rand(),
        y: box.baseline - 1.7 * L,
        w: Math.max(2, 0.04 * L),
        h: 0.6 * L,
        ox: 0.5,
        oy: 0,
        track: trackOf(t0, end, still, from + life / 2, (t) => {
          const u = clamp01((t - from) / life);
          return [-0.25 * drop * u, drop * u, 14, 1, 1, 0.8 * presence(t, from, from + life, 60, 120)];
        }),
      });
    }
    // drops gather under its letters and fall, one after another
    const m = Math.round(clamp(box.w / (0.75 * L), 2, 5));
    for (let j = 0; j < m; j++) {
      for (let cycle = 0; cycle < 3; cycle++) {
        const from = at + 150 + j * 230 + cycle * 1300 + 200 * rand();
        if (from + 700 > end) continue;
        pieces.push({
          cls: "sc-drip",
          layer: "front",
          x: (box.w * (j + 0.5)) / m + (rand() - 0.5) * 0.2 * L,
          y: box.baseline - 0.04 * L,
          w: 0.16 * L,
          h: 0.26 * L,
          ox: 0.5,
          oy: 0,
          track: trackOf(t0, end, still, from + 250, (t) => {
            const hang = easeOut((t - from) / 320);
            const u = clamp01((t - from - 320) / 420);
            return [0, 0.95 * L * k * u * u, 0, 0.6 + 0.4 * hang, 0.4 + 0.6 * hang + 0.3 * u, presence(t, from, from + 740, 80, 160)];
          }),
        });
      }
    }
    return { pieces, word: null };
  },

  electric(c) {
    const { box, at, t0, end, still, rand, k } = c;
    const L = box.size;
    // flashes: short, at uneven intervals
    const flashes: number[] = [];
    for (let t = at + 40; t < end - 300; t += 180 + 380 * rand()) flashes.push(t);
    const FLASH_MS = 110;
    const flashing = (t: number): number => {
      for (const f of flashes) if (t >= f && t < f + FLASH_MS) return 1 - (t - f) / FLASH_MS;
      return 0;
    };
    const keys = flashes.flatMap((f) => [f, f + 1, f + FLASH_MS]);
    const pieces: ScenePiece[] = [glow(c, (t) => 0.35 + 0.65 * flashing(t))];
    const spots: [number, number, number][] = [
      [-0.15 * L, box.baseline - 1.0 * L, -25],
      [box.w + 0.15 * L, box.baseline - 1.0 * L, 25],
      [box.w / 2, box.baseline - 1.3 * L, 0],
    ];
    spots.forEach(([x, y, deg], i) => {
      // each bolt flashes on its own share of the flashes
      const mine = flashes.filter((_, f) => f % spots.length === i || rand() < 0.25);
      pieces.push({
        cls: "sc-bolt",
        layer: "front",
        x,
        y,
        w: 0.6 * L,
        h: 1.1 * L,
        ox: 0.5,
        oy: 0.5,
        track: trackOf(
          t0,
          end,
          still,
          at + 200,
          (t) => {
            let on = 0;
            for (const f of mine) if (t >= f && t < f + FLASH_MS) on = 1;
            const s = 0.9 + 0.2 * on;
            return [0, 0, deg, s, s, still ? 0.9 : on];
          },
          keys,
        ),
      });
    });
    // the word jolts with every flash
    const word = wordTrack(at, end, (t) => {
      const f = flashing(t);
      return [0.025 * L * k * f * (Math.floor(t / 37) % 2 === 0 ? 1 : -1), -0.01 * L * k * f, 0, 1 + 0.03 * k * f];
    });
    return { pieces, word };
  },

  love(c) {
    const { box, at, t0, end, still, rand, k } = c;
    const L = box.size;
    // a heartbeat: lub-dub, every 0.9 s
    const beat = (t: number): number => {
      const ms = (t - at) % 900;
      const one = (x: number): number => (x >= 0 && x < 160 ? Math.sin((x / 160) * Math.PI) : 0);
      return t < at ? 0 : Math.max(one(ms), 0.7 * one(ms - 210));
    };
    const pieces: ScenePiece[] = [glow(c, (t) => 0.7 + 0.3 * beat(t))];
    const n = Math.round(clamp((end - at) / 420, 4, 14));
    for (let i = 0; i < n; i++) {
      const from = at + 100 + Math.max(0, end - at - 1800) * (i / n) + 200 * rand();
      const life = 1300 + 500 * rand();
      const side = (0.3 + 0.22 * rand()) * L;
      const sway = (rand() - 0.5) * 0.5 * L;
      const tilt = (rand() - 0.5) * 30;
      pieces.push({
        cls: "sc-heart",
        layer: rand() < 0.3 ? "back" : "front",
        x: box.w * (0.1 + 0.8 * rand()),
        y: box.baseline - 0.55 * L,
        w: side,
        h: side,
        ox: 0.5,
        oy: 0.5,
        track: trackOf(t0, end, still, from + 300, (t) => {
          const u = clamp01((t - from) / life);
          const s = 0.5 + 0.5 * easeOut(u * 4);
          return [sway * Math.sin(u * Math.PI), -1.5 * L * k * u, tilt * Math.sin(u * Math.PI * 2), s, s, presence(t, from, from + life, 120, 0.5 * life)];
        }),
      });
    }
    const word = wordTrack(at, Math.min(end, at + 2700), (t) => [0, 0, 0, 1 + 0.07 * k * beat(t)]);
    return { pieces, word };
  },

  gold(c) {
    const { box, at, t0, end, still, rand } = c;
    const L = box.size;
    const pieces: ScenePiece[] = [glow(c, (t) => 0.8 + 0.2 * Math.sin((t - at) / 300))];
    // sparkles wink on and off over its letters
    const n = Math.round(clamp((end - at) / 230, 6, 20));
    for (let i = 0; i < n; i++) {
      const from = at + 60 + Math.max(0, end - at - 900) * (i / n) + 150 * rand();
      const life = 520 + 320 * rand();
      const side = (0.32 + 0.26 * rand()) * L;
      pieces.push({
        cls: "sc-sparkle",
        layer: "front",
        x: -0.15 * L + (box.w + 0.3 * L) * rand(),
        y: box.baseline - (0.05 + 0.9 * rand()) * L,
        w: side,
        h: side,
        ox: 0.5,
        oy: 0.5,
        track: trackOf(t0, end, still, from + life / 2, (t) => {
          const u = clamp01((t - from) / life);
          const s = Math.sin(u * Math.PI);
          return [0, 0, 90 * u, s, s, s > 0 ? 1 : 0];
        }),
      });
    }
    return { pieces, word: null };
  },

  water(c) {
    const { box, at, t0, end, still, rand, k } = c;
    const L = box.size;
    const B = box.baseline;
    // a pool around the word: it rises to the middle of its letters, and sloshes
    const clip = { x: -0.8 * L, y: B - 1.1 * L, w: box.w + 1.6 * L, h: 1.55 * L };
    const level = B - 0.36 * L;
    const rise = (t: number): number => (1 - easeOut((t - at) / 900)) * 1.1 * L + easeIn((t - (end - 600)) / 600) * 1.1 * L;
    const pieces: ScenePiece[] = [
      glow(c),
      {
        cls: "sc-water",
        layer: "front",
        x: clip.x - 0.3 * L,
        y: level,
        w: clip.w + 0.6 * L,
        h: B + 0.45 * L - level,
        ox: 0,
        oy: 0,
        clip,
        track: trackOf(t0, end, still, at + 1200, (t) => [0.25 * L * k * Math.sin((t - at) / 520), rise(t) + 0.03 * L * k * Math.sin((t - at) / 310), 0, 1, 1, presence(t, at - 40, end, 200, 300)]),
      },
    ];
    // bubbles rise from it
    const n = Math.round(clamp((end - at) / 400, 3, 10));
    for (let i = 0; i < n; i++) {
      const from = at + 600 + Math.max(0, end - at - 1700) * (i / n) + 200 * rand();
      const life = 700 + 400 * rand();
      const side = (0.08 + 0.08 * rand()) * L;
      pieces.push({
        cls: "sc-bubble",
        layer: "front",
        x: box.w * (0.1 + 0.8 * rand()),
        y: level + 0.1 * L,
        w: side,
        h: side,
        ox: 0.5,
        oy: 0.5,
        track: trackOf(t0, end, still, from + 200, (t) => {
          const u = clamp01((t - from) / life);
          return [0.06 * L * Math.sin(u * 9), -0.7 * L * k * u, 0, 1, 1, presence(t, from, from + life, 100, 200)];
        }),
      });
    }
    const word = wordTrack(at, end, (t) => [0, 0.035 * L * k * Math.sin((t - at) / 420) * presence(t, at, end, 400, 400), 1.5 * k * Math.sin((t - at) / 520) * presence(t, at, end, 400, 400), 1]);
    return { pieces, word };
  },

  stars(c) {
    return { pieces: [glow(c), ...twinkles(c, 5, "back", { above: 1.7, below: -0.2 }), ...twinkles(c, 4, "front", { above: 1.3, below: 0.9 })], word: null };
  },
};
