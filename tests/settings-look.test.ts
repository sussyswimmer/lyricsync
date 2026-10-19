import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type NowPlaying, type Settings } from "../contract/contract";
import { createMockBridge, MOCK_TRACKS, trackKeyOf, type MockBridge } from "../src/bridge/mock";
import type { Bridge } from "../src/bridge/types";
import { FONTS } from "../src/core/faces";
import { PaletteCache } from "../src/core/palette";
import { cardState, isProvisional, QUIET_MS, reasonSentence, sameCard, type CardLook, type LookCardState, type LookCard as Card } from "../src/settings/look-card";
import { EFFECTS_MODE_OFF, EFFECTS_MODE_ON, type MotionQuery, type PanelState, type SettingsPanel as Panel } from "../src/settings/panel";
import { DEMO_START_MS, DEMO_TRACKS, SettingsPreview } from "../src/settings/preview";
import { resetDom, stubDom, type FakeElement } from "./fake-dom";

/*
 * Contract v4 in the settings window: Undertone picks the style and the face for each song, so the
 * window shows the pick (the "Picked for this song" card under the preview) instead of choosing it,
 * and its Look group scales it: Size, Effects, Glow and Opacity. No Style or Font group, no Curve
 * slider, and since contract v6 no Height slider: the lyrics always sit in the middle of the screen.
 */

// The preview's stage and controller draw and animate; what the card shows needs neither.
const previewFakes = vi.hoisted(() => {
  class Stage {
    setSettings(): void {}
    destroy(): void {}
  }
  class Controller {
    track: NowPlaying | null = null;
    private readonly bridge: Bridge;
    constructor(bridge: Bridge) {
      this.bridge = bridge;
    }
    async start(): Promise<void> {
      this.track = await this.bridge.invoke("get_now_playing");
      await this.bridge.listen("now-playing", (np) => (this.track = np));
    }
    setSettings(): void {}
    kick(): void {}
    destroy(): void {}
  }
  return { Stage, Controller };
});
vi.mock("../src/overlay/stage", () => ({ LyricStage: previewFakes.Stage }));
vi.mock("../src/overlay/controller", () => ({ OverlayController: previewFakes.Controller }));

// Both build DOM when they load (icons), so the fake DOM has to be there first.
let LookCard: typeof Card;
let SettingsPanel: typeof Panel;
beforeAll(async () => {
  stubDom();
  ({ LookCard } = await import("../src/settings/look-card"));
  ({ SettingsPanel } = await import("../src/settings/panel"));
});

beforeEach(() => {
  resetDom();
  stubDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const LENS_SYNE: CardLook = {
  style: "lens",
  font: { family: "Syne", weight: 800 },
  traits: ["big repeating hooks", "bright, warm cover"],
  reason: "big repeating hooks, bright, warm cover → Lens with Syne",
};
const DRIFT_SERIF: CardLook = {
  style: "drift",
  font: { family: "Instrument Serif", weight: 400 },
  traits: ["cold cover", "slow", "long instrumental gaps"],
  reason: "cold cover, slow, long instrumental gaps → Drift with Instrument Serif",
};
const PROVISIONAL: CardLook = { style: "stack", font: { family: "Fraunces", weight: 700 }, traits: ["no lyrics"], reason: "no lyrics → Fraunces" };

const look = (key: string, l: CardLook = LENS_SYNE, demo = false): LookCardState => ({ kind: "look", key, demo, look: l });
/** The trackKey of mock track `i`. */
const keyOf = (i: number): string => {
  const t = MOCK_TRACKS[i];
  if (!t) throw new Error(`no mock track ${i}`);
  return trackKeyOf(t);
};
const finding = (key: string | null, demo = false): LookCardState => ({ kind: "finding", key, demo });

// ───────────────────────────── the card's state ─────────────────────────────

describe("cardState: what the card shows for the preview's song", () => {
  it("finds lyrics until there is a song, its lyrics and its look", () => {
    expect(cardState({ key: null, demo: false, view: null, look: null })).toEqual(finding(null));
    expect(cardState({ key: "k", demo: false, view: null, look: LENS_SYNE })).toEqual(finding("k"));
    expect(cardState({ key: "k", demo: false, view: "loading", look: LENS_SYNE })).toEqual(finding("k"));
    expect(cardState({ key: "k", demo: true, view: "lyrics", look: null })).toEqual(finding("k", true));
  });

  it("shows the look once the lyrics are in, but never a look picked before them", () => {
    expect(cardState({ key: "k", demo: false, view: "lyrics", look: LENS_SYNE })).toEqual(look("k"));
    expect(cardState({ key: "k", demo: true, view: "lyrics", look: LENS_SYNE })).toEqual(look("k", LENS_SYNE, true));
    // the controller's provisional look covers the loading view: still finding lyrics
    expect(isProvisional(PROVISIONAL)).toBe(true);
    expect(cardState({ key: "k", demo: false, view: "lyrics", look: PROVISIONAL })).toEqual(finding("k"));
    // a stage PickedLook carries no traits: it is the song's pick
    expect(isProvisional({ style: "arc", font: { family: "Fraunces", weight: 700 } })).toBe(false);
  });

  it("says so when there are no lyrics, they couldn't load, or the song is instrumental", () => {
    expect(cardState({ key: "k", demo: false, view: "not-found", look: PROVISIONAL })).toEqual({ kind: "no-lyrics", key: "k", demo: false });
    expect(cardState({ key: "k", demo: false, view: "error", look: null })).toEqual({ kind: "error", key: "k", demo: false });
    expect(cardState({ key: "k", demo: false, view: "instrumental", look: null })).toEqual({ kind: "instrumental", key: "k", demo: false });
  });

  it("sameCard: same song, state, label and reason", () => {
    expect(sameCard(look("k"), look("k", { ...LENS_SYNE }))).toBe(true);
    expect(sameCard(look("k"), look("j"))).toBe(false);
    expect(sameCard(look("k"), look("k", DRIFT_SERIF))).toBe(false);
    expect(sameCard(look("k"), look("k", { ...LENS_SYNE, traits: ["shouted lines"] }))).toBe(false);
    expect(sameCard(look("k"), look("k", LENS_SYNE, true))).toBe(false);
    expect(sameCard(finding("k"), finding("k"))).toBe(true);
    expect(sameCard(finding("k"), { kind: "no-lyrics", key: "k", demo: false })).toBe(false);
  });
});

describe("reasonSentence: why, as a sentence", () => {
  it("joins the traits, dropping a trait's own comma, capitalized, with a period", () => {
    expect(reasonSentence(LENS_SYNE)).toBe("Big repeating hooks, bright warm cover.");
    expect(reasonSentence(DRIFT_SERIF)).toBe("Cold cover, slow, long instrumental gaps.");
    expect(reasonSentence({ ...LENS_SYNE, traits: ["a bit of everything"] })).toBe("A bit of everything.");
  });

  it("falls back to the reason before its arrow, and says nothing without either", () => {
    const { traits: _traits, ...picked } = DRIFT_SERIF;
    expect(reasonSentence(picked)).toBe("Cold cover, slow, long instrumental gaps.");
    expect(reasonSentence({ ...picked, traits: [] })).toBe("Cold cover, slow, long instrumental gaps.");
    expect(reasonSentence({ style: "arc", font: { family: "Fraunces", weight: 700 } })).toBe("");
    expect(reasonSentence({ style: "arc", font: { family: "Fraunces", weight: 700 }, reason: "Already said!" })).toBe("Already said!");
  });
});

// ───────────────────────────── the card ─────────────────────────────

function mountCard() {
  const card = new LookCard();
  const el = card.el as unknown as FakeElement;
  const live = el.one("picked-live");
  return {
    card,
    el,
    live,
    kicker: el.one("picked-kicker"),
    style: el.one("picked-style"),
    sep: el.one("picked-sep"),
    face: el.one("picked-face"),
    message: el.one("picked-message"),
    why: el.one("picked-why"),
    glyph: el.one("picked-glyph"),
    /** what a sighted user reads on the name line */
    shown: (): string => {
      const parts = [el.one("picked-style"), el.one("picked-sep"), el.one("picked-face"), el.one("picked-message")];
      return parts.filter((p) => !p.hidden).map((p) => p.textContent).join("");
    },
  };
}

describe("the Picked for this song card", () => {
  it("says what it is and finds lyrics until it knows the song's look", () => {
    const c = mountCard();
    expect(c.el.one("picked-intro").textContent).toBe("Undertone picks the style and font for each song.");
    expect(c.el.getAttribute("aria-labelledby")).toBe(c.kicker.id);
    expect(c.kicker.textContent).toBe("Picked for this song");
    expect(c.shown()).toBe("Finding lyrics…");
    expect(c.why.hidden).toBe(true);
    expect(c.live.getAttribute("aria-live")).toBe("polite");
    expect(c.live.getAttribute("aria-atomic")).toBe("true");
    expect(c.live.getAttribute("aria-busy")).toBe("true");
    expect(c.el.dataset["state"]).toBe("finding");
  });

  it("shows the label in bold parts, the face's name in that face, and the reason", () => {
    const c = mountCard();
    c.card.render(look("k"));
    expect(c.shown()).toBe("Lens · Syne");
    expect(c.style.textContent).toBe("Lens");
    expect(c.face.textContent).toBe("Syne");
    // spoken "Lens, in Syne": the dot is hidden from screen readers
    expect(c.sep.getAttribute("aria-hidden")).toBe("true");
    expect(c.el.one("sr-only").textContent).toBe(", in ");
    const syne = FONTS.find((f) => f.family === "Syne");
    expect(c.face.style["fontFamily"]).toBe(syne?.stack);
    expect(c.face.style["fontWeight"]).toBe("800");
    expect(c.face.dataset["family"]).toBe("Syne");
    expect(c.why.textContent).toBe("Big repeating hooks, bright warm cover.");
    expect(c.why.hidden).toBe(false);
    expect(c.live.getAttribute("aria-busy")).toBeNull();
    expect(c.el.dataset["state"]).toBe("look");
    // the style's glyph, as the old tile drew it
    expect(c.glyph.getAttribute("aria-hidden")).toBe("true");
    expect(c.glyph.children[0]?.tagName).toBe("SVG");
  });

  it("names the demo song's look as the demo's, and every no-lyrics state in words", () => {
    const c = mountCard();
    c.card.render(look("d", DRIFT_SERIF, true));
    expect(c.kicker.textContent).toBe("Picked for the demo song");
    expect(c.shown()).toBe("Drift · Instrument Serif");
    for (const [kind, text] of [
      ["no-lyrics", "No lyrics for this song"],
      ["error", "Couldn't load lyrics"],
      ["instrumental", "Instrumental"],
    ] as const) {
      c.card.render({ kind, key: "k", demo: false });
      expect(c.shown(), kind).toBe(text);
      expect(c.kicker.textContent).toBe("Picked for this song");
      expect(c.why.hidden, kind).toBe(true);
      expect(c.face.style["fontFamily"], kind).toBe("");
      expect(c.live.getAttribute("aria-busy"), kind).toBeNull();
    }
    expect(c.glyph.textContent).toBe("♪");
  });

  it("keeps an unknown face's own name, in the window's font", () => {
    const c = mountCard();
    c.card.render(look("k", { style: "stack", font: { family: "Comic Neue", weight: 400 } }));
    expect(c.shown()).toBe("Stack · Comic Neue");
    expect(c.face.style["fontFamily"]).toBe("");
    expect(c.face.dataset["family"]).toBeUndefined();
    expect(c.why.textContent).toBe("");
  });

  it("rewrites nothing when the same state comes again (every second, with the song's resync)", () => {
    const c = mountCard();
    c.card.render(look("k"));
    const writes = [c.style, c.face, c.why, c.kicker, c.message].map((el) => el.textWrites);
    for (let i = 0; i < 10; i++) c.card.render(look("k", { ...LENS_SYNE }));
    expect([c.style, c.face, c.why, c.kicker, c.message].map((el) => el.textWrites)).toEqual(writes);
  });
});

describe("the card is announced on song changes only", () => {
  beforeEach(() => vi.useFakeTimers());

  const politeOrOff = (c: ReturnType<typeof mountCard>): string | null => c.live.getAttribute("aria-live");

  it("the window opening on a song isn't news: its first look lands quietly", () => {
    const c = mountCard();
    c.card.render(finding("k"));
    // nothing on screen changed yet
    expect(politeOrOff(c)).toBe("polite");
    c.card.render(look("k"));
    expect(politeOrOff(c)).toBe("off");
    vi.advanceTimersByTime(QUIET_MS - 1);
    expect(politeOrOff(c)).toBe("off");
    vi.advanceTimersByTime(1);
    expect(politeOrOff(c)).toBe("polite");
  });

  it("a new song is: quiet while its lyrics load, then its look is spoken", () => {
    const c = mountCard();
    c.card.render(look("a"));
    vi.advanceTimersByTime(QUIET_MS);
    c.card.render(finding("b"));
    expect(politeOrOff(c)).toBe("off");
    expect(c.live.getAttribute("aria-busy")).toBe("true");
    c.card.render(look("b", DRIFT_SERIF));
    // polite as the new look lands, with no quiet spell pending
    expect(politeOrOff(c)).toBe("polite");
    expect(vi.getTimerCount()).toBe(0);
    expect(c.shown()).toBe("Drift · Instrument Serif");
  });

  it("so is a song without lyrics, said once", () => {
    const c = mountCard();
    c.card.render(look("a"));
    c.card.render({ kind: "no-lyrics", key: "b", demo: false });
    expect(politeOrOff(c)).toBe("polite");
    // the same state again changes nothing, so nothing is said again
    c.card.render({ kind: "no-lyrics", key: "b", demo: false });
    expect(politeOrOff(c)).toBe("polite");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a later refinement of the same song's look lands quietly", () => {
    const c = mountCard();
    c.card.render(look("a"));
    c.card.render(look("b", DRIFT_SERIF));
    expect(politeOrOff(c)).toBe("polite");
    c.card.render(look("b", LENS_SYNE));
    expect(politeOrOff(c)).toBe("off");
    expect(c.shown()).toBe("Lens · Syne");
  });

  it("a new song that looks the same changes nothing on screen, so nothing is said", () => {
    const c = mountCard();
    c.card.render(look("a"));
    vi.advanceTimersByTime(QUIET_MS);
    const writes = c.style.textWrites;
    c.card.render(look("b"));
    expect(c.style.textWrites).toBe(writes);
    expect(politeOrOff(c)).toBe("polite");
    // and its refinement later is still quiet: the song's news was had
    c.card.render(look("b", DRIFT_SERIF));
    expect(politeOrOff(c)).toBe("off");
  });

  it("the demo's own song changes and the switch to it are quiet; the next real song is spoken", () => {
    const c = mountCard();
    c.card.render(look("a"));
    vi.advanceTimersByTime(QUIET_MS);
    c.card.render(look("demo-1", DRIFT_SERIF, true));
    expect(politeOrOff(c)).toBe("off");
    c.card.render(finding("demo-2", true));
    c.card.render(look("demo-2", LENS_SYNE, true));
    expect(politeOrOff(c)).toBe("off");
    c.card.render(finding("b"));
    c.card.render(look("b"));
    expect(politeOrOff(c)).toBe("polite");
  });

  it("the same song back after a moment with none isn't news", () => {
    const c = mountCard();
    c.card.render(look("a"));
    vi.advanceTimersByTime(QUIET_MS);
    c.card.render(finding(null));
    c.card.render(look("a"));
    expect(politeOrOff(c)).toBe("off");
  });
});

// ───────────────────────────── the panel ─────────────────────────────

/** A query whose `matches` the test flips, telling the panel as a MediaQueryList would. */
function motionQuery(matches = false): MotionQuery & { flip(next: boolean): void } {
  let listener: (() => void) | null = null;
  const query = {
    matches,
    addEventListener: (_type: "change", fn: () => void): void => {
      listener = fn;
    },
    flip(next: boolean): void {
      query.matches = next;
      listener?.();
    },
  };
  return query;
}

function mountPanel(over: Partial<Settings> = {}, reducedMotion: MotionQuery | null = motionQuery()) {
  let settings: Settings = { ...structuredClone(DEFAULT_SETTINGS), ...over };
  const edits: Partial<Settings>[] = [];
  let state: PanelState = {
    settings,
    palette: null,
    paletteFor: null,
    artPending: false,
    track: null,
    media: null,
    shortcuts: null,
    loginError: false,
    look: finding(null),
  };
  const panel = new SettingsPanel(
    {
      edit: (patch) => {
        edits.push(patch);
        settings = { ...settings, ...patch };
        panel.render((state = { ...state, settings }));
      },
      editNow: () => undefined,
      setTrackOffset: () => undefined,
      reset: () => undefined,
      suspendShortcuts: () => undefined,
    },
    { platform: "mac", reducedMotion },
  );
  panel.render(state);
  const root = panel.el as unknown as FakeElement;
  const group = (title: string): FakeElement => {
    const found = root.all("group").find((g) => g.one("group-title").textContent === title);
    if (!found) throw new Error(`no ${title} group`);
    return found;
  };
  const sliderIn = (g: FakeElement, label: string): FakeElement => {
    const row = g.all("slider").find((r) => r.one("row-label").textContent === label);
    if (!row) throw new Error(`no ${label} slider`);
    return row;
  };
  return {
    panel,
    root,
    edits,
    group,
    sliderIn,
    setLook(next: LookCardState): void {
      panel.render((state = { ...state, look: next }));
    },
  };
}

describe("the settings panel since contract v4", () => {
  it("has no Style or Font group and no Curve: the look is picked per song", () => {
    const p = mountPanel();
    expect(p.root.all("group").map((g) => g.one("group-title").textContent)).toEqual(["General", "Color", "Look", "Behavior", "Sync", "Shortcuts"]);
    expect(p.root.all("slider").map((r) => r.one("row-label").textContent)).not.toContain("Curve");
    // the only choices left are Behavior's two segments
    expect(p.root.all("seg").map((g) => g.getAttribute("aria-label"))).toEqual(["When to show lyrics", "Where to show lyrics"]);
    for (const gone of ["modes", "fonts", "font-note", "mode-blurb", "tiles"]) expect(p.root.all(gone), gone).toEqual([]);
  });

  it("puts the Picked for this song card right under the preview's notice, and shows what the window hands it", () => {
    const p = mountPanel();
    expect(p.root.children[1]?.classList.contains("picked")).toBe(true);
    const card = p.root.one("picked");
    expect(card.one("picked-message").textContent).toBe("Finding lyrics…");
    p.setLook(look("k"));
    expect(card.one("picked-style").textContent).toBe("Lens");
    expect(card.one("picked-face").textContent).toBe("Syne");
  });

  it("the Look group holds Size, Effects, Glow and Opacity: no Height, the lyrics stay in the middle", () => {
    const p = mountPanel();
    expect(p.group("Look").all("slider").map((r) => r.one("row-label").textContent)).toEqual(["Size", "Effects", "Glow", "Opacity"]);
    expect(p.root.all("group").map((g) => g.one("group-title").textContent)).not.toContain("Layout");
  });

  it("Effects: 0 to 100 from Calm to Lively, spoken as a word and the level, saved as `effects`", () => {
    const p = mountPanel();
    const row = p.sliderIn(p.group("Look"), "Effects");
    const input = row.one("range");
    expect([input.min, input.max, input.step, input.value]).toEqual(["0", "100", "1", "50"]);
    expect(input.getAttribute("aria-valuetext")).toBe("Balanced, 50");
    // the ends, for the eye: the spoken value says the same
    const ends = row.one("scale");
    expect(ends.getAttribute("aria-hidden")).toBe("true");
    expect(ends.children.map((c) => c.textContent)).toEqual(["Calm", "Lively"]);
    for (const [level, spoken] of [
      [0, "Calm, 0"],
      [33, "Calm, 33"],
      [34, "Balanced, 34"],
      [66, "Balanced, 66"],
      [67, "Lively, 67"],
      [100, "Lively, 100"],
    ] as const) {
      input.value = String(level);
      input.dispatch("input");
      expect(input.getAttribute("aria-valuetext")).toBe(spoken);
    }
    expect(p.edits.map((e) => e.effects)).toEqual([0, 33, 34, 66, 67, 100]);
    expect(row.one("row-value").textContent).toBe("100");
  });

  it("Effects: shows the saved level, and an older core's settings as the level picked", () => {
    const p20 = mountPanel({ effects: 20 });
    expect(p20.sliderIn(p20.group("Look"), "Effects").one("range").value).toBe("20");
    const old: Partial<Settings> = structuredClone(DEFAULT_SETTINGS);
    delete old.effects;
    const p = mountPanel(old);
    expect(p.sliderIn(p.group("Look"), "Effects").one("range").value).toBe("50");
  });

  it("Effects says what it does, and when the system asks for less motion, that words fade instead", () => {
    const query = motionQuery(false);
    const p = mountPanel({}, query);
    const input = p.sliderIn(p.group("Look"), "Effects").one("range");
    const hint = p.root.all("hint").find((h) => h.id === input.getAttribute("aria-describedby"));
    expect(hint?.textContent).toBe("How much words rise, swell and ripple as they're sung.");
    query.flip(true);
    expect(hint?.textContent).toBe("How much words rise, swell and ripple as they're sung. Your system asks for less motion: words fade instead of moving.");
    query.flip(false);
    expect(hint?.textContent).toBe("How much words rise, swell and ripple as they're sung.");
    // already reduced when the window opens; and no query at all (an engine without matchMedia)
    const reduced = mountPanel({}, motionQuery(true));
    expect(reduced.root.all("hint").some((h) => h.textContent.endsWith("words fade instead of moving."))).toBe(true);
    const none = mountPanel({}, null);
    expect(none.root.all("hint").some((h) => h.textContent === "How much words rise, swell and ripple as they're sung.")).toBe(true);
  });

  it("Effects mode: a switch at the top of Look, on by default, saved as `effectsMode`, saying what it does", () => {
    const p = mountPanel();
    const look = p.group("Look");
    const row = look.all("toggle")[0] as FakeElement;
    expect(row.one("row-label").textContent).toBe("Effects mode");
    const input = row.one("switch");
    expect(input.getAttribute("role")).toBe("switch");
    expect(input.checked).toBe(true);
    const caption = p.root.all("toggle-hint").find((h) => h.id === input.getAttribute("aria-describedby"));
    expect(caption?.textContent).toBe(EFFECTS_MODE_ON);
    input.checked = false;
    input.dispatch("change");
    expect(p.edits).toEqual([{ effectsMode: false }]);
    expect(input.checked).toBe(false);
    expect(caption?.textContent).toBe(EFFECTS_MODE_OFF);
    // the sliders come after it, in the same order as before
    expect(look.all("row-label").map((l) => l.textContent)).toEqual(["Effects mode", "Size", "Effects", "Glow", "Opacity"]);
  });

  it("Effects mode: shows the saved state, and an older core's settings as on", () => {
    const off = mountPanel({ effectsMode: false });
    expect((off.group("Look").all("switch")[0] as FakeElement).checked).toBe(false);
    const old: Partial<Settings> = structuredClone(DEFAULT_SETTINGS);
    delete old.effectsMode;
    const p = mountPanel(old);
    expect((p.group("Look").all("switch")[0] as FakeElement).checked).toBe(true);
  });

  it("Glow says what it does now: the sung word's glow, never quite off", () => {
    const p = mountPanel();
    const input = p.sliderIn(p.group("Look"), "Glow").one("range");
    const hint = p.root.all("hint").find((h) => h.id === input.getAttribute("aria-describedby"));
    expect(hint?.textContent).toBe("How much the sung word glows. 0 keeps a faint glow.");
    input.value = "0";
    input.dispatch("input");
    expect(p.edits).toEqual([{ glow: 0 }]);
  });

  it("Reset to defaults says it resets Effects, colors and the rest", () => {
    const p = mountPanel();
    const confirm = p.root.one("confirm");
    expect(confirm.textContent).toContain(
      "Effects, colors, layout, behavior, sync for all songs and shortcuts go back to how Undertone started. Lyrics on the desktop and Launch at login stay as they are.",
    );
    expect(confirm.textContent).not.toMatch(/Style|font/);
  });
});

// ───────────────────────────── the preview feeds the card ─────────────────────────────

describe("the preview hands the card its song's look", () => {
  const live: { bridge: MockBridge; preview: SettingsPreview }[] = [];
  afterEach(() => {
    for (const { bridge, preview } of live.splice(0)) {
      preview.dispose();
      bridge.dispose();
    }
  });

  /** The settings window's preview on a mock bridge, as main.ts wires it, with every update recorded. */
  async function mountPreview(query: string) {
    vi.useFakeTimers({ now: 1_760_000_000_000 });
    const bridge = createMockBridge({ shared: false, keys: false, storage: null, params: new URLSearchParams(query) });
    const looks: LookCardState[] = [];
    const preview = new SettingsPreview({
      bridge,
      palettes: new PaletteCache(async () => null),
      settings: structuredClone(DEFAULT_SETTINGS),
      onInfo: (info) => {
        if (looks[looks.length - 1] !== info.look) looks.push(info.look);
      },
    });
    live.push({ bridge, preview });
    await bridge.listen("now-playing", (np) => preview.setMainTrack(np));
    await preview.start(await bridge.invoke("get_now_playing"));
    return { bridge, preview, looks, card: (): LookCardState => preview.current.look };
  }

  it("the demo starts on Glass Harbor, a moment into its intro, and loops it with the three look demos", async () => {
    expect(DEMO_TRACKS).toEqual([6, 7, 8, 9]);
    expect(MOCK_TRACKS[DEMO_TRACKS[0] ?? -1]?.title).toBe("Glass Harbor");
    const { preview } = await mountPreview("?track=1&media=no-player");
    expect(preview.current.demo).toBe(true);
    expect(preview.current.track?.title).toBe("Glass Harbor");
    expect(preview.current.track?.positionMs).toBeGreaterThanOrEqual(DEMO_START_MS);
    expect(preview.current.track?.positionMs).toBeLessThan(DEMO_START_MS + 500);
  });

  it("with nothing playing, the card shows the demo song's look once its lyrics are in", async () => {
    const { card, looks } = await mountPreview("?track=1&media=no-player");
    expect(card()).toMatchObject({ kind: "finding", demo: true });
    await vi.advanceTimersByTimeAsync(500);
    const state = card();
    expect(state).toMatchObject({ kind: "look", demo: true, key: keyOf(6) });
    if (state.kind !== "look") throw new Error("no look");
    expect(state.look.style).toBe("arc");
    expect(state.look.font.family).toBe("Fraunces");
    expect(looks.map((l) => l.kind)).toEqual(["finding", "look"]);
  });

  it("follows the song the preview plays: finding, then the look; no lyrics; instrumental", async () => {
    const { bridge, card } = await mountPreview("?track=8&t=1000");
    expect(card()).toMatchObject({ kind: "finding", demo: false, key: keyOf(8) });
    await vi.advanceTimersByTimeAsync(500);
    const strobe = card();
    if (strobe.kind !== "look") throw new Error(`no look: ${strobe.kind}`);
    expect(`${strobe.look.style} ${strobe.look.font.family}`).toBe("poster Unbounded");
    bridge.player.select(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(card().kind).toBe("finding");
    await vi.advanceTimersByTimeAsync(1000);
    expect(card()).toMatchObject({ kind: "no-lyrics", demo: false });
    bridge.player.select(4);
    await vi.advanceTimersByTimeAsync(500);
    expect(card()).toMatchObject({ kind: "instrumental", demo: false });
  });

  it("asks for the lyrics of a song already playing (their event went by before it listened)", async () => {
    vi.useFakeTimers({ now: 1_760_000_000_000 });
    const bridge = createMockBridge({ shared: false, keys: false, storage: null, params: new URLSearchParams("?track=7") });
    await vi.advanceTimersByTimeAsync(1000);
    const preview = new SettingsPreview({ bridge, palettes: new PaletteCache(async () => null), settings: structuredClone(DEFAULT_SETTINGS) });
    live.push({ bridge, preview });
    await preview.start(await bridge.invoke("get_now_playing"));
    await vi.advanceTimersByTimeAsync(10);
    const state = preview.current.look;
    if (state.kind !== "look") throw new Error(`no look: ${state.kind}`);
    expect(`${state.look.style} ${state.look.font.family}`).toBe("stack Bricolage Grotesque");
  });

  it("once the preview's controller reports its look (onLook), the card shows only reported looks", async () => {
    const { preview, card } = await mountPreview("?track=8&t=1000");
    await vi.advanceTimersByTimeAsync(500);
    expect(card().kind).toBe("look");
    // what the stage draws with wins over the card's own pick, and agrees with the preview from then on
    preview.reportLook(DRIFT_SERIF);
    expect(card()).toMatchObject({ kind: "look", look: DRIFT_SERIF });
    // a look picked before any lyrics is no pick: the card waits
    preview.reportLook(PROVISIONAL);
    expect(card().kind).toBe("finding");
    preview.reportLook(null);
    expect(card().kind).toBe("finding");
    preview.reportLook(LENS_SYNE);
    expect(card()).toMatchObject({ kind: "look", look: LENS_SYNE });
  });

  it("a reported look counts only for the song it was reported with", async () => {
    const { bridge, preview, card } = await mountPreview("?track=8&t=1000");
    await vi.advanceTimersByTimeAsync(500);
    preview.reportLook(LENS_SYNE);
    bridge.player.select(9);
    await vi.advanceTimersByTimeAsync(600);
    // Glacier Nocturne's lyrics are in, but its look hasn't been reported: no stale Strobe Hearts look
    expect(card()).toMatchObject({ kind: "finding", key: keyOf(9) });
    preview.reportLook(DRIFT_SERIF);
    expect(card()).toMatchObject({ kind: "look", look: DRIFT_SERIF });
  });
});
