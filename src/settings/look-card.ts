import { FONTS } from "../core/faces";
import { lookLabel, type Style } from "../core/songlook";
import { h } from "../overlay/dom";
import type { StageView } from "../overlay/stage";
import { icon, nextId, setAttr, setText } from "./controls";

/**
 * What the "Picked for this song" card shows of a look: the style, the face and why. The stage's
 * PickedLook (what `ControllerOptions.onLook` reports) is one, and so is core/songlook's SongLook,
 * which adds the reason and its traits.
 */
export interface CardLook {
  style: Style;
  font: { family: string; weight: number };
  /** e.g. "slow, long held notes → Arc with Instrument Serif" */
  reason?: string;
  /** the plain-word traits behind the pick, e.g. ["big repeating hooks", "bright, warm cover"] */
  traits?: readonly string[];
}

/**
 * The card's state, for the song the preview plays. `key` is its trackKey (null before the preview
 * has a song), `demo` whether that song is the preview's demo, played because nothing else is.
 */
export type LookCardState =
  | { kind: "look"; key: string; demo: boolean; look: CardLook }
  | { kind: "finding"; key: string | null; demo: boolean }
  | { kind: "no-lyrics" | "error" | "instrumental"; key: string; demo: boolean };

export interface CardInput {
  /** the song the preview plays, null before it has one */
  key: string | null;
  demo: boolean;
  /** what the preview's stage makes of that song's lyrics (viewFor), null until they are known */
  view: StageView["kind"] | null;
  /** the look for that song, null until there is one */
  look: CardLook | null;
}

/**
 * A look picked before any lyrics (core/songlook's LookKeeper: provisional) only covers the loading,
 * not-found and instrumental states, where nothing but the face shows. It isn't the song's pick.
 */
export function isProvisional(look: CardLook): boolean {
  return look.traits?.includes("no lyrics") === true;
}

/** The card's state from what the preview plays. Pure. */
export function cardState({ key, demo, view, look }: CardInput): LookCardState {
  if (key === null) return { kind: "finding", key, demo };
  switch (view) {
    case "lyrics":
      return look && !isProvisional(look) ? { kind: "look", key, demo, look } : { kind: "finding", key, demo };
    case "not-found":
      return { kind: "no-lyrics", key, demo };
    case "error":
      return { kind: "error", key, demo };
    case "instrumental":
      return { kind: "instrumental", key, demo };
    default:
      // still loading, or nothing known yet
      return { kind: "finding", key, demo };
  }
}

/** Same card on screen: same song, same state and, for a look, the same label and reason. */
export function sameCard(a: LookCardState, b: LookCardState): boolean {
  if (a.kind !== b.kind || a.key !== b.key || a.demo !== b.demo) return false;
  if (a.kind !== "look" || b.kind !== "look") return true;
  return lookLabel(a.look) === lookLabel(b.look) && reasonSentence(a.look) === reasonSentence(b.look) && a.look.font.weight === b.look.font.weight;
}

/**
 * Why the look was picked, as a sentence: "Big repeating hooks, bright warm cover." From the traits
 * when the look has them (a trait's own comma is dropped, so the list reads as one), else from the
 * reason's part before the arrow. Empty without either.
 */
export function reasonSentence(look: CardLook): string {
  const why = look.traits && look.traits.length > 0 ? look.traits.map((t) => t.replace(/,\s*/gu, " ")).join(", ") : (look.reason?.split("→")[0] ?? "");
  const text = why.trim();
  if (!text) return "";
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/u.test(text) ? "" : "."}`;
}

/** How long a quiet update keeps the card's live region off, so a screen reader doesn't speak it. */
export const QUIET_MS = 1000;

/** Each style's glyph, as the old style tiles drew it. */
const GLYPHS: Record<Style, readonly [string, number, number][]> = {
  arc: [
    ["M7 4.6 Q12 1.2 17 4.6", 1.3, 0.45],
    ["M2.5 10.2 Q12 3.4 21.5 10.2", 2.4, 1],
    ["M7 14.6 Q12 11.2 17 14.6", 1.3, 0.45],
  ],
  lens: [
    ["M3 8 H5.5", 2.2, 0.5],
    ["M9.5 8 H14.5", 6, 1],
    ["M18.5 8 H21", 2.2, 0.5],
  ],
  drift: [
    ["M8 2.6 H16", 1.3, 0.4],
    ["M3 8 H21", 2.6, 1],
    ["M8 13.4 H16", 1.3, 0.4],
  ],
  stack: [
    ["M3 2.6 H21", 1.3, 0.4],
    ["M3 8 H21", 2.6, 1],
    ["M3 13.4 H21", 1.3, 0.4],
  ],
  // a block of rows, the short one set big
  poster: [
    ["M4 3 H20", 2.2, 0.55],
    ["M7 8.2 H17", 4.2, 1],
    ["M4 13.4 H20", 2.2, 0.55],
  ],
  // the sung word large in the middle, its neighbors small and faint to either side
  spotlight: [
    ["M2.5 8 H4.5", 1.6, 0.35],
    ["M8 8 H16", 5.2, 1],
    ["M19.5 8 H21.5", 1.6, 0.35],
  ],
  // the line riding a wave, the sung word on its crest
  wave: [
    ["M2.5 11 Q5 13.2 7.5 11", 1.8, 0.5],
    ["M9 7 Q12 3.4 15 7", 2.8, 1],
    ["M16.5 11 Q19 13.2 21.5 11", 1.8, 0.5],
  ],
  // sung words in, the rest still faint ghosts
  reveal: [
    ["M3 8 H8.5", 2.6, 1],
    ["M10.5 8 H15", 2.6, 1],
    ["M17 9.6 H21", 2, 0.25],
  ],
  // cut-out words, each its own size and tilt
  collage: [
    ["M3 5.6 L10.5 4", 2.6, 1],
    ["M12.5 4.4 L20.5 5.8", 1.8, 0.6],
    ["M6 12.2 L17 13.4", 3.4, 0.85],
  ],
  // one word at a time, big in the middle, the last one faint above and the next below
  reel: [
    ["M8.5 2.4 H15.5", 1.4, 0.35],
    ["M5 8 H19", 4.6, 1],
    ["M8.5 13.6 H15.5", 1.4, 0.6],
  ],
};
/** Three dots while the lyrics are on their way; one faint line when there are none. */
const WAITING: readonly [string, number, number][] = [
  ["M6 8 h0.01", 2.8, 0.55],
  ["M12 8 h0.01", 2.8, 0.55],
  ["M18 8 h0.01", 2.8, 0.55],
];
const NOTHING: readonly [string, number, number][] = [["M5 8 H19", 2, 0.4]];

const MESSAGES: Record<Exclude<LookCardState["kind"], "look">, string> = {
  finding: "Finding lyrics…",
  "no-lyrics": "No lyrics for this song",
  error: "Couldn't load lyrics",
  instrumental: "Instrumental",
};

/**
 * The read-only "Picked for this song" card under the live preview: the style and face Undertone
 * picked for the song the preview plays ("Lens · Syne", the face's name in that face), and why, as a
 * sentence. The demo song's look while nothing else plays; "Finding lyrics…" and the no-lyrics
 * states otherwise.
 *
 * Its text is a polite live region, announced when the song changes and only then: what it shows
 * while the lyrics are on their way, a later refinement of the same song's look, the window opening
 * and the demo's own song changes all update it quietly (the region is off meanwhile).
 */
export class LookCard {
  readonly el: HTMLElement;
  private readonly live: HTMLElement;
  private readonly glyph: HTMLElement;
  private readonly kicker: HTMLElement;
  private readonly name: HTMLElement;
  private readonly styleName: HTMLElement;
  private readonly sep: HTMLElement;
  private readonly spokenSep: HTMLElement;
  private readonly faceName: HTMLElement;
  private readonly message: HTMLElement;
  private readonly why: HTMLElement;
  private glyphKey = "";
  private shown: LookCardState | null = null;
  /** the last song the card showed (a gap with no song in between doesn't count); undefined: none yet */
  private seenKey: string | undefined = undefined;
  /** the song changed since the card last settled, so the next settled state is news */
  private owed = false;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.el = h("section", "picked");
    const intro = h("p", "hint picked-intro", "Undertone picks the style and font for each song.");
    const card = h("div", "picked-card");
    this.live = h("div", "picked-live");
    this.live.setAttribute("aria-live", "polite");
    this.live.setAttribute("aria-atomic", "true");
    this.glyph = h("span", "picked-glyph");
    this.glyph.setAttribute("aria-hidden", "true");
    const text = h("div", "picked-text");
    this.kicker = h("p", "picked-kicker");
    this.kicker.id = nextId("picked");
    this.el.setAttribute("aria-labelledby", this.kicker.id);
    this.name = h("p", "picked-name");
    this.styleName = h("span", "picked-style");
    // "Lens · Syne" on screen, "Lens, in Syne" spoken
    this.sep = h("span", "picked-sep", " · ");
    this.sep.setAttribute("aria-hidden", "true");
    this.spokenSep = h("span", "sr-only", ", in ");
    this.faceName = h("span", "picked-face");
    this.message = h("span", "picked-message");
    this.name.append(this.styleName, this.sep, this.spokenSep, this.faceName, this.message);
    this.why = h("p", "picked-why");
    text.append(this.kicker, this.name, this.why);
    this.live.append(this.glyph, text);
    card.append(this.live);
    this.el.append(intro, card);
    this.render({ kind: "finding", key: null, demo: false });
  }

  /** The state to show. Cheap when nothing it shows changed. */
  render(state: LookCardState): void {
    const before = this.shown;
    // A song change: another song than the last one shown. Not the first song (the window opening),
    // nor the same song back after a moment with none.
    if (state.key !== null) {
      if (this.seenKey !== undefined && state.key !== this.seenKey) this.owed = true;
      this.seenKey = state.key;
    }
    this.shown = state;
    const settled = state.kind !== "finding";
    // News: the first settled state of a song the user switched to. Not the window opening, not
    // the lyrics still on their way, not the demo's own song changes.
    const news = settled && this.owed && !state.demo;
    if (settled) this.owed = false;

    const look = state.kind === "look" ? state.look : null;
    // "Lens · Syne": the style, then the face, drawn in two parts
    const label = look ? lookLabel(look) : "";
    const cut = label.indexOf(" · ");
    const [styleText, faceText] = cut < 0 ? [label, ""] : [label.slice(0, cut), label.slice(cut + 3)];
    const texts: [HTMLElement, string][] = [
      [this.kicker, state.demo ? "Picked for the demo song" : "Picked for this song"],
      [this.styleName, styleText],
      [this.faceName, faceText],
      [this.message, state.kind === "look" ? "" : MESSAGES[state.kind]],
      [this.why, look ? reasonSentence(look) : ""],
    ];
    // The first render builds the card before it is on the page: nothing to keep quiet.
    const changed = texts.some(([el, text]) => el.textContent !== text);
    if (changed && before) {
      if (news) this.speak();
      else this.quiet();
    }
    for (const [el, text] of texts) setText(el, text);
    this.sep.hidden = !look;
    this.spokenSep.hidden = !look;
    this.why.hidden = !look;
    this.paintFace(look);
    this.paintGlyph(state);
    this.el.dataset.state = state.kind;
    setAttr(this.live, "aria-busy", settled ? null : "true");
  }

  /** The face's name in that face, at its weight (a face Undertone doesn't bundle: in the window's). */
  private paintFace(look: CardLook | null): void {
    const face = look ? FONTS.find((f) => f.family === look.font.family) : undefined;
    const style = this.faceName.style;
    style.fontFamily = face ? face.stack : "";
    style.fontWeight = face && look ? String(look.font.weight || face.weight) : "";
    if (face) this.faceName.dataset.family = face.family;
    else delete this.faceName.dataset.family;
  }

  private paintGlyph(state: LookCardState): void {
    const key = state.kind === "look" ? state.look.style : state.kind;
    if (key === this.glyphKey) return;
    this.glyphKey = key;
    const paths = state.kind === "look" ? GLYPHS[state.look.style] : state.kind === "finding" ? WAITING : NOTHING;
    this.glyph.textContent = "";
    this.glyph.append(state.kind === "instrumental" ? h("span", "picked-note", "♪") : icon(paths));
  }

  /** The next change is announced. */
  private speak(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    this.live.setAttribute("aria-live", "polite");
  }

  /** The next change isn't: the region is off while it lands, and polite again after QUIET_MS. */
  private quiet(): void {
    this.live.setAttribute("aria-live", "off");
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      this.live.setAttribute("aria-live", "polite");
    }, QUIET_MS);
  }
}
