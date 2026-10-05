import { h } from "./dom";
import { textShadow, type Look } from "./look";

/** Everything the stage shows when there are no lines to sing. */
export type StateKind = "loading" | "not-found" | "instrumental" | "error";

const CHIP_TEXT: Partial<Record<StateKind, string>> = {
  "not-found": "No lyrics for this song",
  error: "Couldn't load lyrics",
};

/**
 * Builds a state presentation. All motion is CSS (see styles/overlay.css), so none of it needs the
 * animation loop:
 * - loading: nothing for 600 ms, then a faint pulse
 * - not-found / error: a small chip that fades out after 4 s
 * - instrumental: a slow breathing ♪
 */
export function buildState(host: HTMLElement, kind: StateKind, look: Look): void {
  host.textContent = "";
  const el = h("div", `state state-${kind}`);
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
