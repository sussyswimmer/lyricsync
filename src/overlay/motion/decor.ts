/**
 * Effects mode's extras on a sung word, planned ahead as keyframes like the karaoke (pure, no DOM):
 *
 * - picture: a tiny picture of what the word names (core/wordpics.ts) pops in above the word as it's
 *   sung, floats up a little and fades. Some live while they show (planPictureLife): a flame flickers in
 *   its own glow, a lamp glows, a star twinkles, a heart beats. Without motion (reduced motion,
 *   Effects 0) a picture only fades in and out where it stands.
 * - splash: a burst from the word at one of the song's big moments (core/flair.ts), in the song's
 *   highlight and lyric colors: droplets that arc up and fall, streaks, tumbling confetti, rings
 *   spreading out, or a few twinkling glints. Only with motion.
 *
 * Every piece runs on transform and opacity alone, each on its own song-time window, so the compositor
 * draws it and pause, seek and drift carry it with the song (timeline.ts). Sizes are in px for a line
 * `size` px tall; a seed makes each word's burst its own, and the same every time the song plays.
 */
import { planDecor, type Flair, type LineDecor, type SplashKind } from "../../core/flair";
import type { Line } from "../../core/lrc";
import type { EmphasisRule } from "../../core/songlook";
import type { PictureId } from "../../core/wordpics";
import type { Track } from "./karaoke";
import { framesOf, keyPoints, num, sampleTimes, thin } from "./keyframes";
import type { Power } from "./power";

/** A picture is this many font sizes across... */
export const PICTURE_EM = 0.6;
/** ...and shows for this long from its word's start, ms. */
export const PICTURE_MS = 2400;
/** A splash starts this long after its word does, as the word's own motion gets going, ms. */
export const SPLASH_DELAY_MS = 60;
/** Bursts are sampled this often; the compositor interpolates in between. */
const BURST_MS = 1000 / 30;
/** Every piece of a burst fades in over this long, ms. */
const FADE_IN_MS = 40;

/** A small, fast, deterministic random sequence in [0, 1) (mulberry32). */
export function randomOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed from text (FNV-1a). */
export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** How far the extras travel for amplitude A (params.ts): 0 without motion, about 1 for a typical song. */
export function reachOf(amp: number): number {
  return amp > 0 ? Math.min(1.3, 0.55 + 0.35 * amp) : 0;
}

// ─────────────────────────────────────────── pictures ───────────────────────────────────────────

/** Where a picture sits, beside where its word box would draw it: px right and down, and a tilt in degrees. */
export interface PicturePose {
  dx: number;
  dy: number;
  tilt: number;
}

/**
 * A picture's resting place above its word (or `below` it): a little off center and tilted, its own
 * way for each seed.
 */
export function picturePose(size: number, seed: number, below = false): PicturePose {
  const rand = randomOf(seed);
  const side = rand() < 0.5 ? -1 : 1;
  return { dx: side * (0.08 + 0.14 * rand()) * size, dy: (below ? 0.02 : -0.04) * size, tilt: side * (5 + 7 * rand()) };
}

const pose = (y: number, deg: number, s: number): string => `translate(0px, ${num(y, 2)}px) rotate(${num(deg, 2)}deg) scale(${num(s, 3)})`;

/**
 * A picture's motion from song time `at` (its word's start): with motion it pops in from small and low
 * past its size and settles, rises slowly while it shows, and shrinks a little as it fades; without,
 * it fades in, holds and fades out. A picture `below` its word (one on a wrapped line's later row)
 * moves the other way: in from just under the word, drifting down.
 */
export function planPicture(at: number, size: number, amp: number, below = false): Track {
  const reach = reachOf(amp);
  const D = PICTURE_MS;
  if (reach === 0) {
    const still = pose(0, 0, 1);
    return {
      t0: at,
      duration: D,
      frames: [
        { transform: still, opacity: 0, offset: 0 },
        { transform: still, opacity: 1, offset: 220 / D },
        { transform: still, opacity: 1, offset: 1900 / D },
        { transform: still, opacity: 0, offset: 1 },
      ],
    };
  }
  const k = reach;
  const y = (em: number): number => (below ? -em : em) * size * k;
  return {
    t0: at,
    duration: D,
    frames: [
      { transform: pose(y(0.28), -14 * k, 0.35), opacity: 0, offset: 0, easing: "ease-out" },
      { transform: pose(y(0.06), -6 * k, 0.8), opacity: 1, offset: 120 / D, easing: "ease-out" },
      { transform: pose(y(-0.05), 4 * k, 1.12), opacity: 1, offset: 210 / D, easing: "ease-in-out" },
      { transform: pose(0, 0, 1), opacity: 1, offset: 360 / D, easing: "ease-in-out" },
      { transform: pose(y(-0.13), -2 * k, 1), opacity: 1, offset: 1900 / D, easing: "ease-in" },
      { transform: pose(y(-0.22), -3 * k, 0.86), opacity: 0, offset: 1 },
    ],
  };
}

// ──────────────────────────────────────── living pictures ────────────────────────────────────────

/**
 * How a picture lives while it shows, besides popping in and floating up (only with motion, on the
 * picture's own window): a flame flickers in its own glow and a big one throws embers; a lamp, the sun
 * or the moon glows; a star, a sparkler, fireworks or a diamond twinkles; a heart beats; a butterfly
 * beats its wings. The picture's motion is on its `scale` (its pose keeps `translate` and `rotate`).
 */
export type PictureLife = "flicker" | "glow" | "twinkle" | "beat" | "flutter";

export const PICTURE_LIFE: Readonly<Partial<Record<PictureId, PictureLife>>> = {
  fire: "flicker",
  campfire: "flicker",
  candle: "flicker",
  lighter: "flicker",
  match: "flicker",
  "light-bulb": "glow",
  lantern: "glow",
  "street-lamp": "glow",
  moon: "glow",
  sun: "glow",
  star: "twinkle",
  sparkler: "twinkle",
  fireworks: "twinkle",
  diamond: "twinkle",
  heart: "beat",
  butterfly: "flutter",
};

/** The light a glowing picture gives off, behind it. */
const AURA: Readonly<Partial<Record<PictureId, string>>> = {
  fire: "rgba(255, 128, 32, 0.55)",
  campfire: "rgba(255, 120, 28, 0.55)",
  candle: "rgba(255, 176, 72, 0.5)",
  lighter: "rgba(255, 160, 56, 0.45)",
  match: "rgba(255, 160, 56, 0.45)",
  "light-bulb": "rgba(255, 196, 110, 0.5)",
  lantern: "rgba(255, 96, 56, 0.45)",
  "street-lamp": "rgba(255, 206, 128, 0.45)",
  moon: "rgba(200, 220, 255, 0.35)",
  sun: "rgba(255, 196, 72, 0.5)",
};

/** How many embers a big flame throws. */
const EMBERS: Readonly<Partial<Record<PictureId, number>>> = { fire: 3, campfire: 4 };

/** A flicker is sampled this often, and a glow's breath, ms (both divide PICTURE_MS); the compositor eases in between. */
const FLICKER_MS = 80;
const BREATH_MS = 300;

/** What a living picture adds to a picture shown at `at`: each track on the song's clock. */
export interface PictureLifePlan {
  /** the picture's own motion, on its `scale` */
  pic: Track | null;
  /** the light behind it (moving with the picture, planPicture) and how it flickers or breathes */
  aura: { color: string; track: Track } | null;
  /** embers rising from a flame, inside its light */
  embers: Particle[];
}

const LIFELESS: PictureLifePlan = { pic: null, aura: null, embers: [] };

/**
 * Picture `id`'s life, shown at `at` and `side` px across: none without motion (amp 0) or for a
 * picture that doesn't live. Seeded, so a song looks the same every time it plays.
 */
export function planPictureLife(id: PictureId, at: number, side: number, amp: number, seed: number): PictureLifePlan {
  const kind = PICTURE_LIFE[id];
  if (!kind || reachOf(amp) === 0) return LIFELESS;
  const rand = randomOf(seed ^ 0x9e3779b9);
  const D = PICTURE_MS;
  const track = (frames: Keyframe[]): Track => ({ t0: at, duration: D, frames });
  const color = AURA[id];
  const aura = (frames: Keyframe[]): PictureLifePlan["aura"] => (color ? { color, track: track(frames) } : null);
  const scale = (x: number, y = x): string => `${num(x, 3)} ${num(y, 3)}`;
  switch (kind) {
    case "flicker": {
      // a big flame dances; a candle's, a lighter's or a match's only trembles
      const big = EMBERS[id] !== undefined ? 1 : 0.6;
      const pic: Keyframe[] = [];
      const glow: Keyframe[] = [];
      for (let t = 0; t <= D; t += FLICKER_MS) {
        const offset = t / D;
        pic.push({ scale: scale(1 + 0.02 * big * (2 * rand() - 1), 1 + 0.07 * big * (2 * rand() - 1)), offset });
        glow.push({ opacity: num(0.6 + 0.4 * rand(), 3), offset });
      }
      return { pic: track(pic), aura: aura(glow), embers: embers(EMBERS[id] ?? 0, at, side, rand) };
    }
    case "glow": {
      // a slow breath, out of step from one picture to the next
      const glow: Keyframe[] = [];
      const phase = rand() * Math.PI * 2;
      for (let t = 0; t <= D; t += BREATH_MS) {
        glow.push({ opacity: num(0.78 + 0.22 * Math.sin(phase + (t / 1300) * Math.PI * 2), 3), offset: t / D });
      }
      return { pic: null, aura: aura(glow), embers: [] };
    }
    case "twinkle":
      return {
        pic: track([
          { scale: scale(1), offset: 0 },
          { scale: scale(1.08), offset: 0.22 },
          { scale: scale(0.96), offset: 0.42 },
          { scale: scale(1.06), offset: 0.64 },
          { scale: scale(0.98), offset: 0.84 },
          { scale: scale(1), offset: 1 },
        ]),
        aura: null,
        embers: [],
      };
    case "beat": {
      // lub-dub, three times
      const pic: Keyframe[] = [];
      const beat = D / 3;
      for (let i = 0; i < 3; i++) {
        const o = (ms: number): number => (i * beat + ms) / D;
        pic.push(
          { scale: scale(1), offset: o(0) },
          { scale: scale(1.1), offset: o(110) },
          { scale: scale(1), offset: o(220) },
          { scale: scale(1.06), offset: o(330) },
          { scale: scale(1), offset: o(480) },
        );
      }
      pic.push({ scale: scale(1), offset: 1 });
      return { pic: track(pic), aura: null, embers: [] };
    }
    case "flutter": {
      // wings closing and opening, about five times a second
      const pic: Keyframe[] = [];
      const beat = 200;
      for (let t = 0; t <= D; t += beat / 2) pic.push({ scale: scale((t / (beat / 2)) % 2 === 1 ? 0.45 : 1, 1), offset: t / D });
      return { pic: track(pic), aura: null, embers: [] };
    }
  }
}

/** `n` embers rising from near the top of a flame `side` px across, each on its own window. */
function embers(n: number, at: number, side: number, rand: () => number): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < n; i++) {
    const delay = 250 + (i / n) * 1300 + rand() * 250;
    const duration = 650 + rand() * 450;
    const w = Math.max(2, side * (0.07 + 0.04 * rand()));
    const rise = side * (0.45 + 0.35 * rand());
    const drift = side * (0.3 * rand() - 0.15);
    const frames: Keyframe[] = [
      { transform: "translate(0px, 0px) scale(1)", opacity: 0, offset: 0 },
      { transform: `translate(${num(0.3 * drift, 2)}px, ${num(-0.25 * rise, 2)}px) scale(1)`, opacity: 1, offset: 0.15 },
      { transform: `translate(${num(drift, 2)}px, ${num(-rise, 2)}px) scale(0.35)`, opacity: 0, offset: 1 },
    ];
    out.push({ cls: "kw-ember", w, h: w, track: { t0: at + delay, duration, frames } });
  }
  return out;
}

// ─────────────────────────────────────────── splashes ───────────────────────────────────────────

/** One piece of a burst: its shape class (stage.css `.sp-*`), its box in px, and its motion. */
export interface Particle {
  cls: string;
  w: number;
  h: number;
  track: Track;
}

/** Keyframes are kept where a straight line would miss by more than this: x and y px, degrees, scale across and along, opacity. */
const BURST_THIN = [0.3, 0.3, 0.6, 0.01, 0.01, 0.02];

/**
 * A particle's track from per-sample poses: x and y (px from the word's center), a rotation, a scale
 * across and along, and an opacity, sampled every BURST_MS over `life` ms from song time `t0`.
 */
function burstTrack(t0: number, life: number, at: (ms: number) => [x: number, y: number, deg: number, sx: number, sy: number, opacity: number]): Track {
  const times = sampleTimes(life, BURST_MS);
  // every piece comes in from nothing: before its start it holds its first frame (timeline.ts fills
  // backwards), which must not show
  const samples = times.map((ms) => {
    const v = at(ms);
    v[5] *= Math.min(1, ms / FADE_IN_MS);
    return v;
  });
  const channels = BURST_THIN.map((_, c) => samples.map((s) => s[c] ?? 0));
  const keep = thin(times, channels, BURST_THIN);
  const points = keyPoints(times, keep, channels, null);
  return {
    t0,
    duration: life,
    frames: framesOf(points, life, ([px, py, r, a, b, o]) => ({
      transform: `translate(${num(px ?? 0, 2)}px, ${num(py ?? 0, 2)}px) rotate(${num(r ?? 0, 2)}deg) scale(${num(a ?? 1, 3)}, ${num(b ?? 1, 3)})`,
      opacity: num(Math.min(1, Math.max(0, o ?? 0)), 3),
    })),
  };
}

const easeOut = (x: number): number => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;
const fade = (t: number, life: number, from: number): number => (t <= from * life ? 1 : Math.max(0, 1 - (t - from * life) / ((1 - from) * life)));
const DEG = 180 / Math.PI;

/** Droplets leap up off the word in a fan, arc and fall, each turned along its path; a ring spreads under the word. */
function drops(at: number, size: number, width: number, reach: number, rand: () => number): Particle[] {
  const out: Particle[] = [];
  const n = 8 + Math.floor(rand() * 3);
  const g = 9 * size; // px/s²: a leap of about a font size at full reach
  for (let i = 0; i < n; i++) {
    const angle = (-150 + (120 * (i + 0.2 + 0.6 * rand())) / n) / DEG;
    const speed = (3.2 + 1.6 * rand()) * size * reach; // px/s
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;
    const x0 = (rand() - 0.5) * Math.min(width, 1.2 * size) * 0.6;
    const y0 = -0.32 * size;
    const life = 640 + 260 * rand();
    const d = (0.09 + 0.06 * rand()) * size;
    out.push({
      cls: "sp-drop",
      w: d,
      h: d * 1.3,
      track: burstTrack(at, life, (ms) => {
        const t = ms / 1000;
        const heading = Math.atan2(vy + g * t, vx) * DEG;
        const shrink = 1 - 0.4 * (ms / life);
        return [x0 + vx * t, y0 + vy * t + 0.5 * g * t * t, heading - 90, shrink, shrink, Math.min(1, ms / 40) * fade(ms, life, 0.7)];
      }),
    });
  }
  const ring = 0.55 * size;
  out.push({
    cls: "sp-ring",
    w: 2.2 * ring,
    h: 0.6 * ring,
    track: burstTrack(at, 560, (ms) => {
      const p = easeOut(ms / 560);
      return [0, 0.36 * size, 0, 0.25 + 1.0 * p * reach, 0.25 + 1.0 * p * reach, 0.8 * (1 - p)];
    }),
  });
  return out;
}

/** Streaks shoot out all round from the word's middle, stretching then shrinking as they fade. */
function sparks(at: number, size: number, width: number, reach: number, rand: () => number): Particle[] {
  const out: Particle[] = [];
  const n = 9;
  const ry = 0.32 * size;
  const rx = Math.max(ry, 0.45 * width);
  for (let i = 0; i < n; i++) {
    const angle = ((360 * (i + 0.5 * rand())) / n) / DEG;
    const dist = (0.6 + 0.4 * rand()) * size * reach;
    const life = 400 + 140 * rand();
    const w = (0.3 + 0.15 * rand()) * size;
    out.push({
      cls: "sp-spark",
      w,
      h: Math.max(2, 0.045 * size),
      track: burstTrack(at, life, (ms) => {
        const p = easeOut(ms / life);
        const ox = Math.cos(angle) * (rx + dist * p);
        const oy = Math.sin(angle) * (ry + dist * p);
        return [ox, oy, angle * DEG, 1 - 0.85 * p, 1, ms < 30 ? ms / 30 : 1 - (ms / life) ** 2];
      }),
    });
  }
  return out;
}

/** Confetti tumbles up and out of the word and flutters down, flipping as it spins. */
function confetti(at: number, size: number, width: number, reach: number, rand: () => number): Particle[] {
  const out: Particle[] = [];
  const n = 12;
  const g = 6 * size;
  for (let i = 0; i < n; i++) {
    const angle = (-90 + (rand() - 0.5) * 140) / DEG;
    const speed = (2.6 + 1.2 * rand()) * size * reach;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;
    const x0 = (rand() - 0.5) * Math.min(width, 1.4 * size) * 0.7;
    const spin = (rand() < 0.5 ? -1 : 1) * (360 + 360 * rand());
    const flip = 2.5 + 1.5 * rand();
    const life = 1000 + 300 * rand();
    out.push({
      cls: `sp-confetti sp-c${i % 3}`,
      w: 0.17 * size,
      h: 0.09 * size,
      track: burstTrack(at, life, (ms) => {
        const t = ms / 1000;
        // drag: the fall slows to a flutter
        const fall = 0.5 * g * t * t * (1 - 0.35 * Math.min(1, t));
        return [x0 + vx * t * (1 - 0.3 * t), -0.2 * size + vy * t + fall, spin * (ms / life), 1, Math.cos(2 * Math.PI * flip * t), fade(ms, life, 0.75)];
      }),
    });
  }
  return out;
}

/** Two rings spread from under the word and fade, one after the other. */
function ripple(at: number, size: number, width: number, reach: number): Particle[] {
  const w = Math.max(1.3 * size, 0.9 * width);
  return [0, 1].map((i) => {
    const life = 900;
    return {
      cls: "sp-ring",
      w,
      h: 0.28 * w,
      track: burstTrack(at + 170 * i, life, (ms) => {
        const p = easeOut(ms / life);
        const s = 0.2 + (1.15 - 0.2 * i) * p * Math.max(0.6, reach);
        return [0, 0.38 * size, 0, s, s, 0.85 * (1 - p)];
      }),
    };
  });
}

/** A few four-point stars twinkle around the word, one after another, turning as they flash. */
function glints(at: number, size: number, width: number, reach: number, rand: () => number): Particle[] {
  const out: Particle[] = [];
  const n = 5;
  const half = width / 2 + 0.2 * size;
  for (let i = 0; i < n; i++) {
    const x = (((i + 0.5) / n) * 2 - 1) * half * (0.75 + 0.25 * rand());
    const y = (-0.7 + 0.55 * rand()) * size;
    const s = (0.32 + 0.14 * rand()) * size * Math.max(0.7, Math.min(1.1, reach));
    const life = 600;
    out.push({
      cls: "sp-glint",
      w: s,
      h: s,
      track: burstTrack(at + 110 * i + 60 * rand(), life, (ms) => {
        const p = ms / life;
        const swell = p < 0.45 ? easeOut(p / 0.45) : 1 - easeOut((p - 0.45) / 0.55);
        return [x, y, 90 * p, swell, swell, Math.min(1, swell * 1.4)];
      }),
    });
  }
  return out;
}

/**
 * The pieces of a splash of `kind` from song time `at` (its word's start), for a word `width` px wide
 * on a line `size` px tall. Nothing without motion (amp 0).
 */
export function planSplash(kind: SplashKind, at: number, size: number, width: number, amp: number, seed: number): Particle[] {
  const reach = reachOf(amp);
  if (reach === 0 || !(size > 0)) return [];
  const rand = randomOf(seed);
  const t0 = at + SPLASH_DELAY_MS;
  switch (kind) {
    case "drops":
      return drops(t0, size, width, reach, rand);
    case "sparks":
      return sparks(t0, size, width, reach, rand);
    case "confetti":
      return confetti(t0, size, width, reach, rand);
    case "ripple":
      return ripple(t0, size, width, reach);
    case "glints":
      return glints(t0, size, width, reach, rand);
    default:
      return [];
  }
}

/** Song time by which a splash's pieces are all gone. */
export function splashUntil(particles: readonly Particle[]): number {
  return Math.max(Number.NEGATIVE_INFINITY, ...particles.map((p) => p.track.t0 + p.track.duration));
}

// ─────────────────────────────────────────── per song ───────────────────────────────────────────

/** What a mode needs to give its lines their flair: whether Effects mode is on, and the song's flair. */
export interface DecorLook {
  effectsMode: boolean;
  flair: Flair;
  unsynced: boolean;
  power: Power;
  emphasis: EmphasisRule | null;
}

/**
 * Each line's flair for a mode drawing `lines` (by line index): none with Effects mode off, for plain
 * lyrics (no karaoke) or in the lite tier (software compositing has no frames to spare).
 */
export function songDecor(lines: readonly Line[], look: DecorLook): LineDecor[] {
  const on = look.effectsMode && !look.unsynced && look.power !== "lite";
  return planDecor(lines, on ? look.flair : null, look.emphasis);
}

/** Every picture a song's decor shows, to fetch and decode ahead. */
export function picturesOf(decor: readonly LineDecor[]): PictureId[] {
  const ids = new Set<PictureId>();
  for (const line of decor) for (const w of line.words.values()) if (w.picture) ids.add(w.picture);
  return [...ids];
}
