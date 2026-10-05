import { h } from "./dom";
import { textShadow, type Look } from "./look";

/** Everything the stage shows when there are no lines to sing. */
export type StateKind = "loading" | "not-found" | "instrumental" | "error";

/** The stage fades a scene out over this long, and the next one in over this long once it's gone (C6). */
export const SCENE_FADE_OUT_MS = 250;
export const SCENE_FADE_IN_MS = 450;
/** Loading shows nothing at all for this long, then a faint pulse. */
export const LOADING_DELAY_MS = 600;
/** The not-found and error chips stay fully readable for this long once their scene has faded in... */
const CHIP_HOLD_MS = 4000;
/** ...which takes at most this long: the old scene fading out, then this one fading in. */
const CHIP_REVEAL_MS = SCENE_FADE_OUT_MS + SCENE_FADE_IN_MS;

/**
 * Each state's CSS animation delay (styles/stage.css): loading waits before it pulses, a chip holds
 * before it fades out.
 */
const DELAY_MS: Record<StateKind, number> = {
  loading: LOADING_DELAY_MS,
  "not-found": CHIP_REVEAL_MS + CHIP_HOLD_MS,
  instrumental: 0,
  error: CHIP_REVEAL_MS + CHIP_HOLD_MS,
};

const CHIP_TEXT: Partial<Record<StateKind, string>> = {
  "not-found": "No lyrics for this song",
  error: "Couldn't load lyrics",
};

/**
 * Builds a state presentation. All motion is CSS (see styles/stage.css), so none of it needs the
 * animation loop:
 * - loading: nothing for 600 ms, then a faint pulse
 * - not-found / error: a small chip that comes in with its scene, stays for 4 s, then fades out
 * - instrumental: a slow breathing ♪
 *
 * `elapsedMs` is how long this state has been showing. A rebuild (settings change, resize, late
 * artwork) resumes the animation where it was, so a faded chip stays gone.
 */
export function buildState(host: HTMLElement, kind: StateKind, look: Look, elapsedMs = 0): void {
  host.textContent = "";
  const el = h("div", `state state-${kind}`);
  el.style.animationDelay = `${Math.round(DELAY_MS[kind] - Math.max(0, elapsedMs))}ms`;
  el.style.top = `${look.y}px`;
  el.style.color = look.colors.lyric;
  const chip = CHIP_TEXT[kind];
  if (chip) {
    el.classList.add("state-chip");
    el.textContent = chip;
    const fontSize = Math.max(12, look.size * 0.3);
    el.style.fontSize = `${fontSize}px`;
    // The pill is 2.1em tall (1em of text plus 0.55em padding each side) and can be taller than the
    // margin that keeps a lyric line on screen: keep the whole pill, plus its shadow, inside the stage.
    const half = fontSize * 1.05 + 2;
    el.style.top = `${Math.min(Math.max(look.y, half), Math.max(half, look.height - half))}px`;
  } else if (kind === "instrumental") {
    el.textContent = "♪";
    el.style.fontFamily = look.font;
    el.style.fontSize = `${look.size * 1.1}px`;
    el.style.textShadow = textShadow(look, look.size * 1.1, true);
  } else {
    el.setAttribute("aria-hidden", "true");
    el.style.fontSize = `${look.size}px`;
    for (let i = 0; i < 3; i++) {
      const dot = h("i");
      dot.style.background = look.colors.lyric;
      dot.style.boxShadow = textShadow(look, look.size * 0.5);
      el.append(dot);
    }
  }
  host.append(el);
}
