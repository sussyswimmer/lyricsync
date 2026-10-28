import {
  DEFAULT_SETTINGS,
  type MediaStatus,
  type Settings,
  type ShortcutAction,
  type Shortcuts,
  type ShortcutsStatus,
  type Source,
} from "../../contract/contract";
import { detectPlatform, displayAccelerator, SHORTCUT_ACTIONS, type KeyLayout, type Platform } from "../core/accelerator";
import type { Palette } from "../core/palette";
import { hasOwnOffset, learnedOffsetMs, songOffsetMs } from "../core/sync";
import { STYLES, styleLabel } from "../core/songlook";
import { h } from "../overlay/dom";
import { group, hint, icon, nextId, radios, setAttr, setText, slider, toggle } from "./controls";
import { LookCard, styleGlyph, type LookCardState } from "./look-card";
import { currentLayout, ShortcutRecorder } from "./recorder";
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
  /** why nothing plays, as the core reports it (contract v2); null from an older core */
  media: MediaStatus | null;
  /** whether each global shortcut works (contract v3); null from an older core */
  shortcuts: ShortcutsStatus | null;
  /** the last Launch at login change failed (the OS refused the login item) */
  loginError: boolean;
  /** what the "Picked for this song" card shows: the look Undertone picked for the preview's song */
  look: LookCardState;
}

/** What the panel asks for. */
export interface PanelActions {
  /** a change saved debounced; nested objects (colors, font, shortcuts) always whole */
  edit(patch: Partial<Settings>): void;
  /** a switch with a side effect (Launch at login), saved at once on its own */
  editNow(patch: Partial<Settings>): void;
  /** `null` drops the song's own offset: it follows the learned one again */
  setTrackOffset(trackKey: string, ms: number | null): void;
  reset(forgetSongs: boolean): void;
  /** true while a shortcut row listens for keys, so the current global shortcuts don't take them */
  suspendShortcuts(suspended: boolean): void;
}

export interface PanelOptions {
  /** how shortcuts are written (⌥⇧⌘L or Ctrl+Alt+Shift+L) and the menu is named. Default: detected. */
  platform?: Platform;
  /** the keyboard layout, read on Windows as the window opens, as it comes to the front and as a shortcut row starts listening. Default: the engine's own. */
  keyLayout?: () => Promise<KeyLayout | null>;
  /** the third-party notices Licenses shows. Default: THIRD_PARTY_NOTICES.txt, loaded on first open. */
  licenses?: () => Promise<string>;
  /** whether the system asks for less motion, and when that changes. Default: `prefers-reduced-motion`. */
  reducedMotion?: MotionQuery | null;
}

/** The part of a MediaQueryList the panel reads. */
export interface MotionQuery {
  readonly matches: boolean;
  addEventListener?(type: "change", listener: () => void): void;
}

/** THIRD_PARTY_NOTICES.txt (scripts/notices.mjs), in its own chunk: most sessions never open it. */
const loadNotices = (): Promise<string> => import("../../THIRD_PARTY_NOTICES.txt?raw").then((m) => m.default);

type ColorKey = keyof Settings["colors"];

const COLORS: readonly { key: ColorKey; label: string; spoken: string }[] = [
  { key: "lyric", label: "Lyric", spoken: "Lyric color" },
  { key: "highlight", label: "Highlight", spoken: "Highlight color, for sung words" },
  { key: "dim", label: "Other lines", spoken: "Color of the other lines" },
];

const NUDGES = [-100, -50, 50, 100] as const;

/** The shortcut rows: the label beside the key button, and the name a clash message uses. */
const SHORTCUT_ROWS: Readonly<Record<ShortcutAction, { label: string; name: string }>> = {
  toggleLyrics: { label: "Show or hide lyrics", name: "Show or hide lyrics" },
  nudgeEarlier: { label: "Nudge earlier (+50 ms)", name: "Nudge earlier" },
  nudgeLater: { label: "Nudge later (−50 ms)", name: "Nudge later" },
};
const SHORTCUT_NAMES = Object.fromEntries(SHORTCUT_ACTIONS.map((a) => [a, SHORTCUT_ROWS[a].name])) as Record<ShortcutAction, string>;

/** Where the app's own menu lives. */
function menuPlace(platform: Platform): string {
  if (platform === "mac") return "the menu bar";
  if (platform === "windows") return "the tray icon";
  return "the Undertone menu";
}

/** The player as its own switch is labeled under Automation in System Settings. */
function playerName(source: Source | null): string {
  if (source === "spotify") return "Spotify";
  if (source === "apple-music") return "Music";
  return "your music app";
}

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
 * The word for an Effects level, as the slider speaks it and the tray's Effects ▸ checks it: Calm up
 * to 33, Balanced from 34 to 66, Lively from 67.
 */
export function effectsWord(level: number): "Calm" | "Balanced" | "Lively" {
  if (level < 33.5) return "Calm";
  return level < 66.5 ? "Balanced" : "Lively";
}

export const EFFECTS_HINT = "How much words rise, swell and ripple as they're sung.";
export const STYLE_AUTO = "Undertone picks a style for each song, from how it's sung and its cover.";
const STYLE_CHOSEN = (name: string): string => `Every song in ${name}. The font, the curve and the motion are still picked for each song.`;
export const EFFECTS_MODE_ON = "Each song's words move their own way: they bounce, sway, pulse or drop.";
export const EFFECTS_MODE_OFF = "Off: every word rises the same way.";
export const GRAPHICS_ON = "Words like “rain” or “rocket” come to life in the line, and big moments splash.";
export const GRAPHICS_OFF = "Off: just the words, no pictures or splashes.";
export const REDUCED_MOTION_NOTE = "Your system asks for less motion: words fade instead of moving.";
export const GLOW_HINT = "How much the sung word glows. 0 keeps a faint glow.";

/**
 * The settings form. Builds every control once, then `render` moves them to a state; user input goes
 * straight out through `actions` and comes back as the next state.
 */
export class SettingsPanel {
  readonly el: HTMLElement;
  private readonly actions: PanelActions;
  private readonly platform: Platform;
  private readonly keyLayout: (() => Promise<KeyLayout | null>) | undefined;
  private readonly loadLicenses: () => Promise<string>;
  private licenses: HTMLDialogElement | null = null;
  private state: PanelState | null = null;
  private readonly renderers: ((state: PanelState) => void)[] = [];
  private readonly status: HTMLElement;
  private recorders: ShortcutRecorder[] = [];
  /** Counts keyboard layout reads, so only the latest one lands. */
  private layoutReads = 0;
  private readonly card = new LookCard();
  private readonly motionQuery: MotionQuery | null;

  constructor(actions: PanelActions, options: PanelOptions = {}) {
    this.actions = actions;
    this.platform = options.platform ?? detectPlatform(typeof navigator === "undefined" ? undefined : navigator);
    this.keyLayout = options.keyLayout;
    this.loadLicenses = options.licenses ?? loadNotices;
    this.motionQuery =
      options.reducedMotion !== undefined ? options.reducedMotion : typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    // The Effects hint says when the system asks for less motion, as soon as that changes.
    this.motionQuery?.addEventListener?.("change", () => {
      if (this.state) this.render(this.state);
    });
    this.el = h("div", "panel");
    this.status = h("p", "sr-only");
    this.status.setAttribute("role", "status");
    this.renderers.push((s) => this.card.render(s.look));
    this.el.append(
      this.mediaNotice(),
      this.card.el,
      this.generalGroup(),
      this.colorGroup(),
      this.lookGroup(),
      this.behaviorGroup(),
      this.syncGroup(),
      this.shortcutsGroup(),
      this.resetGroup(),
      this.footer(),
      this.status,
    );
    this.refreshKeyLayout();
  }

  render(state: PanelState): void {
    this.state = state;
    for (const render of this.renderers) render(state);
  }

  /** Stops a shortcut row that is listening for keys (the window lost focus or is closing). */
  cancelRecording(): void {
    for (const recorder of this.recorders) recorder.cancel();
  }

  /**
   * Reads the keyboard layout again (Windows only: a Mac registers by key position, and WKWebView
   * can't say anyway), so each shortcut row can warn when its saved key may sit elsewhere on it.
   * Read as the window opens and each time it comes back to the front, since the user may have
   * switched layouts meanwhile.
   */
  refreshKeyLayout(): void {
    if (this.platform !== "windows") return;
    const read = ++this.layoutReads;
    (this.keyLayout ?? currentLayout)().then(
      (layout) => {
        if (read !== this.layoutReads) return;
        for (const recorder of this.recorders) recorder.setLayout(layout);
      },
      () => undefined,
    );
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

  // ---------- media notice ----------

  /**
   * Why the window can't see the song, when the core knows: macOS Automation is off for the player.
   * The live region stays in place and only its card shows and hides, so it is announced as it appears.
   */
  private mediaNotice(): HTMLElement {
    const el = h("div", "notice");
    el.setAttribute("role", "status");
    const card = h("div", "notice-card");
    card.hidden = true;
    const lock = icon(
      [
        ["M4.5 7.25 H11.5 A1.25 1.25 0 0 1 12.75 8.5 V12.75 A1.25 1.25 0 0 1 11.5 14 H4.5 A1.25 1.25 0 0 1 3.25 12.75 V8.5 A1.25 1.25 0 0 1 4.5 7.25 Z", 1.4, 1],
        ["M5.5 7.25 V5.25 A2.5 2.5 0 0 1 10.5 5.25 V7.25", 1.4, 1],
      ],
      "0 0 16 16",
    );
    const titleName = h("span");
    const title = h("p", "notice-title");
    title.append(h("span", "", "Undertone can't see what "), titleName, h("span", "", " is playing."));
    const fixName = h("span", "notice-path");
    const fix = h("p", "notice-fix");
    fix.append(
      h("span", "", "Open "),
      h("span", "notice-path", "System Settings › Privacy & Security › Automation › Undertone"),
      h("span", "", ", then turn on "),
      fixName,
      h("span", "", "."),
    );
    const text = h("div", "notice-text");
    text.append(title, fix);
    card.append(lock, text);
    el.append(card);
    this.renderers.push(({ media }) => {
      const denied = media?.problem === "automation-denied";
      if (card.hidden === denied) card.hidden = !denied;
      if (!denied) return;
      const name = playerName(media.source);
      setText(titleName, name);
      setText(fixName, name);
    });
    return el;
  }

  // ---------- general ----------

  private generalGroup(): HTMLElement {
    const enabledCaptionId = nextId("enabled-caption");
    const enabled = toggle({
      label: "Lyrics on the desktop",
      describedBy: enabledCaptionId,
      onChange: (on) => this.actions.edit({ enabled: on }),
    });
    const enabledCaption = hint("", "toggle-hint");
    enabledCaption.id = enabledCaptionId;

    const loginNoteId = nextId("login-note");
    const login = toggle({
      label: "Launch at login",
      describedBy: loginNoteId,
      onChange: (on) => this.actions.editNow({ launchAtLogin: on }),
    });
    // Empty unless the OS refused the change; a status region, so the refusal is announced.
    const loginNote = hint("", "toggle-hint login-note");
    loginNote.id = loginNoteId;
    loginNote.setAttribute("role", "status");

    const { el } = group("General", enabled.el, enabledCaption, login.el, loginNote);
    this.renderers.push((s) => {
      const on = s.settings.enabled;
      enabled.set(on);
      setText(enabledCaption, on ? "Shown on your desktop, under your windows." : this.offCaption(s));
      login.set(s.settings.launchAtLogin);
      // The Mac pane is "Login Items & Extensions" since macOS 15 and "Login Items" on 14: this reads right on both.
      const where =
        this.platform === "mac"
          ? " Try again, or check Login Items in System Settings › General."
          : this.platform === "windows"
            ? " Try again, or check Settings › Apps › Startup."
            : " Try again.";
      setText(loginNote, s.loginError ? `Couldn't change Undertone's login item.${where}` : "");
    });
    return el;
  }

  /** Where the lyrics can be turned back on: here, the menu, and the toggle shortcut when it works. */
  private offCaption(s: PanelState): string {
    const { shortcuts } = s.settings;
    const state = s.shortcuts?.toggleLyrics;
    const works = shortcuts.enabled && shortcuts.toggleLyrics !== "" && state !== "unavailable" && state !== "invalid";
    const key = works ? displayAccelerator(shortcuts.toggleLyrics, this.platform) : "";
    const menu = menuPlace(this.platform);
    return key
      ? `Hidden on the desktop. Turn them back on here, from ${menu}, or with ${key}.`
      : `Hidden on the desktop. Turn them back on here or from ${menu}.`;
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

  // ---------- look ----------

  /**
   * How the picked look sits on this desktop: Style (Auto, or one style for every song), Text effects,
   * Graphics, Size, Effects, Glow and Opacity. Undertone picks the style and the face for each song
   * (the card under the preview says which) unless Style fixes one, with Text effects its own motion
   * and with Graphics its word pictures and splashes; these scale it. The lyrics always sit in the
   * middle of the screen, so there is no height to set.
   */
  private lookGroup(): HTMLElement {
    const edit = (patch: Partial<Settings>): void => this.actions.edit(patch);
    const styleHintId = nextId("style-hint");
    const style = radios<Settings["style"]>({
      name: "style",
      label: "Style",
      options: [{ value: "auto", label: "Auto", description: "Auto: the style picked for each song" }, ...STYLES.map((s) => ({ value: s, label: styleLabel(s), art: icon(styleGlyph(s)) }))],
      className: "chips",
      onChange: (v) => edit({ style: v }),
    });
    style.el.setAttribute("aria-describedby", styleHintId);
    const styleRow = h("div", "row chips-row");
    styleRow.append(h("span", "row-label", "Style"), style.el);
    const styleHint = hint("", "chips-hint");
    styleHint.id = styleHintId;
    const modeCaptionId = nextId("effects-mode-caption");
    const mode = toggle({
      label: "Text effects",
      describedBy: modeCaptionId,
      onChange: (on) => this.actions.edit({ effectsMode: on }),
    });
    const modeCaption = hint("", "toggle-hint");
    modeCaption.id = modeCaptionId;
    const graphicsCaptionId = nextId("graphics-caption");
    const graphics = toggle({
      label: "Graphics",
      describedBy: graphicsCaptionId,
      onChange: (on) => this.actions.edit({ graphics: on }),
    });
    const graphicsCaption = hint("", "toggle-hint");
    graphicsCaption.id = graphicsCaptionId;
    const size = slider({ label: "Size", min: 22, max: 140, format: String, speak: (v) => `${v} pixels`, onInput: (v) => edit({ size: v }) });
    const effectsHintId = nextId("effects-hint");
    const effects = slider({
      label: "Effects",
      min: 0,
      max: 100,
      format: String,
      speak: (v) => `${effectsWord(v)}, ${v}`,
      onInput: (v) => edit({ effects: v }),
      describedBy: effectsHintId,
      className: "slider-ends",
    });
    const ends = h("div", "scale");
    ends.setAttribute("aria-hidden", "true");
    ends.append(h("span", "", "Calm"), h("span", "", "Lively"));
    effects.el.append(ends);
    const effectsHint = hint(EFFECTS_HINT);
    effectsHint.id = effectsHintId;
    const glowHintId = nextId("glow-hint");
    const glow = slider({ label: "Glow", min: 0, max: 100, format: String, onInput: (v) => edit({ glow: v }), describedBy: glowHintId });
    const glowHint = hint(GLOW_HINT);
    glowHint.id = glowHintId;
    const opacity = slider({ label: "Opacity", min: 20, max: 100, format: (v) => `${v}%`, onInput: (v) => edit({ opacity: v }) });
    const { el } = group("Look", styleRow, styleHint, mode.el, modeCaption, graphics.el, graphicsCaption, size.el, effects.el, effectsHint, glow.el, glowHint, opacity.el);
    this.renderers.push(({ settings: s }) => {
      // Settings without `style` (a core older than contract v9) pick per song
      const chosen = typeof s.style === "string" && s.style !== "auto" && (STYLES as readonly string[]).includes(s.style) ? s.style : "auto";
      style.set(chosen);
      setText(styleHint, chosen === "auto" ? STYLE_AUTO : STYLE_CHOSEN(styleLabel(chosen)));
      // Settings without `effectsMode` (a core older than contract v5) have it on; without `graphics`
      // (older than v8), Effects mode turned the pictures and splashes on and off too.
      const on = s.effectsMode !== false;
      mode.set(on);
      setText(modeCaption, on ? EFFECTS_MODE_ON : EFFECTS_MODE_OFF);
      const pictures = typeof s.graphics === "boolean" ? s.graphics : on;
      graphics.set(pictures);
      setText(graphicsCaption, pictures ? GRAPHICS_ON : GRAPHICS_OFF);
      size.set(s.size);
      // Settings without `effects` (a core older than contract v4) show the level as picked.
      effects.set(s.effects ?? DEFAULT_SETTINGS.effects);
      setText(effectsHint, this.motionQuery?.matches ? `${EFFECTS_HINT} ${REDUCED_MOTION_NOTE}` : EFFECTS_HINT);
      glow.set(s.glow);
      opacity.set(s.opacity);
    });
    return el;
  }

  // ---------- behavior ----------

  private behaviorGroup(): HTMLElement {
    // The visible word is terse ("When"); the group keeps its spoken name ("When to show lyrics").
    const row = (label: string, control: HTMLElement): HTMLElement => {
      const el = h("div", "row choice");
      const name = h("span", "row-label", label);
      name.setAttribute("aria-hidden", "true");
      el.append(name, control);
      return el;
    };
    const showWhen = radios<Settings["showWhen"]>({
      name: "showWhen",
      label: "When to show lyrics",
      options: [
        { value: "playing", label: "While playing" },
        { value: "always", label: "Always" },
      ],
      className: "seg",
      onChange: (v) => this.actions.edit({ showWhen: v }),
    });
    const displays = radios<Settings["displays"]>({
      name: "displays",
      label: "Where to show lyrics",
      options: [
        { value: "primary", label: "Primary display" },
        { value: "all", label: "All displays" },
      ],
      className: "seg",
      onChange: (v) => this.actions.edit({ displays: v }),
    });
    const { el } = group("Behavior", row("When", showWhen.el), row("Where", displays.el));
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

    /** This song, its offset (its own, or the learned one) and whether it has its own; null when nothing is playing. */
    const current = (): { key: string; ms: number; own: boolean } | null => {
      const state = this.state;
      if (!state?.track) return null;
      const key = state.track.key;
      return { key, ms: songOffsetMs(state.settings, key), own: hasOwnOffset(state.settings, key) };
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
      if (!now || !now.own || inert(resetSong)) return;
      this.actions.setTrackOffset(now.key, null);
      const learned = this.state ? learnedOffsetMs(this.state.settings) : 0;
      this.announce(learned === 0 ? "This song's sync is back to 0" : `This song follows your recent nudges again: ${speakMs(learned)}`);
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
      const ms = track ? songOffsetMs(s.settings, track.key) : 0;
      const own = track ? hasOwnOffset(s.settings, track.key) : false;
      const learned = learnedOffsetMs(s.settings);
      song.classList.toggle("is-disabled", !track);
      setText(songValue, track ? (own || learned === 0 ? formatMs(ms) : `${formatMs(ms)} · learned`) : "");
      // The held song rides out a brief gap, so this only changes once the gap outlasts it.
      const idle = s.media?.problem === "no-player" ? "No music app open" : "Nothing playing";
      setText(songTitle, track ? `${track.title} · ${track.artist}` : idle);
      songTitle.title = track ? `${track.title} by ${track.artist}` : "";
      setText(
        songHint,
        !track
          ? "Play a song to fine-tune its sync."
          : own || learned === 0
            ? "Added on top of All songs. New songs start from what your last few nudges agree on."
            : "Learned from the songs you nudged last. Nudge to give this song its own.",
      );
      for (const [i, b] of buttons.entries()) {
        const delta = NUDGES[i] ?? 0;
        // Inert only when a press would change nothing; a step past the limit is clamped to it.
        const atLimit = delta > 0 ? ms >= TRACK_OFFSET_LIMIT_MS : ms <= -TRACK_OFFSET_LIMIT_MS;
        setAttr(b, "aria-disabled", !track || atLimit ? "true" : null);
        setAttr(b, "title", track && atLimit ? `This song is at the ${formatMs(delta > 0 ? TRACK_OFFSET_LIMIT_MS : -TRACK_OFFSET_LIMIT_MS)} limit` : null);
      }
      setAttr(resetSong, "aria-disabled", !track || !own ? "true" : null);
    });
    return el;
  }

  // ---------- shortcuts ----------

  private shortcutsGroup(): HTMLElement {
    const captionId = nextId("shortcuts-caption");
    const master = toggle({
      label: "Keyboard shortcuts",
      describedBy: captionId,
      onChange: (on) => this.editShortcuts({ enabled: on }),
    });
    const caption = hint("", "toggle-hint");
    caption.id = captionId;

    const rows = h("div", "sc-rows");
    // What to press while a row listens, on the foot's line beside Reset shortcuts: a line under the
    // row would push every row below it down, away from the pointer.
    const listenHint = h("p", "sc-hint");
    listenHint.setAttribute("aria-live", "polite");
    this.recorders = SHORTCUT_ACTIONS.map(
      (action) =>
        new ShortcutRecorder({
          action,
          label: SHORTCUT_ROWS[action].label,
          platform: this.platform,
          names: SHORTCUT_NAMES,
          shortcuts: () => this.state?.settings.shortcuts ?? null,
          onRecording: (recording) => {
            // One row listens at a time (focus moving on already cancels the other).
            if (recording) for (const other of this.recorders) if (other.action !== action) other.cancel();
            this.actions.suspendShortcuts(recording);
            setText(listenHint, this.recorders.some((r) => r.recording) ? "Esc cancels, Delete clears" : "");
          },
          onSave: (binding) => this.editShortcuts({ [action]: binding }),
          announce: (text) => this.announce(text),
          keyLayout: this.keyLayout,
        }),
    );
    const resetKeys = h("button", "link-btn", "Reset shortcuts");
    resetKeys.type = "button";
    // Inert, not disabled, at the defaults: keyboard focus stays on it after a reset.
    resetKeys.addEventListener("click", () => {
      if (resetKeys.getAttribute("aria-disabled") === "true") return;
      const d = DEFAULT_SETTINGS.shortcuts;
      this.editShortcuts({ toggleLyrics: d.toggleLyrics, nudgeEarlier: d.nudgeEarlier, nudgeLater: d.nudgeLater });
      this.announce("Shortcuts are back to their defaults");
    });
    const foot = h("div", "sc-foot");
    foot.append(listenHint, resetKeys);
    rows.append(...this.recorders.map((r) => r.el), foot);

    const { el } = group("Shortcuts", master.el, caption, rows);
    this.renderers.push((s) => {
      const keys = s.settings.shortcuts;
      master.set(keys.enabled);
      setText(caption, keys.enabled ? "They work from any app, even with Settings closed." : "Off. Other apps can use these keys.");
      // Off: the rows stay readable but can't be reached or pressed.
      rows.classList.toggle("is-disabled", !keys.enabled);
      setAttr(rows, "inert", keys.enabled ? null : "");
      for (const recorder of this.recorders) {
        if (!keys.enabled) recorder.cancel();
        recorder.set(keys[recorder.action], s.shortcuts?.[recorder.action] ?? null);
      }
      const atDefaults = SHORTCUT_ACTIONS.every((a) => keys[a] === DEFAULT_SETTINGS.shortcuts[a]);
      setAttr(resetKeys, "aria-disabled", atDefaults ? "true" : null);
    });
    return el;
  }

  /** Shortcut changes go out as the whole object, like colors and font. */
  private editShortcuts(patch: Partial<Shortcuts>): void {
    const current = this.state?.settings.shortcuts ?? DEFAULT_SETTINGS.shortcuts;
    this.actions.edit({ shortcuts: { ...current, ...patch } });
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
    const body = hint(
      "Effects, colors, layout, behavior, sync for all songs and shortcuts go back to how Undertone started. Lyrics on the desktop and Launch at login stay as they are.",
    );
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
      const songs = Object.keys(s.settings.trackOffsetsMs).length;
      forgetRow.hidden = songs === 0;
      setText(forgetText, `Also clear sync for ${songs} ${songs === 1 ? "song" : "songs"}`);
      if (songs === 0) forget.checked = false;
    });
    return el;
  }

  private footer(): HTMLElement {
    const el = h("footer", "foot");
    const licenses = h("button", "link-btn foot-link", "Licenses");
    licenses.type = "button";
    licenses.addEventListener("click", () => this.showLicenses(licenses));
    // the version and the commit, as the tray's last line says them: an old build still running shows here
    const build = h("span", "foot-item", `${__UNDERTONE_VERSION__} (${__UNDERTONE_BUILD__})`);
    build.title = `Build ${__UNDERTONE_BUILD__}`;
    el.append(h("span", "foot-brand", "Undertone"), build, h("span", "foot-item", "Lyrics from LRCLIB"), licenses);
    return el;
  }

  /**
   * The fonts' and libraries' notices, which their licenses ask every copy to carry: a modal dialog
   * over the window (Esc or Close returns to the Licenses button). The text loads on first open.
   */
  private showLicenses(opener: HTMLElement): void {
    let dialog = this.licenses;
    if (!dialog) {
      const box = h("dialog", "licenses");
      const titleId = nextId("licenses-title");
      box.setAttribute("aria-labelledby", titleId);
      const head = h("div", "licenses-head");
      const title = h("h2", "licenses-title", "Licenses");
      title.id = titleId;
      const close = h("button", "btn", "Close");
      close.type = "button";
      close.addEventListener("click", () => box.close());
      head.append(title, close);
      const text = h("pre", "licenses-text", "Loading…");
      // A scrolling region the keyboard can reach and scroll.
      text.tabIndex = 0;
      text.setAttribute("aria-label", "License texts");
      box.append(head, hint("Undertone includes these fonts and libraries, each under the license shown with it."), text);
      box.addEventListener("close", () => opener.focus());
      this.loadLicenses().then(
        (notices) => setText(text, notices),
        () => setText(text, "The license texts couldn't be loaded. They're also in THIRD_PARTY_NOTICES.txt, next to the app."),
      );
      this.el.append(box);
      this.licenses = dialog = box;
    }
    if (!dialog.open) dialog.showModal();
  }
}
