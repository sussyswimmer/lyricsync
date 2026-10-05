import type { Mode, Settings } from "../../contract/contract";
import type { Palette } from "../core/palette";
import { h } from "../overlay/dom";
import { FONTS, fontFor } from "../overlay/fonts";
import { group, hint, icon, nextId, radios, setAttr, setText, slider, toggle, type Option } from "./controls";
import { clampTrackOffset, TRACK_OFFSET_LIMIT_MS } from "./store";

/** What the panel draws. */
export interface PanelState {
  /** saved settings with unsaved edits on top */
  settings: Settings;
  /** album colors the preview uses, or null without cover art */
  palette: Palette | null;
  /** title of the song those colors came from (null for the demo) */
  paletteFor: string | null;
  /** the current song's colors are still being worked out (its artwork may be on its way) */
  artPending: boolean;
  /** the song playing now, for the per-song sync nudge; null when nothing (real) is playing */
  track: { key: string; title: string; artist: string } | null;
}

/** What the panel asks for. */
export interface PanelActions {
  edit(patch: Partial<Settings>): void;
  setTrackOffset(trackKey: string, ms: number): void;
  reset(forgetSongs: boolean): void;
}

type ColorKey = keyof Settings["colors"];

const MODES: readonly (Option<Mode> & { blurb: string })[] = [
  {
    value: "arc",
    label: "Arc",
    blurb: "The line bends along a curve, with its neighbors above and below.",
    art: icon([
      ["M7 4.6 Q12 1.2 17 4.6", 1.3, 0.45],
      ["M2.5 10.2 Q12 3.4 21.5 10.2", 2.4, 1],
      ["M7 14.6 Q12 11.2 17 14.6", 1.3, 0.45],
    ]),
  },
  {
    value: "lens",
    label: "Lens",
    blurb: "One line at a time; the word being sung swells as if under a lens.",
    art: icon([
      ["M3 8 H5.5", 2.2, 0.5],
      ["M9.5 8 H14.5", 6, 1],
      ["M18.5 8 H21", 2.2, 0.5],
    ]),
  },
  {
    value: "drift",
    label: "Drift",
    blurb: "The song scrolls up line by line, neighbors fading back into depth.",
    art: icon([
      ["M8 2.6 H16", 1.3, 0.4],
      ["M3 8 H21", 2.6, 1],
      ["M8 13.4 H16", 1.3, 0.4],
    ]),
  },
  {
    value: "stack",
    label: "Stack",
    blurb: "The song scrolls up line by line, flat, like a lyrics sheet.",
    art: icon([
      ["M3 2.6 H21", 1.3, 0.4],
      ["M3 8 H21", 2.6, 1],
      ["M3 13.4 H21", 1.3, 0.4],
    ]),
  },
];

const COLORS: readonly { key: ColorKey; label: string; spoken: string }[] = [
  { key: "lyric", label: "Lyric", spoken: "Lyric color" },
  { key: "highlight", label: "Highlight", spoken: "Highlight color, for sung words" },
  { key: "dim", label: "Other lines", spoken: "Color of the other lines" },
];

const NUDGES = [-100, -50, 50, 100] as const;

/** "+120 ms", "−40 ms", "0 ms" (a real minus sign, so the numbers line up). */
export function formatMs(ms: number): string {
  if (ms === 0) return "0 ms";
  return `${ms > 0 ? "+" : "−"}${Math.abs(ms)} ms`;
}

function speakMs(ms: number): string {
  if (ms === 0) return "0 milliseconds, no shift";
  return `${formatMs(ms).replace("−", "minus ")}, lyrics ${ms > 0 ? "earlier" : "later"}`;
}

const signed = (v: number): string => (v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : "0");

/**
 * The settings form. Builds every control once, then `render` moves them to a state; user input goes
 * straight out through `actions` and comes back as the next state.
 */
export class SettingsPanel {
  readonly el: HTMLElement;
  private readonly actions: PanelActions;
  private state: PanelState | null = null;
  private readonly renderers: ((state: PanelState) => void)[] = [];
  private readonly status: HTMLElement;

  constructor(actions: PanelActions) {
    this.actions = actions;
    this.el = h("div", "panel");
    this.status = h("p", "sr-only");
    this.status.setAttribute("role", "status");
    this.el.append(
      this.styleGroup(),
      this.colorGroup(),
      this.fontGroup(),
      this.layoutGroup(),
      this.behaviorGroup(),
      this.syncGroup(),
      this.resetGroup(),
      this.footer(),
      this.status,
    );
  }

  render(state: PanelState): void {
    this.state = state;
    for (const render of this.renderers) render(state);
  }

  /** Polite screen reader announcement. */
  announce(text: string): void {
    this.status.textContent = "";
    // a new text node after clearing makes repeated messages speak again
    requestAnimationFrame(() => (this.status.textContent = text));
  }

  /** The colors the overlay uses right now. */
  private shownColors(state: PanelState): Palette {
    return state.settings.autoColor && state.palette ? state.palette : state.settings.colors;
  }

  // ---------- style ----------

  private styleGroup(): HTMLElement {
    const blurbId = nextId("mode-blurb");
    const modes = radios<Mode>({
      name: "mode",
      label: "Lyric style",
      options: MODES,
      className: "tiles tiles-4 modes",
      onChange: (mode) => this.actions.edit({ mode }),
    });
    modes.el.setAttribute("aria-describedby", blurbId);
    const blurb = hint("", "mode-blurb");
    blurb.id = blurbId;
    const { el, card } = group("Style", modes.el, blurb);
    card.classList.add("card-plain");
    this.renderers.push((s) => {
      modes.set(s.settings.mode);
      setText(blurb, MODES.find((m) => m.value === s.settings.mode)?.blurb ?? "");
    });
    return el;
  }

  // ---------- color ----------

  private colorGroup(): HTMLElement {
    const captionId = nextId("auto-caption");
    const auto = toggle({
      label: "Match album colors",
      describedBy: captionId,
      onChange: (on) => this.actions.edit({ autoColor: on }),
    });
    const caption = hint("", "toggle-hint");
    caption.id = captionId;

    const swatches = h("div", "swatches");
    const items = COLORS.map(({ key, label, spoken }) => {
      const item = h("label", "swatch");
      const chip = h("span", "swatch-chip");
      const input = h("input", "swatch-input");
      input.type = "color";
      input.setAttribute("aria-label", spoken);
      chip.append(input);
      const name = h("span", "swatch-name", label);
      const hex = h("span", "swatch-hex");
      hex.setAttribute("aria-hidden", "true");
      item.append(chip, name, hex);
      swatches.append(item);
      input.addEventListener("input", () => {
        const state = this.state;
        if (!state) return;
        // Editing any color switches to manual colors, starting from the ones on screen.
        this.actions.edit({ autoColor: false, colors: { ...this.shownColors(state), [key]: input.value.toLowerCase() } });
      });
      return { key, item, chip, input, hex };
    });

    const { el, card } = group("Color", auto.el, caption, swatches);
    card.classList.add("card-color");
    this.renderers.push((s) => {
      auto.set(s.settings.autoColor);
      const shown = this.shownColors(s);
      const fromAlbum = s.settings.autoColor && s.palette !== null;
      const captionText = !s.settings.autoColor
        ? "Off. Your colors below are used for every song."
        : fromAlbum && s.paletteFor
          ? `Picked from the cover of “${s.paletteFor}”. Change any color to use your own.`
          : fromAlbum || s.artPending
            ? "Picked from each song's cover art. Change any color to use your own."
            : "This song has no cover art, so your colors below are used.";
      setText(caption, captionText);
      for (const { key, chip, input, hex } of items) {
        const value = shown[key];
        if (input.value.toLowerCase() !== value) input.value = value;
        chip.style.setProperty("--swatch", value);
        setText(hex, value.toUpperCase());
      }
    });
    return el;
  }

  // ---------- font ----------

  private fontGroup(): HTMLElement {
    const options: Option<string>[] = FONTS.map((f) => ({ value: f.family, label: f.label }));
    const fonts = radios<string>({
      name: "font",
      label: "Font",
      options,
      className: "tiles tiles-2 fonts",
      onChange: (family) => {
        const face = fontFor(family);
        this.actions.edit({ font: { family: face.family, weight: face.weight } });
      },
      decorate: (label, option) => {
        const face = fontFor(option.value);
        const sample = label.querySelector<HTMLElement>(".opt-label");
        if (!sample) return;
        sample.style.fontFamily = face.stack;
        sample.style.fontWeight = String(face.weight);
        label.dataset.family = face.family;
      },
    });
    const { el, card } = group("Font", fonts.el);
    card.classList.add("card-plain");
    this.renderers.push((s) => fonts.set(fontFor(s.settings.font.family).family));
    return el;
  }

  // ---------- layout ----------

  private layoutGroup(): HTMLElement {
    const edit = (patch: Partial<Settings>): void => this.actions.edit(patch);
    const size = slider({ label: "Size", min: 22, max: 140, format: String, speak: (v) => `${v} pixels`, onInput: (v) => edit({ size: v }) });
    const curve = slider({
      label: "Curve",
      min: -100,
      max: 100,
      origin: 0,
      format: signed,
      speak: (v) => (v === 0 ? "straight" : `${Math.abs(v)} ${v > 0 ? "arching up" : "sagging down"}`),
      onInput: (v) => edit({ curve: v }),
    });
    const height = slider({
      label: "Height",
      min: 0,
      max: 100,
      format: (v) => `${v}%`,
      speak: (v) => `${v}% down from the top of the screen`,
      onInput: (v) => edit({ yPos: v }),
    });
    const glow = slider({ label: "Glow", min: 0, max: 100, format: String, onInput: (v) => edit({ glow: v }) });
    const opacity = slider({ label: "Opacity", min: 20, max: 100, format: (v) => `${v}%`, onInput: (v) => edit({ opacity: v }) });
    const { el } = group("Layout", size.el, curve.el, height.el, glow.el, opacity.el);
    this.renderers.push(({ settings: s }) => {
      size.set(s.size);
      const arc = s.mode === "arc";
      curve.set(s.curve, arc ? {} : { disabled: true, note: "Arc only" });
      curve.el.title = arc ? "" : "Curve applies to the Arc style";
      height.set(s.yPos);
      glow.set(s.glow);
      opacity.set(s.opacity);
    });
    return el;
  }

  // ---------- behavior ----------

  private behaviorGroup(): HTMLElement {
    const row = (label: string, control: HTMLElement): HTMLElement => {
      const el = h("div", "row choice");
      const name = h("span", "row-label", label);
      name.id = nextId("choice");
      control.setAttribute("aria-labelledby", name.id);
      control.removeAttribute("aria-label");
      el.append(name, control);
      return el;
    };
    const showWhen = radios<Settings["showWhen"]>({
      name: "showWhen",
      label: "Show lyrics",
      options: [
        { value: "playing", label: "While playing" },
        { value: "always", label: "Always" },
      ],
      className: "seg",
      onChange: (v) => this.actions.edit({ showWhen: v }),
    });
    const displays = radios<Settings["displays"]>({
      name: "displays",
      label: "Displays",
      options: [
        { value: "primary", label: "Primary display" },
        { value: "all", label: "All displays" },
      ],
      className: "seg",
      onChange: (v) => this.actions.edit({ displays: v }),
    });
    const { el } = group("Behavior", row("Show lyrics", showWhen.el), row("Show on", displays.el));
    this.renderers.push(({ settings: s }) => {
      showWhen.set(s.showWhen);
      displays.set(s.displays);
    });
    return el;
  }

  // ---------- sync ----------

  private syncGroup(): HTMLElement {
    const explainId = nextId("sync-explain");
    const zero = h("button", "icon-btn");
    zero.type = "button";
    zero.setAttribute("aria-label", "Reset sync for all songs to 0");
    zero.title = "Back to 0";
    zero.append(icon([["M5 8 a6 6 0 1 0 2 -4.5 M5 2.5 V6 H8.5", 1.6, 1]], "0 0 16 16"));
    zero.addEventListener("click", () => {
      this.actions.edit({ globalOffsetMs: 0 });
      offset.input.focus();
    });
    const offset = slider({
      label: "All songs",
      min: -2000,
      max: 2000,
      step: 10,
      origin: 0,
      format: formatMs,
      speak: speakMs,
      onInput: (v) => this.actions.edit({ globalOffsetMs: v }),
      describedBy: explainId,
      trailing: zero,
      className: "slider-wide",
    });
    const scale = h("div", "scale");
    scale.setAttribute("aria-hidden", "true");
    scale.append(h("span", "", "← Later"), h("span", "", "Earlier →"));
    offset.el.append(scale);
    const explain = hint("Lyrics behind the singer? Move toward Earlier. Positive values show lyrics earlier.");
    explain.id = explainId;

    // This song
    const song = h("div", "song");
    const head = h("div", "song-head");
    const songLabel = h("span", "row-label", "This song");
    // Not a live region: it changes with every track change (spoken bare, out of context) and on a nudge,
    // which `announce` already says with context. The stepper group reads it as its description instead.
    const songValue = h("span", "song-value");
    songValue.id = nextId("song-value");
    head.append(songLabel, songValue);
    const songTitle = h("p", "song-title");
    const stepper = h("div", "stepper");
    stepper.setAttribute("role", "group");
    stepper.setAttribute("aria-label", "Nudge this song's sync");
    stepper.setAttribute("aria-describedby", songValue.id);

    /** This song and its offset, or null when nothing is playing. */
    const current = (): { key: string; ms: number } | null => {
      const state = this.state;
      if (!state?.track) return null;
      return { key: state.track.key, ms: state.settings.trackOffsetsMs[state.track.key] ?? 0 };
    };
    // A press that would change nothing (a limit reached, nothing to reset, no song) leaves these buttons
    // inert (aria-disabled), never `disabled`: a disabled button drops keyboard focus, and handing it to
    // another button turned a held Enter on +100 into −100 presses, and a double Enter on "Reset this
    // song" into −100 ms.
    const inert = (b: HTMLButtonElement): boolean => b.getAttribute("aria-disabled") === "true";
    const buttons = NUDGES.map((delta) => {
      const b = h("button", "step", signed(delta));
      b.type = "button";
      b.setAttribute("aria-label", `${signed(delta).replace("−", "minus ")} milliseconds, lyrics ${delta > 0 ? "earlier" : "later"}`);
      b.addEventListener("click", () => {
        const now = current();
        if (!now || inert(b)) return;
        // Clamped as the store clamps it, so the announcement says what is saved.
        const next = clampTrackOffset(now.ms + delta);
        this.actions.setTrackOffset(now.key, next);
        this.announce(`This song: ${speakMs(next)}`);
      });
      stepper.append(b);
      return b;
    });
    const resetSong = h("button", "link-btn", "Reset this song");
    resetSong.type = "button";
    resetSong.addEventListener("click", () => {
      const now = current();
      if (!now || now.ms === 0 || inert(resetSong)) return;
      this.actions.setTrackOffset(now.key, 0);
      this.announce("This song's sync is back to 0");
    });
    const songHint = hint("");
    song.append(head, songTitle, stepper, h("div", "song-foot"));
    song.lastElementChild?.append(songHint, resetSong);

    const { el } = group("Sync", offset.el, explain, song);
    this.renderers.push((s) => {
      const g = s.settings.globalOffsetMs;
      offset.set(g);
      // Disabled (and invisible), never removed: the slider's width must not change under a dragging pointer.
      // Its click hands focus to the slider itself, so going away never strands keyboard focus.
      zero.disabled = g === 0;
      const track = s.track;
      const ms = track ? (s.settings.trackOffsetsMs[track.key] ?? 0) : 0;
      song.classList.toggle("is-disabled", !track);
      setText(songValue, track ? formatMs(ms) : "");
      setText(songTitle, track ? `${track.title} · ${track.artist}` : "Nothing playing");
      songTitle.title = track ? `${track.title} by ${track.artist}` : "";
      setText(songHint, track ? "Added on top of All songs." : "Play a song to fine-tune its sync.");
      for (const [i, b] of buttons.entries()) {
        const delta = NUDGES[i] ?? 0;
        // Inert only when a press would change nothing; a step past the limit is clamped to it.
        const atLimit = delta > 0 ? ms >= TRACK_OFFSET_LIMIT_MS : ms <= -TRACK_OFFSET_LIMIT_MS;
        setAttr(b, "aria-disabled", !track || atLimit ? "true" : null);
        setAttr(b, "title", track && atLimit ? `This song is at the ${formatMs(delta > 0 ? TRACK_OFFSET_LIMIT_MS : -TRACK_OFFSET_LIMIT_MS)} limit` : null);
      }
      setAttr(resetSong, "aria-disabled", !track || ms === 0 ? "true" : null);
    });
    return el;
  }

  // ---------- reset ----------

  private resetGroup(): HTMLElement {
    const el = h("section", "reset");
    el.setAttribute("aria-label", "Reset");
    const open = h("button", "btn btn-quiet", "Reset to defaults…");
    open.type = "button";
    const confirm = h("div", "confirm");
    confirm.hidden = true;
    confirm.setAttribute("role", "group");
    const titleId = nextId("confirm-title");
    confirm.setAttribute("aria-labelledby", titleId);
    const title = h("p", "confirm-title", "Reset all settings?");
    title.id = titleId;
    const body = hint("Style, colors, font, layout, behavior and sync for all songs go back to how Undertone started.");
    const forgetRow = h("label", "check");
    const forget = h("input");
    forget.type = "checkbox";
    const forgetText = h("span");
    forgetRow.append(forget, forgetText);
    const actions = h("div", "confirm-actions");
    const cancel = h("button", "btn", "Cancel");
    cancel.type = "button";
    const go = h("button", "btn btn-danger", "Reset");
    go.type = "button";
    actions.append(cancel, go);
    confirm.append(title, body, forgetRow, actions);
    el.append(open, confirm);

    const close = (focus: boolean): void => {
      confirm.hidden = true;
      open.hidden = false;
      forget.checked = false;
      if (focus) open.focus();
    };
    open.addEventListener("click", () => {
      open.hidden = true;
      confirm.hidden = false;
      cancel.focus();
      confirm.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    });
    cancel.addEventListener("click", () => close(true));
    confirm.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      }
    });
    go.addEventListener("click", () => {
      this.actions.reset(forget.checked && !forgetRow.hidden);
      close(true);
      this.announce("Settings reset to defaults");
    });
    this.renderers.push((s) => {
      const songs = Object.values(s.settings.trackOffsetsMs).filter((ms) => ms !== 0).length;
      forgetRow.hidden = songs === 0;
      setText(forgetText, `Also clear sync for ${songs} ${songs === 1 ? "song" : "songs"}`);
      if (songs === 0) forget.checked = false;
    });
    return el;
  }

  private footer(): HTMLElement {
    const el = h("footer", "foot");
    el.append(h("span", "foot-brand", "Undertone"), h("span", "", "Lyrics from LRCLIB"));
    return el;
  }
}
