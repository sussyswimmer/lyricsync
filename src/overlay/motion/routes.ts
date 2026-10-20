/**
 * Where a word picture goes while it shows (Effects mode), planned ahead as keyframes (pure, no DOM).
 * A picture doesn't sit above its word: it takes part in the line, on the song's clock.
 *
 * - hop: drops onto its word and hops from word to word as each is sung, like a bouncing ball, then
 *   jumps off the end of the line.
 * - fly: birds, a butterfly, a bee, wings and planes fly across above the line, nose first, passing
 *   over their word as it's sung, bobbing as they go.
 * - launch: a rocket shakes on its word, then lifts off.
 * - drive: cars, a truck, a train, a motorcycle, a boat, a horse, a lion, a tiger, a wolf and a wave
 *   cross the line along the tops of its words, bumping as each word is sung.
 * - float: a heart, a balloon, a cloud, a ghost, smoke, lips and a note rise and sway, pulsing on every
 *   word sung after theirs.
 * - fall: rain, snow, leaves, money, feathers and a tear come down over the line, several at once.
 * - burst: a star, fireworks, a diamond, gold, a crown, a trophy, a gift, a ring, lightning and a
 *   rainbow pop in big and throw small copies of themselves out around the word.
 * - orbit: the sun, the moon, the Earth, a planet and a galaxy circle above their word.
 * - roll: a disco ball, dice and round fruit roll along the line to its end and drop off.
 * - dance: the rest of the big or rooted things (a flame, a lamp, a house, a guitar, a tree) stay by
 *   their word, sway, and bounce on every word sung after theirs.
 *
 * Positions are px in the line's own box (its host element), for the picture's bottom middle, which
 * is also the point it turns and squashes around. Without motion (reduced motion, Effects 0) a picture
 * only fades in on its word and out again.
 *
 * The words take part too (`reactions`): each word the picture touches answers it on its own track, on
 * the word box's `translate`, `rotate` and `scale` (which compose with the word's own pop on
 * `transform`). A word squashes under a hopping picture as it lands, ducks as a bird flies over, dips
 * under a car's wheels, shakes on a rocket's launch pad and is kicked up as it lifts off, is lifted
 * and swayed by a balloon, takes the hits of the rain, pops with a burst and shoves its neighbors
 * aside, tilts toward an orbiting moon, is knocked as a ball rolls past, and sways and bounces with a
 * flame or a guitar (a flame's word shimmers in its heat).
 */
import type { PictureId } from "../../core/wordpics";
import { randomOf, reachOf } from "./decor";
import type { Track } from "./karaoke";
import { framesOf, keyPoints, num, sampleTimes, thin } from "./keyframes";

export type PictureRoute = "hop" | "fly" | "launch" | "drive" | "float" | "fall" | "burst" | "orbit" | "roll" | "dance";

const ROUTES: Readonly<Partial<Record<PictureId, PictureRoute>>> = {
  angel: "fly",
  bee: "fly",
  bird: "fly",
  butterfly: "fly",
  dove: "fly",
  "paper-plane": "fly",
  plane: "fly",
  raven: "fly",
  rocket: "launch",
  boat: "drive",
  car: "drive",
  horse: "drive",
  lion: "drive",
  motorcycle: "drive",
  tiger: "drive",
  train: "drive",
  truck: "drive",
  wave: "drive",
  wolf: "drive",
  balloon: "float",
  "broken-heart": "float",
  cloud: "float",
  ghost: "float",
  heart: "float",
  lips: "float",
  music: "float",
  smoke: "float",
  umbrella: "float",
  feather: "fall",
  leaf: "fall",
  money: "fall",
  rain: "fall",
  snow: "fall",
  tear: "fall",
  crown: "burst",
  diamond: "burst",
  fireworks: "burst",
  gift: "burst",
  gold: "burst",
  lightning: "burst",
  rainbow: "burst",
  ring: "burst",
  sparkler: "burst",
  star: "burst",
  trophy: "burst",
  earth: "orbit",
  galaxy: "orbit",
  moon: "orbit",
  planet: "orbit",
  sun: "orbit",
  apple: "roll",
  dice: "roll",
  disco: "roll",
  lemon: "roll",
  peach: "roll",
  watermelon: "roll",
  bed: "dance",
  bridge: "dance",
  cactus: "dance",
  campfire: "dance",
  candle: "dance",
  castle: "dance",
  city: "dance",
  door: "dance",
  drum: "dance",
  fire: "dance",
  guitar: "dance",
  headphones: "dance",
  house: "dance",
  lantern: "dance",
  "light-bulb": "dance",
  lighter: "dance",
  lighthouse: "dance",
  match: "dance",
  microphone: "dance",
  mirror: "dance",
  mountain: "dance",
  palm: "dance",
  piano: "dance",
  pine: "dance",
  radio: "dance",
  rose: "dance",
  saxophone: "dance",
  snake: "dance",
  "street-lamp": "dance",
  sunflower: "dance",
  tree: "dance",
  tv: "dance",
  window: "dance",
};

/** Floating pictures whose word beats with them, and rooted ones whose word shimmers in their heat. */
const BEATS_WITH: ReadonlySet<PictureId> = new Set(["heart", "broken-heart", "lips", "music"]);
const HEAT: ReadonlySet<PictureId> = new Set(["fire", "campfire", "candle", "lighter", "match"]);

/** The way a picture that travels faces in its photo: 1 right (the default), -1 left. */
const FACING: Readonly<Partial<Record<PictureId, -1>>> = { bird: -1, boat: -1 };

/** How many smaller copies come along: a shower's drops, a burst's sparks. */
const COPIES: Readonly<Partial<Record<PictureId, number>>> = {
  rain: 7,
  snow: 6,
  leaf: 4,
  money: 5,
  feather: 3,
  tear: 0,
  fireworks: 7,
  star: 6,
  sparkler: 6,
  diamond: 5,
  gold: 4,
  lightning: 3,
  crown: 4,
  trophy: 4,
  gift: 4,
  ring: 4,
  rainbow: 3,
};

export function routeOf(id: PictureId): PictureRoute {
  return ROUTES[id] ?? "hop";
}

/** Where a word of the picture's line is, in the line's box: the middle of its top, and its width, px. */
export interface Spot {
  x: number;
  y: number;
  w: number;
}

/** Another word of the picture's line, as it starts: which, when, and where it is then. */
export interface Stop extends Spot {
  t: number;
  /** its index in the line */
  word: number;
}

export interface RouteInput {
  id: PictureId;
  /** its word's index in the line */
  word: number;
  /** its word's start, song ms */
  at: number;
  /** when the line's last word ends, song ms */
  until: number;
  /** the picture's size, px */
  side: number;
  /** the line's font size, px */
  size: number;
  /** motion amplitude (params.ts), 0 without motion */
  amp: number;
  seed: number;
  /** its own word, at `at` */
  home: Spot;
  /** the words after it, in the order they're sung */
  stops: readonly Stop[];
  /** the word sung just before it, if any (a burst shoves it aside) */
  prev?: Stop | null;
  /** the line's left and right ends, px */
  left: number;
  right: number;
}

/** How word `word` of the line answers the picture: a track on its box's `translate`, `rotate` and `scale`. */
export interface Reaction {
  word: number;
  track: Track;
}

/** A picture's route and its copies' (each at a scale of the picture), and the words' answers, on the song's clock. */
export interface RoutePlan {
  track: Track;
  copies: { track: Track; scale: number }[];
  reactions: Reaction[];
}

/** Routes are sampled this often; the compositor eases in between. */
const ROUTE_MS = 1000 / 30;
/** Keyframes are kept where a straight line would miss by more than this: x and y px, degrees, scale across and along, opacity. */
const ROUTE_THIN = [0.4, 0.4, 0.8, 0.012, 0.012, 0.02];
/** A picture stays at least this long and at most this long from its word's start, and leaves this long after its line's last word ends. */
const MIN_MS = 2600;
const MAX_MS = 9000;
const AFTER_MS = 500;
/** Words sung closer together than this are one stop for a hopping picture. */
const MIN_HOP_GAP = 170;
/** A hop takes this long at most; a picture on a held word waits, then hops. */
const HOP_MS = 520;

type Pose = [x: number, y: number, deg: number, sx: number, sy: number, opacity: number];

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
const easeOut = (u: number): number => 1 - (1 - clamp01(u)) ** 3;
const easeIn = (u: number): number => clamp01(u) ** 2;
const smooth = (u: number): number => {
  const x = clamp01(u);
  return x * x * (3 - 2 * x);
};

/**
 * A track of poses sampled every ROUTE_MS from song time `t0` for `life` ms, and at `keys` (song times
 * that must land exactly, such as a hop's landings), thinned.
 */
function trackOf(t0: number, life: number, at: (t: number) => Pose, keys: readonly number[] = []): Track {
  const duration = Math.max(1, life);
  const extra = keys.map((t) => t - t0).filter((ms) => ms > 0 && ms < duration);
  const times = extra.length > 0 ? [...new Set([...sampleTimes(duration, ROUTE_MS), ...extra])].sort((a, b) => a - b) : sampleTimes(duration, ROUTE_MS);
  const samples = times.map((ms) => at(t0 + ms));
  const channels = ROUTE_THIN.map((_, c) => samples.map((s) => s[c] ?? 0));
  const keep = thin(times, channels, ROUTE_THIN);
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

/** In over `fadeIn` ms from `t0`, out over `fadeOut` ms before `t1`. */
function presence(t: number, t0: number, t1: number, fadeIn: number, fadeOut: number): number {
  return Math.min(clamp01((t - t0) / fadeIn), clamp01((t1 - t) / fadeOut));
}

/** A quick squash where something lands at `t0`: wider and flatter, springing back. */
function squash(t: number, t0: number, depth: number): [number, number] {
  const ms = t - t0;
  if (ms < 0 || ms > 220) return [1, 1];
  const k = Math.exp(-ms / 70) * Math.cos((ms / 220) * Math.PI * 1.5);
  return [1 + 0.16 * depth * k, 1 - 0.18 * depth * k];
}

/** squash()'s spring, `ms` after landing: across and along. */
function squashAt(ms: number, depth: number): [number, number] {
  if (ms < 0 || ms > 220) return [1, 1];
  const k = Math.exp(-ms / 70) * Math.cos((ms / 220) * Math.PI * 1.5);
  return [1 + 0.16 * depth * k, 1 - 0.18 * depth * k];
}

/** A pulse at each of `beats` (song ms): up to `peak` and back over 240 ms. */
function pulse(t: number, beats: readonly number[], peak: number): number {
  let s = 1;
  for (const b of beats) {
    const ms = t - b;
    if (ms >= 0 && ms < 240) s = Math.max(s, 1 + (peak - 1) * Math.sin((ms / 240) * Math.PI));
  }
  return s;
}

/** A hop up of `height` px at each of `beats`, over 260 ms. */
function bounce(t: number, beats: readonly number[], height: number): number {
  let y = 0;
  for (const b of beats) {
    const ms = t - b;
    if (ms >= 0 && ms < 260) y = Math.min(y, -height * Math.sin((ms / 260) * Math.PI));
  }
  return y;
}

// ─────────────────────────────────────────── reactions ───────────────────────────────────────────

/** A word's answer at an instant: its offset (px), turn (degrees) and squash (across, along). */
type Push = [dx: number, dy: number, deg: number, sx: number, sy: number];
const STILL: Push = [0, 0, 0, 1, 1];
/** Reactions are sampled this often; keyframes are kept where a straight line would miss by more than this: x, y px, degrees, scale. */
const REACT_MS = 1000 / 30;
const REACT_THIN = [0.3, 0.3, 0.4, 0.006, 0.006];

/** A hit at `t0` that is over in `ms`: up from 0 and back, a little front-loaded. */
function knock(t: number, t0: number, ms: number): number {
  const u = (t - t0) / ms;
  return u <= 0 || u >= 1 ? 0 : Math.sin(Math.PI * u) * (1 - 0.45 * u);
}

/**
 * Word `word`'s answer over [t0, t1], sampled and thinned like a route. It rests (no offset, no turn,
 * no squash) at both ends, so nothing is left on the word once it is over, whatever cuts it short.
 */
function reactionOf(word: number, t0: number, t1: number, at: (t: number) => Push, keys: readonly number[] = []): Reaction {
  const duration = Math.max(1, t1 - t0);
  const extra = keys.map((t) => t - t0).filter((ms) => ms > 0 && ms < duration);
  const times = extra.length > 0 ? [...new Set([...sampleTimes(duration, REACT_MS), ...extra])].sort((a, b) => a - b) : sampleTimes(duration, REACT_MS);
  const samples = times.map((ms, i) => (i === 0 || i === times.length - 1 ? STILL : at(t0 + ms)));
  const channels = REACT_THIN.map((_, c) => samples.map((s) => s[c] ?? 0));
  const keep = thin(times, channels, REACT_THIN);
  const points = keyPoints(times, keep, channels, null);
  return {
    word,
    track: {
      t0,
      duration,
      frames: framesOf(points, duration, ([dx, dy, r, a, b]) => ({
        translate: `${num(dx ?? 0, 2)}px ${num(dy ?? 0, 2)}px`,
        rotate: `${num(r ?? 0, 2)}deg`,
        scale: `${num(a ?? 1, 4)} ${num(b ?? 1, 4)}`,
      })),
    },
  };
}

/** Hits on words, each at its own time: one reaction per word, its hits added up. */
function hitsOf(hits: readonly { word: number; t: number }[], ms: number, push: (h: number, t: number) => Push): Reaction[] {
  const byWord = new Map<number, number[]>();
  for (const h of hits) {
    if (!Number.isFinite(h.t)) continue;
    const list = byWord.get(h.word) ?? [];
    list.push(h.t);
    byWord.set(h.word, list);
  }
  return [...byWord].map(([word, times]) => {
    const t0 = Math.min(...times) - REACT_MS;
    const t1 = Math.max(...times) + ms + REACT_MS;
    return reactionOf(word, t0, t1, (t) => {
      const sum: Push = [0, 0, 0, 1, 1];
      for (const at of times) {
        const p = push(knock(t, at, ms), t - at);
        sum[0] += p[0];
        sum[1] += p[1];
        sum[2] += p[2];
        sum[3] += p[3] - 1;
        sum[4] += p[4] - 1;
      }
      return sum;
    }, times);
  });
}

/** When something moving along x(t) from (ta, xa) to (tb, xb) passes x, or null if it doesn't between them. */
function passes(x: number, ta: number, xa: number, tb: number, xb: number): number | null {
  if (xb === xa) return null;
  const u = (x - xa) / (xb - xa);
  return u > 0 && u < 1 ? ta + u * (tb - ta) : null;
}

/** When a picture crossing the line (in from `from` at t0, over its word at `at`, out to `to` by `end`) passes each of the other words. */
function crossings(input: RouteInput, t0: number, from: number, end: number, to: number): { word: number; t: number }[] {
  const { at, home } = input;
  const others = [...(input.prev ? [input.prev] : []), ...input.stops];
  return others.map((w) => ({ word: w.word, t: passes(w.x, t0, from, at, home.x) ?? passes(w.x, at, home.x, end, to) ?? Number.NaN }));
}

/** The later words a hop lands on: each at least MIN_HOP_GAP after the last (a fast run is hopped over). */
function landings(at: number, stops: readonly Stop[]): Stop[] {
  const out: Stop[] = [];
  let last = at;
  for (const s of stops) {
    if (s.t - last < MIN_HOP_GAP) continue;
    out.push(s);
    last = s.t;
  }
  return out;
}

/** A point piecewise along (t, x) pairs, held at the ends. */
function along(points: readonly [number, number][], t: number): number {
  const first = points[0];
  if (!first) return 0;
  if (t <= first[0]) return first[1];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as [number, number];
    const b = points[i] as [number, number];
    if (t <= b[0]) return lerp(a[1], b[1], b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 1);
  }
  return (points[points.length - 1] as [number, number])[1];
}

/** Plans picture `id`'s route over its line (see the module comment). */
export function planPictureRoute(input: RouteInput): RoutePlan {
  const { id, at, home, size: L, side: S, seed } = input;
  const k = reachOf(input.amp);
  const end = at + clamp(input.until + AFTER_MS - at, MIN_MS, MAX_MS);
  const rest = home.y + 0.06 * L;
  if (k === 0) {
    // no motion: in on its word, out again
    return { track: trackOf(at, end - at, (t) => [home.x, rest, 0, 1, 1, presence(t, at, end, 220, 400)]), copies: [], reactions: [] };
  }
  const word = input.word;
  const rand = randomOf(seed ^ 0x51ed270b);
  const beats = input.stops.map((s) => s.t);
  const span = Math.max(input.right - input.left, home.w);
  const left = input.left;
  const right = left + span;
  switch (routeOf(id)) {
    case "hop": {
      // each word squashes as the picture lands on it
      const hits = [{ word, t: at }, ...landings(at, input.stops).map((s) => ({ word: s.word, t: s.t }))];
      const reactions = hitsOf(hits, 300, (h, ms) => {
        const [sx, sy] = squashAt(ms, 0.7 * k);
        return [0, 0.08 * L * k * h, 0, sx, sy];
      });
      return { track: hop(input, k, end, rest), copies: [], reactions };
    }
    case "fly": {
      const dir = FACING[id] ?? 1;
      const from = dir > 0 ? left - 1.4 * L : right + 1.4 * L;
      const to = dir > 0 ? right + 1.6 * L : left - 1.6 * L;
      const t0 = at - 900;
      const phase = rand() * Math.PI * 2;
      const x = (t: number): number => along([[t0, from], [at, home.x], [end, to]], t);
      const y = (t: number): number =>
        rest - 0.85 * L * k - 0.3 * L * k * Math.sin(phase + ((t - t0) / 1150) * Math.PI * 2) - 1.3 * L * easeIn((t - (end - 900)) / 900);
      return {
        track: trackOf(t0, end - t0, (t) => {
          // nose along its path: tilted by how steeply it climbs or dives
          const dy = y(t + 40) - y(t - 40);
          const dx = Math.abs(x(t + 40) - x(t - 40)) || 1;
          const tilt = clamp((Math.atan2(dy, dx) * 180) / Math.PI, -22, 22) * dir;
          return [x(t), y(t), tilt, 1, 1, presence(t, t0, end, 220, 320)];
        }),
        copies: [],
        // each word ducks and leans away as it flies over
        reactions: hitsOf(
          [{ word, t: at }, ...crossings(input, t0, from, end, to)].map((c) => ({ word: c.word, t: c.t - 120 })),
          420,
          (h) => [dir * 0.04 * L * k * h, 0.06 * L * k * h, dir * 3.5 * k * h, 1, 1],
        ),
      };
    }
    case "launch": {
      const lift = at + 650;
      const gone = lift + 1300;
      return {
        track: trackOf(at, gone - at, (t) => {
          const shake = t < lift ? 0.035 * L * Math.sin((t - at) * 0.35) * smooth((t - at) / 200) : 0;
          const u = (t - lift) / (gone - lift);
          const up = t < lift ? 0 : easeIn(u) * (rest + 2.5 * L + 6 * L * k);
          const [sx, sy] = squash(t, at, k);
          return [home.x + shake + 0.8 * L * easeIn(u), rest - up, 14 * easeIn(u), sx, sy, presence(t, at, gone, 160, 260)];
        }),
        copies: [],
        // its word shakes on the launch pad, is kicked up as it lifts off, and lands
        reactions: [
          reactionOf(word, at, lift + 820, (t) => {
            const shake = t < lift ? 0.025 * L * Math.sin((t - at) * 0.35) * smooth((t - at) / 200) : 0;
            const [sx, sy] = squashAt(t - (lift + 560), 0.8 * k);
            return [shake, -0.24 * L * k * knock(t, lift, 560), 0, sx, sy];
          }, [lift, lift + 560]),
        ],
      };
    }
    case "drive": {
      const dir = FACING[id] ?? 1;
      const from = dir > 0 ? left - 1.2 * L : right + 1.2 * L;
      const to = dir > 0 ? right + 1.2 * L : left - 1.2 * L;
      const t0 = at - 1100;
      const boat = id === "boat" || id === "wave";
      const legs = id === "horse" || id === "lion" || id === "tiger" || id === "wolf";
      return {
        track: trackOf(t0, end - t0, (t) => {
          const x = along([[t0, from], [at, home.x], [end, to]], t);
          // bumps over each word sung, or a boat's rocking, or a gait
          const gait = legs ? -0.06 * L * k * Math.abs(Math.sin((t - t0) / 160)) : 0;
          const y = rest + (boat ? 0.05 * L * Math.sin((t - t0) / 420) : bounce(t, beats, 0.16 * L * k)) + gait;
          const r = boat ? 6 * Math.sin((t - t0) / 520) : -dir * 4 * Math.sin(Math.PI * clamp01(-bounce(t, beats, 1)));
          return [x, y, r, 1, 1, presence(t, t0, end, 260, 320)];
        }),
        copies: [],
        // each word dips under it as it passes over (a boat or a wave rocks it instead)
        reactions: hitsOf(
          [{ word, t: at }, ...crossings(input, t0, from, end, to)],
          boat ? 600 : 340,
          (h, ms) => (boat ? [0, 0.04 * L * k * h, 4 * k * h * Math.sin(ms / 95), 1, 1] : [0, 0.07 * L * k * h, -dir * 3 * k * h, 1 + 0.04 * k * h, 1 - 0.06 * k * h]),
        ),
      };
    }
    case "float": {
      const phase = rand() * Math.PI * 2;
      const rise = (1.9 + 0.5 * rand()) * L * k;
      return {
        track: trackOf(at, end - at, (t) => {
          const u = (t - at) / (end - at);
          const pop = t - at < 320 ? 0.35 + 0.65 * easeOut((t - at) / 200) + 0.12 * Math.sin(Math.PI * clamp01((t - at - 120) / 200)) : 1;
          const s = pop * pulse(t, beats, 1.16);
          const x = home.x + 0.45 * L * k * Math.sin(phase + (t - at) / 360);
          return [x, rest - 0.15 * L - rise * smooth(u), 9 * Math.sin(phase + (t - at) / 480), s, s, presence(t, at, end, 120, 520)];
        }),
        copies: [],
        // it lifts its word as it rises, swaying it with its own sway, then lets go (a heart's word beats with it)
        reactions: [
          reactionOf(word, at, Math.min(end, at + 2300), (t) => {
            const held = smooth((t - at) / 450) * (1 - smooth((t - (at + 1400)) / 800));
            const beat = BEATS_WITH.has(id) ? 1 + (pulse(t, beats, 1.08) - 1) * held : 1;
            return [0.06 * L * k * Math.sin(phase + (t - at) / 360) * held, -0.22 * L * k * held, 4 * k * Math.sin(phase + (t - at) / 480) * held, beat, beat];
          }),
        ],
      };
    }
    case "fall":
      return fall(input, k, end, rest, left, right, rand);
    case "burst":
      return burst(input, k, end, rest, rand);
    case "orbit": {
      const rx = Math.max(0.9 * L, 0.6 * home.w) * k;
      const ry = 0.2 * L * k;
      const cy = rest - 0.3 * L;
      const lap = 2600;
      return {
        track: trackOf(at, end - at, (t) => {
          const th = -Math.PI / 2 + ((t - at) / lap) * Math.PI * 2;
          const pop = easeOut((t - at) / 240);
          const s = pop * (0.9 + 0.12 * Math.sin(th));
          return [home.x + rx * Math.cos(th) * pop, cy + ry * Math.sin(th) * pop, 0, s, s, presence(t, at, end, 160, 420)];
        }),
        copies: [],
        // its word leans toward it as it goes round, a little raised
        reactions: [
          reactionOf(word, at, end, (t) => {
            const th = -Math.PI / 2 + ((t - at) / lap) * Math.PI * 2;
            const held = presence(t, at, end, 300, 420);
            return [0, -0.04 * L * k * held, 3.5 * k * Math.cos(th) * held, 1, 1];
          }),
        ],
      };
    }
    case "roll": {
      const go = at + 260;
      const edge = right + 0.9 * L;
      const stop = Math.max(go + 600, end - 520);
      return {
        track: trackOf(at - 280, end - at + 280, (t) => {
          const drop = t < at ? -1.4 * L * k * (1 - easeIn((t - (at - 280)) / 280)) : 0;
          const x = along([[go, home.x], [stop, edge]], t);
          const off = easeIn((t - stop) / (end - stop));
          const [sx, sy] = squash(t, at, k);
          const deg = ((x - home.x) / (S / 2)) * (180 / Math.PI);
          return [x, rest + drop + bounce(t, beats, 0.12 * L * k) + 1.6 * L * off, deg, sx, sy, presence(t, at - 280, end, 120, 260)];
        }),
        copies: [],
        // its word squashes as it drops on; each word after it is knocked over a little as it rolls past
        reactions: [
          ...hitsOf([{ word, t: at }], 300, (h, ms) => {
            const [sx, sy] = squashAt(ms, 0.7 * k);
            return [0, 0.06 * L * k * h, 0, sx, sy];
          }),
          ...hitsOf(
            input.stops.map((s) => ({ word: s.word, t: passes(s.x, go, home.x, stop, edge) ?? Number.NaN })),
            380,
            (h) => [0.03 * L * k * h, -0.04 * L * k * h, 6 * k * h, 1, 1],
          ),
        ],
      };
    }
    case "dance": {
      const phase = rand() * Math.PI * 2;
      return {
        track: trackOf(at, end - at, (t) => {
          const pop = t - at < 360 ? 0.4 + 0.6 * easeOut((t - at) / 220) + 0.12 * Math.sin(Math.PI * clamp01((t - at - 140) / 220)) : 1;
          const grow = 1 + 0.1 * smooth((t - at) / 2500);
          const s = pop * grow * pulse(t, beats, 1.1);
          return [home.x, rest + bounce(t, beats, 0.2 * L * k), 7 * k * Math.sin(phase + (t - at) / 300), s, s, presence(t, at, end, 100, 420)];
        }),
        copies: [],
        // its word sways and bounces along with it; a flame's word shimmers in its heat
        reactions: [
          reactionOf(word, at, end, (t) => {
            const held = presence(t, at, end, 200, 420);
            const heat = HEAT.has(id) ? 0.022 * k * Math.sin((t - at) / 37) * Math.sin((t - at) / 91 + 1) * held : 0;
            return [0, bounce(t, beats, 0.06 * L * k) * held, 2.4 * k * Math.sin(phase + (t - at) / 300) * held, 1 - heat / 2, 1 + heat];
          }),
        ],
      };
    }
  }
}

/** A bouncing ball: drops onto its word as it's sung, hops to each word after it as that one starts, and jumps off the end. */
function hop(input: RouteInput, k: number, end: number, rest: number): Track {
  const { at, home, size: L } = input;
  const lands = landings(at, input.stops);
  const points: { t: number; x: number; y: number }[] = [{ t: at, x: home.x, y: rest }, ...lands.map((s) => ({ t: s.t, x: s.x, y: s.y + 0.06 * L }))];
  const last = points[points.length - 1] as { t: number; x: number; y: number };
  const leave = Math.max(last.t + 300, Math.min(end - 520, input.until));
  const t0 = at - 300;
  const out = Math.max(leave + 520, end);
  const keys = points.flatMap((p, i) => {
    const next = points[i + 1];
    return next ? [p.t, next.t - Math.min(HOP_MS, next.t - p.t)] : [p.t];
  });
  return trackOf(t0, out - t0, (t) => {
    if (t < at) {
      // dropping in from above
      const u = (t - t0) / 300;
      return [home.x, rest - 1.5 * L * k * (1 - easeIn(u)), 0, 0.92, 1.08, clamp01(u * 3)];
    }
    if (t >= leave) {
      // off the end of the line, up and away, spinning
      const u = (t - leave) / (out - leave);
      const x = last.x + 1.5 * L * u;
      const y = last.y - 4 * 0.8 * L * k * u * (1 - u) + 1.2 * L * easeIn(u);
      return [x, y, 200 * u, 1, 1, 1 - easeIn(clamp01((u - 0.35) / 0.65))];
    }
    // the stretch it's in: resting on one word, or in the air toward the next
    let i = 0;
    while (i + 1 < points.length && t >= (points[i + 1] as { t: number }).t) i++;
    const a = points[i] as { t: number; x: number; y: number };
    const b = points[i + 1];
    const [sx, sy] = squash(t, a.t, k);
    if (!b) return [a.x, a.y, 0, sx, sy, 1];
    const flight = Math.min(HOP_MS, b.t - a.t);
    const takeoff = b.t - flight;
    if (t < takeoff) return [a.x, a.y, 0, sx, sy, 1];
    const u = (t - takeoff) / flight;
    const height = clamp((0.4 * L + 0.15 * Math.abs(b.x - a.x)) * k, 0.25 * L, 1.3 * L);
    const x = lerp(a.x, b.x, u);
    const y = lerp(a.y, b.y, u) - 4 * height * u * (1 - u);
    return [x, y, Math.sign(b.x - a.x) * 12 * Math.sin(Math.PI * u), 1, 1, 1];
  }, [...keys, leave]);
}

/** Rain, snow, leaves, money, feathers: the picture comes down onto its word and copies fall across the line. */
function fall(input: RouteInput, k: number, end: number, rest: number, left: number, right: number, rand: () => number): RoutePlan {
  const { id, at, home, size: L } = input;
  const speed = id === "rain" || id === "tear" ? 2.6 : id === "money" ? 1.1 : 0.8; // line sizes a second
  const sway = id === "rain" || id === "tear" ? 0 : 0.4 * L * k;
  const tumble = id === "leaf" || id === "money" || id === "feather" ? 1 : id === "snow" ? 0.4 : 0;
  const drop = 1.6 * L * k;
  const t0 = at - (drop / (speed * L)) * 1000;
  const phase = rand() * Math.PI * 2;
  const track = trackOf(t0, end - t0, (t) => {
    const u = clamp01((t - t0) / (at - t0));
    const y = t < at ? rest - drop * (1 - u) : rest + (id === "tear" ? 0.9 * L * k * easeIn((t - at) / (end - at)) : 0);
    const x = home.x + sway * Math.sin(phase + (t - t0) / 380) * (1 - smooth((t - at) / 400));
    return [x, y, tumble * 25 * Math.sin(phase + (t - t0) / 300), 1, 1, presence(t, t0, end, 160, 420)];
  });
  const n = COPIES[id] ?? 0;
  const copies: RoutePlan["copies"] = [];
  // the words take the hits: its own as the picture comes down on it, and whichever word each copy falls on
  const words: Stop[] = [{ ...home, t: at, word: input.word }, ...(input.prev ? [input.prev] : []), ...input.stops];
  const hits: { word: number; t: number }[] = [{ word: input.word, t: at }];
  for (let c = 0; c < n; c++) {
    const x0 = left + (right - left) * ((c + 0.2 + 0.6 * rand()) / n);
    const start = at - 200 + 1700 * rand();
    const scale = 0.5 + 0.3 * rand();
    const fallFor = ((2.4 + 0.6 * rand()) * L * 1000) / (speed * L);
    const top = rest - (1.8 + 0.8 * rand()) * L;
    const ph = rand() * Math.PI * 2;
    const under = words.find((w) => Math.abs(w.x - x0) <= w.w / 2);
    if (under) hits.push({ word: under.word, t: start + ((rest - top) / (3 * L)) * fallFor });
    copies.push({
      scale,
      track: trackOf(start, fallFor, (t) => {
        const u = (t - start) / fallFor;
        const x = x0 + 1.2 * sway * Math.sin(ph + (t - start) / 360);
        return [x, top + (2.4 + 0.6) * L * u, tumble * 40 * Math.sin(ph + (t - start) / 260), scale, scale, presence(t, start, start + fallFor, 160, 360)];
      }),
    });
  }
  const weight = id === "rain" || id === "tear" || id === "money" ? 1 : 0.5;
  const reactions = hitsOf(hits, 260, (h) => [0, 0.05 * L * k * weight * h, 0, 1 + 0.03 * k * weight * h, 1 - 0.05 * k * weight * h]);
  return { track, copies, reactions };
}

/** A star, fireworks, a diamond: pops in big and spinning, throws small copies out around the word, hovers and rises away. */
function burst(input: RouteInput, k: number, end: number, rest: number, rand: () => number): RoutePlan {
  const { id, at, home, size: L, stops, word } = input;
  const spin = id === "star" || id === "diamond" || id === "sparkler" || id === "fireworks" ? 360 : 0;
  const beats = stops.map((s) => s.t);
  const track = trackOf(at, end - at, (t) => {
    const ms = t - at;
    const pop = ms < 420 ? 0.2 + 1.3 * easeOut(ms / 160) - 0.5 * smooth((ms - 160) / 260) : 1;
    const s = pop * pulse(t, beats, 1.12);
    const hover = -0.12 * L * k * Math.sin(ms / 420);
    const away = 1.4 * L * easeIn((t - (end - 700)) / 700);
    return [home.x, rest - 0.1 * L + hover - away, spin * easeOut(ms / 500), s, s, presence(t, at, end, 60, 600)];
  });
  const n = COPIES[id] ?? 4;
  const copies: RoutePlan["copies"] = [];
  for (let c = 0; c < n; c++) {
    const angle = ((-170 + (160 * (c + 0.5)) / n + 14 * (rand() - 0.5)) * Math.PI) / 180;
    const dist = (1.3 + 1.1 * rand()) * L * k;
    const life = 800 + 400 * rand();
    const start = at + 40 + 60 * rand();
    const scale = 0.4 + 0.16 * rand();
    const turn = (rand() < 0.5 ? -1 : 1) * (120 + 200 * rand());
    copies.push({
      scale,
      track: trackOf(start, life, (t) => {
        const u = (t - start) / life;
        const e = easeOut(u);
        return [home.x + Math.cos(angle) * dist * e, rest - 0.3 * L + Math.sin(angle) * dist * e + 0.6 * L * u * u, turn * e, scale, scale, presence(t, start, start + life, 60, 0.6 * life)];
      }),
    });
  }
  // its word pops with the burst (lightning shakes it), and the words either side are shoved apart
  const shock = id === "lightning";
  const reactions: Reaction[] = [
    reactionOf(word, at, at + 560, (t) => {
      const pop = 1 + 0.16 * k * knock(t, at, 480);
      const shake = shock ? 0.03 * L * Math.sin((t - at) * 0.9) * (1 - smooth((t - at) / 380)) : 0;
      return [shake, -0.04 * L * k * knock(t, at, 480), 0, pop, pop];
    }),
  ];
  const shove = (side: Stop, dir: number): Reaction =>
    reactionOf(side.word, at, at + 620, (t) => {
      const h = knock(t, at + 30, 560);
      return [dir * 0.12 * L * k * h, 0, dir * 3 * k * h, 1, 1];
    });
  if (input.prev) reactions.push(shove(input.prev, -1));
  const next = stops[0];
  if (next) reactions.push(shove(next, 1));
  return { track, copies, reactions };
}
