/**
 * The motion engine shared by the lyric styles: springs and target curves planned ahead as keyframes,
 * a song timeline that keeps Web Animations on song time (play, pause, seek, drift), the per-word
 * karaoke (wipe, pop, bloom, letter ripple, held-note emphasis), the instrumental-break dots, the
 * line-to-line glide on the document timeline, and every parameter in one place (params.ts).
 */
export { bloomLayers, bloomShadow, dotBloom, paintVars } from "./bloom";
export { clamp01, sineOut, sineOutInverse, spline, type Key } from "./curve";
export { InterludeDots } from "./dots";
export { findInterludes, interludeAt, planDots, INTERLUDE_AFTER_MS, INTERLUDE_MIN_MS, type DotsMotion, type Interlude } from "./interlude";
export {
  closedWindow,
  emphasized,
  heldPart,
  heldParts,
  letterRest,
  partsOf,
  planWord,
  rebase,
  restTransform,
  wipeEdge,
  wordUntil,
  FEATHER,
  FULL_TRANSFORM,
  OVERHANG,
  PLAN_MS,
  type LetterBox,
  type Part,
  type PlanOptions,
  type Track,
  type WordMotion,
  type WordShape,
  type WordTiming,
} from "./karaoke";
export {
  compositorSteps,
  framesOf,
  keyframesAt,
  keyPoints,
  liftScale,
  num,
  sampleTimes,
  thin,
  HOLD,
  SAMPLE_MS,
  STEP_MS,
  type KeyPoint,
  type Stepping,
} from "./keyframes";
export { canvasMeasure, cased, casedLines, graphemes, isRtl, measureLetters, roughMeasure, splittable, type Measure, type TextCase } from "./letters";
export { KaraokeLine, LEAVE_MS, SETTLE_IN_MS, SLICE_MS, type Along, type KaraokeLook, type LetterPlacer } from "./line";
export {
  bloomOf,
  glowGain,
  motionParams,
  paramsKey,
  A_MAX,
  BL_EMPHASIS,
  BL_ENERGY,
  BL_INPUT,
  BL_REFERENCE,
  CALM_SCROLL_SPRING,
  DOTS,
  LEAD_MS,
  SCROLL_SPRING,
  type EmphasisRule,
  type MotionInput,
  type MotionParams,
} from "./params";
export { detectPower, forcedPower, isSoftwareRenderer, probePower, type Power } from "./power";
export { focusAt, leadTimes, untilNext, type FocusAt } from "./schedule";
export { playWall, springFrames, WallGlide, type GlideSamples, type WallFrames } from "./scroll";
export { chase, Glide, settleMs, springStep, type SpringSpec, type SpringState } from "./spring";
export { SongTimeline, DEAD_ZONE_MS, JUMP_MS, type SongCue, type SyncResult } from "./timeline";
