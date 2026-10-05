import { h } from "./dom";
import { textShadow, type Look } from "./look";

/** Everything the stage shows when there are no lines to sing. */
export type StateKind = "loading" | "not-found" | "instrumental" | "error";

/** Each state's CSS animation delay (styles/stage.css): loading waits 600 ms before it pulses. */
const DELAY_MS: Record<StateKind, number> = { loading: 600, "not-found": 0, instrumental: 0, error: 0 };

const CHIP_TEXT: Partial<Record<StateKind, string>> = {
  "not-found": "No lyrics for this song",
  error: "Couldn't load lyrics",
};

/**
 * Builds a state presentation. All motion is CSS (see styles/stage.css), so none of it needs the
 * animation loop:
 * - loading: nothing for 600 ms, then a faint pulse
 * - not-found / error: a small chip that fades out after 4 s
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
    el.style.fontSize = `${Math.max(12, look.size * 0.3)}px`;
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
