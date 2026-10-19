/**
 * Every tunable of the motion, in one place (SPEC §2.3). The karaoke, the dots, the bloom and the
 * list's motion take their numbers from here, worked out once per build or restyle from the song's
 * picked look and the user's settings:
 *
 *   E  the song's energy (picked look, 0..1)       F  Settings.effects (0..100, 50 = as picked)
 *   S  the song's snap (picked look, 0..1)         W  Settings.glow (0..100, 40 = as picked)
 *   G  the song's glow (picked look, 0.3..1)
 *
 *   k = F / 50                       Effects 0 holds still, 100 doubles the motion
 *   A = clamp(E·k / 0.3, 0, 2.5)     amplitude against Beautiful Lyrics' own (A = 1): 1.5 for a
 *                                    typical song (E 0.45) at Effects 50. 0 under reduced motion,
 *                                    in the lite tier and at Effects 0.
 *   f = 0.8 + 0.5·S                  spring pace: fast songs settle quickly, ballads float
 *   b = clamp(G·gain(W), 0, 1.3)     the bloom's strength (bloom.ts); never off
 *
 * Every number was re-derived by eye from Beautiful Lyrics' promo frames (behavior only, no code).
 * BL_REFERENCE holds the A = 1 values the tests pin. That is the "rise" move; Effects mode gives a song
 * other moves (core/flair.ts), each its own reshaping of the same pop, ripple and springs (MOVE_TUNING).
 */
import type { Move } from "../../core/flair";
import type { EmphasisRule } from "../../core/songlook";
import type { Key } from "./curve";
import type { Power } from "./power";
import type { SpringSpec } from "./spring";

/**
 * When a held syllable lights letter by letter (the song's look picks it; null: never). One type with
 * the look picker's, which lives in core (core never imports from the overlay).
 */
export type { EmphasisRule };

/** What the parameters are worked out from: a resolved Look carries all of it. */
export interface MotionInput {
  /** the song's energy, 0..1 (E) */
  energy: number;
  /** the song's snap, 0..1 (S) */
  snap: number;
  /** Settings.effects, 0..100 (F) */
  effects: number;
  /** false under prefers-reduced-motion */
  motion: boolean;
  /** "lite": software compositing draws the reduced-motion karaoke */
  power: Power;
  /** the song's held-note rule, null for none */
  emphasis: EmphasisRule | null;
  /** how words move (Effects mode); "rise" when absent */
  move?: Move;
}

export interface MotionParams {
  /** how words move (MotionInput.move) */
  move: Move;
  /** A: amplitude against BL's (1), 0..A_MAX; 0 means no transforms at all */
  amp: number;
  /** f: spring frequency factor */
  pace: number;
  /**
   * "full": the feathered wipe, the pop, the ripple, held letters and the bloom envelope.
   * "fade" (reduced motion, the lite tier): the lit copy fades in as its word starts, a steady bloom,
   * no masks, letters or transforms.
   */
  karaoke: "full" | "fade";
  /** An upcoming word waits this small and this low (em, positive down). */
  restScale: number;
  restLift: number;
  /** The pop's target curves over the word's progress, chased by its springs. */
  scaleKeys: readonly Key[];
  liftKeys: readonly Key[];
  liftSpring: SpringSpec;
  scaleSpring: SpringSpec;
  /** The bloom's envelope over the word, and its peak (held words bloom fully). */
  glowKeys: readonly Key[];
  glowSpring: SpringSpec;
  glowPeak: number;
  glowPeakHeld: number;
  /** The per-letter ripple: hop height (em), its spring, how long a letter holds it up (ms), its swell per em of rise. */
  rippleHeight: number;
  rippleSpring: SpringSpec;
  rippleHoldMs: readonly [min: number, max: number];
  rippleSwell: number;
  /** a letter starts its hop this long before the wipe has fully lit it */
  rippleLeadMs: number;
  /**
   * sway: the word tilts up to this many degrees as it's sung (alternating sides word by word) along
   * swayKeys (0..1 of the tilt over the word's progress), and swings back on swaySpring. 0: no tilt.
   */
  swayDeg: number;
  swayKeys: readonly Key[];
  swaySpring: SpringSpec;
  /** held notes */
  emphasis: EmphasisRule | null;
  /** A held letter lifts this many times a word's lift keys, and swells on its own curve. */
  letterLiftGain: number;
  letterScaleKeys: readonly Key[];
  letterGlowSpring: SpringSpec;
  /** 0..1: how much of their BL motion the interlude dots get (0: they only fade and brighten) */
  dotAmp: number;
  /** Springs are planned at most this long after their word... */
  tailMs: number;
  /** ...and "fade" karaoke fades in this fast, to a steady bloom of this opacity... */
  fadeMs: number;
  steadyGlow: number;
  /**
   * ...in this many steps where the compositor runs stepped keyframes (0: smoothly). The lite tier
   * steps: software compositing redraws for every changed frame, and a 140 ms fade reads the same
   * in three.
   */
  fadeSteps: number;
}

/** A at its largest: Effects 100 on a lively song. */
export const A_MAX = 2.5;
/** The energy at which Effects 50 moves exactly as much as BL (A = 1). */
export const BL_ENERGY = 0.3;
/** The lite tier's fades step this many times (MotionParams.fadeSteps). */
export const LITE_FADE_STEPS = 3;

const clamp = (x: number, lo: number, hi: number): number => (x <= lo ? lo : x >= hi ? hi : x);
const finite = (x: number, fallback: number): number => (Number.isFinite(x) ? x : fallback);

/** The bloom's envelope over a word: up by 15 %, held to 60 %, gone at its end. */
export const GLOW_KEYS: readonly Key[] = [
  [0, 0],
  [0.15, 1],
  [0.6, 1],
  [1, 0],
];

/** BL's own rule for held syllables, the look's default. */
export const BL_EMPHASIS: EmphasisRule = { minMs: 1000, maxChars: 12, lastWordOnly: false };

/** The parts of the pop and the ripple a move reshapes (the rest is the same for every move). */
type MoveTuning = Pick<
  MotionParams,
  | "restScale"
  | "restLift"
  | "scaleKeys"
  | "liftKeys"
  | "liftSpring"
  | "scaleSpring"
  | "glowPeak"
  | "rippleHeight"
  | "rippleSpring"
  | "rippleHoldMs"
  | "rippleSwell"
  | "rippleLeadMs"
  | "swayDeg"
  | "swayKeys"
  | "swaySpring"
>;

const NO_SWAY: Pick<MoveTuning, "swayDeg" | "swayKeys" | "swaySpring"> = {
  swayDeg: 0,
  swayKeys: [
    [0, 0],
    [1, 0],
  ],
  swaySpring: { hz: 1, damping: 1 },
};

/**
 * Each move's pop and ripple at amplitude A and pace f. rise is BL's, as studied. The others keep its
 * springs' character (they chase target curves over the word's progress) and reshape the targets:
 *
 * - bounce: rests on the line, hops up early in the word and lands past its rest, bouncing (a looser
 *   lift spring); a quick swell with it, and small letter hops.
 * - sway: barely lifts; tilts toward one side as it lights (alternating word by word) and swings back
 *   through rest on a loose pendulum.
 * - wave: the word itself hardly moves; its letters hop higher and slower as they light, a wave
 *   running through the word.
 * - pulse: no lift at all; a fast swell on the word's start and back, with a fuller bloom.
 * - drop: waits a little above the line and drops into place, landing just below it.
 */
export function moveTuning(move: Move, A: number, f: number): MoveTuning {
  const a1 = Math.min(A, 1);
  const a2 = Math.min(A, 2);
  const rise: MoveTuning = {
    // Upcoming words wait no smaller than BL's 0.95: each shrinks about its own center, so a deeper
    // rest opens visibly uneven gaps between the words still to come. Livelier songs hop higher instead.
    restScale: 1 - 0.05 * a1,
    restLift: 0.01 * A,
    scaleKeys: [
      [0, 1 - 0.05 * a1],
      [0.7, 1 + 0.026 * a2],
      [1, 1],
    ],
    liftKeys: [
      [0, 0.01 * A],
      [0.9, -0.018 * A],
      [1, 0],
    ],
    liftSpring: { hz: 1.3 * f, damping: clamp(0.48 - 0.08 * A, 0.32, 0.48) },
    scaleSpring: { hz: 0.8 * f, damping: 0.6 },
    glowPeak: 0.92,
    rippleHeight: Math.min(0.14, 0.06 * A),
    rippleSpring: { hz: 3.1 * f, damping: 0.4 },
    rippleHoldMs: [130, 260],
    rippleSwell: 0.9,
    rippleLeadMs: 20,
    ...NO_SWAY,
  };
  switch (move) {
    case "bounce": {
      const restScale = 1 - 0.035 * a1;
      return {
        ...rise,
        restScale,
        restLift: 0,
        scaleKeys: [
          [0, restScale],
          [0.22, 1 + 0.035 * a2],
          [1, 1],
        ],
        liftKeys: [
          [0, 0],
          [0.25, -0.05 * A],
          [0.55, 0.006 * A],
          [1, 0],
        ],
        liftSpring: { hz: 2.2 * f, damping: 0.3 },
        scaleSpring: { hz: 1.5 * f, damping: 0.45 },
        rippleHeight: Math.min(0.08, 0.03 * A),
      };
    }
    case "sway": {
      const restScale = 1 - 0.03 * a1;
      return {
        ...rise,
        restScale,
        restLift: 0.005 * A,
        scaleKeys: [
          [0, restScale],
          [0.7, 1 + 0.015 * a2],
          [1, 1],
        ],
        liftKeys: [
          [0, 0.005 * A],
          [0.9, -0.008 * A],
          [1, 0],
        ],
        rippleHeight: Math.min(0.08, 0.035 * A),
        swayDeg: 2.6 * Math.min(A, 1.8),
        swayKeys: [
          [0, 0],
          [0.25, 1],
          [1, 0],
        ],
        swaySpring: { hz: 0.9 * f, damping: 0.22 },
      };
    }
    case "wave": {
      const restScale = 1 - 0.02 * a1;
      return {
        ...rise,
        restScale,
        restLift: 0.004 * A,
        scaleKeys: [
          [0, restScale],
          [0.7, 1.01],
          [1, 1],
        ],
        liftKeys: [
          [0, 0.004 * A],
          [0.9, -0.006 * A],
          [1, 0],
        ],
        rippleHeight: Math.min(0.2, 0.11 * A),
        rippleSpring: { hz: 2.3 * f, damping: 0.5 },
        rippleHoldMs: [170, 320],
        rippleSwell: 0.5,
        rippleLeadMs: 40,
      };
    }
    case "pulse": {
      const restScale = 1 - 0.04 * a1;
      return {
        ...rise,
        restScale,
        restLift: 0,
        scaleKeys: [
          [0, restScale],
          [0.12, 1 + 0.05 * a2],
          [0.5, 1.008],
          [1, 1],
        ],
        liftKeys: [
          [0, 0],
          [1, 0],
        ],
        scaleSpring: { hz: 2.6 * f, damping: 0.42 },
        glowPeak: 1,
        rippleHeight: 0,
      };
    }
    case "drop": {
      const restScale = 1 - 0.04 * a1;
      return {
        ...rise,
        restScale,
        restLift: -0.045 * A,
        scaleKeys: [
          [0, restScale],
          [0.3, 1.02],
          [1, 1],
        ],
        liftKeys: [
          [0, -0.045 * A],
          [0.3, 0.01 * A],
          [0.6, 0],
          [1, 0],
        ],
        liftSpring: { hz: 1.9 * f, damping: 0.36 },
        scaleSpring: { hz: 1.2 * f, damping: 0.55 },
        rippleHeight: Math.min(0.06, 0.02 * A),
      };
    }
    default:
      return rise;
  }
}

export function motionParams(input: MotionInput): MotionParams {
  const k = clamp(finite(input.effects, 50), 0, 100) / 50;
  const full = input.motion && input.power !== "lite";
  const A = full ? clamp((clamp(finite(input.energy, 0.45), 0, 1) * k) / BL_ENERGY, 0, A_MAX) : 0;
  const f = 0.8 + 0.5 * clamp(finite(input.snap, 0.4), 0, 1);
  const move = input.move ?? "rise";
  const tuning = moveTuning(move, A, f);
  const letterRest = 1 - 0.03 * Math.min(A, 1);
  return {
    move,
    amp: A,
    pace: f,
    karaoke: full ? "full" : "fade",
    ...tuning,
    glowKeys: GLOW_KEYS,
    glowSpring: { hz: 2 * f, damping: 0.62 },
    glowPeakHeld: 1,
    emphasis: input.emphasis,
    letterLiftGain: 2.2,
    letterScaleKeys: [
      [0, letterRest],
      [0.7, 1 + 0.07 * Math.min(A, 2)],
      [1, 1],
    ],
    letterGlowSpring: { hz: 1.2 * f, damping: 0.5 },
    dotAmp: Math.min(1, A),
    tailMs: 1300,
    fadeMs: 140,
    steadyGlow: 0.6,
    fadeSteps: input.power === "lite" ? LITE_FADE_STEPS : 0,
  };
}

/**
 * Each line's parameters by its move (Effects mode moves a song's hooks differently from its other
 * lines), worked out once per move for the song's parameters of the moment.
 */
export class LineMoves {
  private base: MotionParams | null = null;
  private readonly byMove = new Map<Move, MotionParams>();
  /**
   * `riseSwell`: every move swells (scales) no more than rise does, and as slowly. Lens magnifies the
   * sung word itself; a move's own swell on top would push it into its neighbors.
   */
  constructor(private readonly options: { riseSwell?: boolean } = {}) {}

  /** The parameters for a line that moves `move`: the song's own (`base`, from `input`), reshaped. */
  paramsFor(input: MotionInput, base: MotionParams, move: Move): MotionParams {
    if (move === base.move) return base;
    if (base !== this.base) {
      this.base = base;
      this.byMove.clear();
    }
    let params = this.byMove.get(move);
    if (!params) {
      params = motionParams({ ...input, move });
      if (this.options.riseSwell) {
        const { restScale, scaleKeys, scaleSpring } = moveTuning("rise", params.amp, params.pace);
        params = { ...params, restScale, scaleKeys, scaleSpring };
      }
      this.byMove.set(move, params);
    }
    return params;
  }
}

/** A key for "the parameters changed": a restyle re-plans the focus line only then. */
export function paramsKey(p: MotionParams): string {
  return JSON.stringify([p.amp, p.pace, p.karaoke, p.fadeSteps, p.emphasis, p.move]);
}

/**
 * How Settings.glow (W, 0..100) scales the bloom the song's look asks for: 0.3 at Glow 0 (a faint
 * core and halo, never off), 1 at the default 40, 1.5 at 100.
 */
export function glowGain(settingsGlow: number): number {
  const w = clamp(finite(settingsGlow, 40), 0, 100);
  return w <= 40 ? 0.3 + (0.7 * w) / 40 : 1 + (0.5 * (w - 40)) / 60;
}

/** b: the bloom's strength from the song's glow (G) and Settings.glow (W). */
export function bloomOf(songGlow: number, settingsGlow: number): number {
  return clamp(finite(songGlow, 0.6) * glowGain(settingsGlow), 0, 1.3);
}

/** The A = 1 numbers (energy 0.3, snap 0.4, Effects 50): Beautiful Lyrics' own motion, as studied. */
export const BL_REFERENCE = {
  amp: 1,
  pace: 1,
  restScale: 0.95,
  restLift: 0.01,
  scalePeak: 1.026,
  liftKey: -0.018,
  liftSpring: { hz: 1.3, damping: 0.4 },
  scaleSpring: { hz: 0.8, damping: 0.6 },
  glowSpring: { hz: 2, damping: 0.62 },
  rippleHeight: 0.06,
  rippleSpring: { hz: 3.1, damping: 0.4 },
  letterRestLift: 0.022,
  letterLiftKey: -0.0396,
  letterRestScale: 0.97,
  letterScalePeak: 1.07,
  letterGlowSpring: { hz: 1.2, damping: 0.5 },
} as const;

/** The input that gives BL_REFERENCE. */
export const BL_INPUT: MotionInput = { energy: BL_ENERGY, snap: 0.4, effects: 50, motion: true, power: "full", emphasis: BL_EMPHASIS };

// ---------- the line-to-line motion and the list (Stack and Drift) ----------

/** The view reaches a line this long before its first word (schedule.ts); a break's dots are gone by then. */
export const LEAD_MS = 300;

/** The list's scroll: about 5 % overshoot, settled in about 0.65 s. Plain lyrics move calmly. */
export const SCROLL_SPRING: SpringSpec = { hz: 1.5, damping: 0.68 };
export const CALM_SCROLL_SPRING: SpringSpec = { hz: 0.75, damping: 1 };
/** Brightness one line from the focus: sung lines a little brighter than upcoming ones... */
export const SUNG_LEVEL = 0.58;
export const UPCOMING_LEVEL = 0.46;
/** ...fading to nothing this many lines away. */
export const REACH = 3.5;
/** Neighbor size: Stack's stay nearly whole so it reads as one list, Drift's recede. */
export const STACK_NEIGHBOR_SCALE = 0.92;
export const DRIFT_NEIGHBOR_SCALE = 0.58;
/** Distance blur per line, in font sizes, up to BLUR_STEPS lines. */
export const STACK_BLUR_EM = 0.022;
export const DRIFT_BLUR_EM = 0.032;
export const BLUR_STEPS = 4;
/** Drift's depth: the perspective distance and how far back each line of distance steps, in font sizes; degrees of tilt per line. */
export const DRIFT_PERSPECTIVE_EM = 15.5;
export const DRIFT_RECEDE_EM = 2.4;
export const DRIFT_TILT_DEG = 14;
/**
 * The lite tier's scroll holds each position for this long (30 a second) where the compositor runs
 * stepped keyframes: software compositing redraws the whole list for every frame it moves.
 */
export const LITE_SCROLL_MS = 1000 / 30;
/** A jump further than this many lines (a seek) cuts, with the stage's crossfade, instead of gliding. */
export const MAX_GLIDE_LINES = 3;
/** A line coming into focus eases its upcoming words into their rest pose over this long. */
export const SETTLE_IN_MS = 240;
/**
 * The line leaving focus keeps its overlay at least this long after the change: lit while the list
 * scrolls, it hands back to its plain text as the new line starts, its overlay fading out until the
 * list comes to rest, and is taken down then (DriftMode.handBack). Taking it down falls after the
 * busiest frames of the line change.
 */
export const LEAVE_MS = 420;

// ---------- the interlude dots ----------

export const DOTS = {
  /** each dot's diameter in font sizes, and the room between two, in diameters */
  em: 0.44,
  gap: 0.55,
  /** the dots fill over this share of the break, a third each */
  fillShare: 0.925,
  scaleKeys: [
    [0, 0.75],
    [0.7, 1.05],
    [1, 1],
  ] as readonly Key[],
  /** in diameters, positive down: the spline swings to about -0.45 around 60 % */
  liftKeys: [
    [0, 0.125],
    [0.9, -0.22],
    [1, 0],
  ] as readonly Key[],
  brightKeys: [
    [0, 0.35],
    [0.6, 1],
    [1, 1],
  ] as readonly Key[],
  haloKeys: [
    [0, 0],
    [0.6, 1],
    [1, 1],
  ] as readonly Key[],
  liftSpring: { hz: 1.25, damping: 0.4 } as SpringSpec,
  scaleSpring: { hz: 0.8, damping: 0.6 } as SpringSpec,
  brightSpring: { hz: 1, damping: 0.5 } as SpringSpec,
  /** the group pops in on this spring, fading in over fadeInMs... */
  popInSpring: { hz: 4.5, damping: 0.62 } as SpringSpec,
  fadeInMs: 450,
  /** ...breathes 1 ± breath every breathMs... */
  breath: 0.045,
  breathMs: 4500,
  /** ...swells to this size over the swellMs before it pops out... */
  swell: 1.15,
  swellMs: 250,
  /** ...and pops out on this spring over the break's last fadeOutMs, fading as it goes: gone by E. */
  popOutSpring: { hz: 5, damping: 0.7 } as SpringSpec,
  fadeOutMs: 200,
  /** reduced motion and lite: the group fades in over this long, each dot brightens over brightenMs */
  calmFadeInMs: 300,
  brightenMs: 250,
} as const;
