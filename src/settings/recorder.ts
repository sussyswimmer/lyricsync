import type { ShortcutAction, ShortcutState, Shortcuts } from "../../contract/contract";
import {
  bindingOwner,
  clashesWithAltGr,
  displayAccelerator,
  displayModifiers,
  heldModifiers,
  isModifierKey,
  loadKeyLayout,
  recordKey,
  reservedUse,
  speakAccelerator,
  type KeyLayout,
  type Modifier,
  type Platform,
} from "../core/accelerator";
import { h } from "../overlay/dom";
import { nextId, setAttr, setText } from "./controls";

/** Listening gives up after this long, before the core's 30 s safety resume brings the old shortcuts back. */
export const RECORD_TIMEOUT_MS = 25_000;
/** How long a note left after listening ends ("Stopped listening") stays. */
export const NOTE_MS = 4000;
/** Left under a Ctrl+Alt shortcut just saved on Windows (`clashesWithAltGr`). */
export const ALTGR_NOTE = "Saved. Ctrl+Alt is AltGr on many keyboards, so this may block a character. Adding Shift helps.";

const currentLayout = (): Promise<KeyLayout | null> => loadKeyLayout(typeof navigator === "undefined" ? undefined : navigator);

export interface RecorderOptions {
  action: ShortcutAction;
  /** the row's visible name, "Show or hide lyrics" */
  label: string;
  platform: Platform;
  /** what each action is called in "already used for …" */
  names: Readonly<Record<ShortcutAction, string>>;
  /** the shortcuts the window shows now, to turn down a combination another action has */
  shortcuts: () => Shortcuts | null;
  /** listening starts (true) or ends (false): the window suspends the global shortcuts meanwhile */
  onRecording: (recording: boolean) => void;
  /** a new binding, canonical, or "" for none */
  onSave: (binding: string) => void;
  /** polite announcement through the window's status region */
  announce: (text: string) => void;
  /** the keyboard layout in use, read as listening starts: Windows registers a letter by what it types */
  keyLayout?: () => Promise<KeyLayout | null>;
}

type Tone = "hint" | "warn" | "error";

/**
 * One shortcut row: its name, a button showing the binding in the platform's notation, and a line for
 * messages. Pressing the button listens for the next combination: modifier(s) plus a key, read the way
 * the platform registers it (`recordKey`: the key's position on a Mac, the letter it types on Windows).
 * Esc cancels, Delete or Backspace clears the shortcut, and leaving the button (Tab, a click elsewhere,
 * the window losing focus) cancels. A combination another action has, or one every app relies on
 * (⌘C), is turned down in place, and listening goes on.
 */
export class ShortcutRecorder {
  readonly el: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly action: ShortcutAction;
  private readonly message: HTMLElement;
  private readonly opts: RecorderOptions;
  private binding = "";
  private state: ShortcutState | null = null;
  private listening = false;
  private note: { text: string; tone: Tone } | null = null;
  private noteTimer: ReturnType<typeof setTimeout> | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private layout: KeyLayout | null = null;
  /**
   * A combination with Space (⌃Space) is saved on its keydown, and a button clicks on Space's keyup:
   * that keyup's activation must not start listening again.
   */
  private spaceUpPending = false;

  constructor(opts: RecorderOptions) {
    this.opts = opts;
    this.action = opts.action;
    this.el = h("div", "row sc-row");
    const label = h("span", "row-label sc-label", opts.label);
    this.button = h("button", "sc-key");
    this.button.type = "button";
    this.button.title = "Click, then press the new shortcut";
    // Always in place, so what it says is announced: "Press keys…", a turned-down combination, a conflict.
    this.message = h("p", "sc-msg");
    this.message.id = nextId("sc-msg");
    this.message.setAttribute("aria-live", "polite");
    this.button.setAttribute("aria-describedby", this.message.id);
    this.el.append(label, this.button, this.message);

    this.button.addEventListener("click", (e) => this.onClick(e));
    this.button.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.button.addEventListener("keyup", (e) => this.onKeyUp(e));
    this.button.addEventListener("blur", () => {
      this.spaceUpPending = false;
      this.cancel();
    });
    this.paint();
  }

  get recording(): boolean {
    return this.listening;
  }

  /** The saved binding and what the core says about it (null from an older core). */
  set(binding: string, state: ShortcutState | null): void {
    if (binding === this.binding && state === this.state) return;
    this.binding = binding;
    this.state = state;
    this.paint();
  }

  /** Starts listening for a new combination. */
  start(): void {
    if (this.listening) return;
    // The held modifiers can be wider than the binding ("Win+Ctrl+Alt+Shift+…"): the button keeps the
    // width it has now, before it says "Press keys…", so the key column and every label stay put.
    const width = this.button.offsetWidth;
    if (width > 0) this.button.style.width = `${width}px`;
    this.listening = true;
    this.setNote(null);
    if (this.opts.platform === "windows") {
      // Read again each time: the user may have switched layouts since.
      (this.opts.keyLayout ?? currentLayout)().then(
        (layout) => {
          this.layout = layout;
        },
        () => undefined,
      );
    }
    // WebKit doesn't focus a clicked button, and the keys must come to this one.
    this.button.focus();
    this.opts.onRecording(true);
    this.timeout = setTimeout(() => this.cancel("Stopped listening. Click to try again."), RECORD_TIMEOUT_MS);
    this.paint();
  }

  /** Stops listening and keeps the binding, optionally leaving a note for a few seconds. */
  cancel(note?: string): void {
    if (!this.listening) return;
    this.stop();
    if (note) this.setNote({ text: note, tone: "hint" }, NOTE_MS);
  }

  dispose(): void {
    this.cancel();
    this.setNote(null);
  }

  private stop(): void {
    this.listening = false;
    this.button.style.width = "";
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = null;
    this.note = null;
    this.opts.onRecording(false);
    this.paint();
  }

  private onClick(e: MouseEvent): void {
    // Enter and Space click with `detail` 0; a pointer counts its clicks from 1.
    const fromKeyboard = e.detail === 0;
    if (this.listening) {
      // Enter or Space while listening is handled (and turned down) as a key; a pointer click stops.
      if (!fromKeyboard) this.cancel();
      return;
    }
    if (fromKeyboard && this.spaceUpPending) {
      this.spaceUpPending = false;
      return;
    }
    this.start();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.listening) return;
    const { platform, action, names } = this.opts;
    if (e.key === "Escape" || e.code === "Escape") {
      e.preventDefault();
      this.cancel();
      this.opts.announce("Shortcut unchanged");
      return;
    }
    if (isModifierKey(e)) {
      e.preventDefault();
      this.paint(heldModifiers(e, platform));
      return;
    }
    const pressed = recordKey(e, platform, this.layout);
    if (pressed.kind === "needs-modifier") {
      if (e.code === "Backspace" || e.code === "Delete") {
        e.preventDefault();
        this.save("");
        return;
      }
      // Plain Tab and Shift+Tab move focus on, and leaving the button cancels.
      if (e.code === "Tab") return;
      e.preventDefault();
      this.setNote({ text: platform === "mac" ? "Hold ⌘, ⌥ or ⌃ with the key." : "Hold Ctrl or Alt with the key.", tone: "error" });
      return;
    }
    e.preventDefault();
    if (pressed.kind === "layout") {
      this.setNote({ text: "That key can't be a shortcut on this keyboard layout. Try a letter, a digit or an F key.", tone: "error" });
      return;
    }
    if (pressed.kind !== "combo") {
      this.setNote({ text: "That key can't be part of a shortcut.", tone: "error" });
      return;
    }
    const shown = displayAccelerator(pressed.accelerator, platform);
    const use = reservedUse(pressed.accelerator, platform);
    if (use) {
      this.setNote({ text: `${shown} ${use}. Choose another combination.`, tone: "error" });
      return;
    }
    const shortcuts = this.opts.shortcuts();
    const owner = shortcuts ? bindingOwner(shortcuts, pressed.accelerator, action) : null;
    if (owner) {
      this.setNote({ text: `${shown} is already used for ${names[owner]}.`, tone: "error" });
      return;
    }
    // Enter clicks on keydown, prevented above; Space clicks on keyup, after listening has ended.
    this.spaceUpPending = e.code === "Space";
    this.save(pressed.accelerator, clashesWithAltGr(pressed.accelerator, platform) ? ALTGR_NOTE : null);
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (this.spaceUpPending && e.code === "Space") {
      e.preventDefault();
      this.spaceUpPending = false;
      return;
    }
    if (this.listening && isModifierKey(e)) this.paint(heldModifiers(e, this.opts.platform));
  }

  private save(binding: string, note: string | null = null): void {
    const changed = binding !== this.binding;
    this.stop();
    if (changed) {
      this.binding = binding;
      this.opts.onSave(binding);
      this.paint();
    }
    if (note) this.setNote({ text: note, tone: "hint" }, NOTE_MS);
    const spoken = speakAccelerator(binding, this.opts.platform);
    this.opts.announce(`${this.opts.label}: ${spoken || "no shortcut"}`);
  }

  private setNote(note: { text: string; tone: Tone } | null, forMs = 0): void {
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.noteTimer = null;
    this.note = note;
    if (note && forMs > 0) {
      this.noteTimer = setTimeout(() => {
        this.noteTimer = null;
        this.note = null;
        this.paint();
      }, forMs);
    }
    this.paint();
  }

  private paint(held: readonly Modifier[] = []): void {
    const { platform, label } = this.opts;
    const shown = displayAccelerator(this.binding, platform) || this.binding;
    const spoken = speakAccelerator(this.binding, platform) || this.binding;
    let text = shown || "None";
    if (this.listening) text = held.length > 0 ? `${displayModifiers(held, platform)}…` : "Press keys…";
    setText(this.button, text);
    setAttr(this.button, "aria-label", this.listening ? `${label}: listening for the new shortcut` : `${label}: ${spoken || "no shortcut"}`);
    this.button.classList.toggle("is-recording", this.listening);
    this.button.classList.toggle("is-none", !this.listening && this.binding === "");

    // The prompt while listening is the panel's (one line that doesn't move the rows); the row keeps
    // its own warning meanwhile, so nothing below it shifts either.
    let message = "";
    let tone: Tone | null = null;
    if (this.note) {
      ({ text: message, tone } = this.note);
    } else if (this.state === "unavailable") {
      message = "Another app is using this combination.";
      tone = "warn";
    } else if (this.state === "invalid") {
      message = "Not a usable combination.";
      tone = "warn";
    }
    setText(this.message, message);
    setAttr(this.message, "data-tone", tone);
    this.button.classList.toggle("is-warning", !this.listening && tone === "warn");
  }
}
