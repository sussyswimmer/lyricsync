/**
 * The karaoke motion engine shared by the lyric modes: springs and target curves planned ahead as
 * keyframes, a song timeline that keeps Web Animations on song time (play, pause, seek, slew), the
 * per-word karaoke (wipe, pop, bloom, letter ripple, held-word emphasis) and instrumental-break dots.
 */
export { bloomShadow, dotBloom } from "./bloom";
export { clamp01, sineOut, spline, type Key } from "./curve";
export { findInterludes, interludeAt, planDots, INTERLUDE_MIN_MS, type DotsMotion, type Interlude } from "./interlude";
export {
  emphasized,
  planWord,
  restTransform,
  songEnergy,
  wipeEdge,
  EMPHASIS_CHARS,
  EMPHASIS_MS,
  FEATHER,
  type LetterBox,
  type MotionOptions,
  type Part,
  type Track,
  type WordMotion,
  type WordShape,
  type WordTiming,
} from "./karaoke";
export { keyframesAt, liftScale, sampleTimes, thin, SAMPLE_MS } from "./keyframes";
export { canvasMeasure, graphemes, isRtl, measureLetters, splittable } from "./letters";
export { KaraokeLine, LOOKAHEAD_MS, type KaraokeLook } from "./line";
export { chase, Glide, settleMs, springStep, type SpringSpec, type SpringState } from "./spring";
export { SongTimeline, type SongCue, type SyncResult } from "./timeline";
