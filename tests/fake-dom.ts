import { vi } from "vitest";

/*
 * A DOM just big enough for the settings window's panel, recorder and preview bar, in node. Shared by
 * the settings suites; not a test file itself.
 */

let active: FakeElement | null = null;
const frames: (() => void)[] = [];

/** The event object a listener gets: what was set on it, plus preventDefault. */
export type FakeEvent = Record<string, unknown> & { type: string; target: FakeElement; defaultPrevented: boolean; preventDefault(): void };
type Listener = (e: FakeEvent) => void;

export class FakeElement {
  readonly tagName: string;
  className = "";
  id = "";
  type = "";
  name = "";
  value = "";
  min = "";
  max = "";
  step = "";
  title = "";
  hidden = false;
  checked = false;
  disabled = false;
  /** a label's `for` (a string), or an output's token list */
  htmlFor: unknown = { add: (): void => undefined };
  readonly dataset: Record<string, string> = {};
  readonly style = { setProperty: (): void => undefined, removeProperty: (): void => undefined } as Record<string, unknown>;
  readonly attrs = new Map<string, string>();
  readonly children: FakeElement[] = [];
  private readonly listeners = new Map<string, Listener[]>();
  private text = "";
  /** how many times textContent was assigned */
  textWrites = 0;

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    this.textWrites++;
    this.children.length = 0;
    this.text = value;
  }
  get lastElementChild(): FakeElement | null {
    return this.children[this.children.length - 1] ?? null;
  }
  readonly classList = {
    add: (...names: string[]): void => {
      const set = new Set(this.className.split(" ").filter(Boolean));
      for (const n of names) set.add(n);
      this.className = [...set].join(" ");
    },
    remove: (...names: string[]): void => {
      this.className = this.className
        .split(" ")
        .filter((c) => c && !names.includes(c))
        .join(" ");
    },
    toggle: (name: string, force?: boolean): boolean => {
      const on = force ?? !this.classList.contains(name);
      if (on) this.classList.add(name);
      else this.classList.remove(name);
      return on;
    },
    contains: (name: string): boolean => this.className.split(" ").includes(name),
  };
  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  /** Runs this element's listeners for `type` with an event carrying `init`; returns the event. */
  dispatch(type: string, init: Record<string, unknown> = {}): FakeEvent {
    const event: FakeEvent = {
      ...init,
      type,
      target: this,
      defaultPrevented: false,
      preventDefault(): void {
        event.defaultPrevented = true;
      },
    };
    for (const fn of this.listeners.get(type) ?? []) fn(event);
    return event;
  }
  /**
   * What a keyboard press or a click does. A `disabled` button gets no click (and the browser drops its
   * focus); an aria-disabled one still gets it. A pointer click counts from 1 (`detail`), a keyboard
   * one is 0.
   */
  click(init: { detail?: number } = { detail: 1 }): void {
    if (this.disabled) return;
    this.dispatch("click", { detail: 1, ...init });
  }
  /** Moving focus blurs the element that had it, as in a browser. */
  focus(): void {
    if (active === this) return;
    const before = active;
    active = this;
    before?.dispatch("blur");
  }
  blur(): void {
    if (active !== this) return;
    active = null;
    this.dispatch("blur");
  }
  /** A key press on this element: keydown with these fields, all modifiers up unless given. */
  key(init: { code: string; key?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }, type = "keydown"): FakeEvent {
    return this.dispatch(type, { key: init.code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init });
  }
  scrollIntoView(): void {}
  /** A canvas without a 2D context: the mock's demo covers are left out, as outside a browser. */
  getContext(): null {
    return null;
  }
  /** Every descendant with this class, in document order. */
  all(className: string): FakeElement[] {
    const out: FakeElement[] = [];
    for (const c of this.children) {
      if (c.classList.contains(className)) out.push(c);
      out.push(...c.all(className));
    }
    return out;
  }
  one(className: string): FakeElement {
    const el = this.all(className)[0];
    if (!el) throw new Error(`no .${className}`);
    return el;
  }
  querySelector(selector: string): FakeElement | null {
    return this.all(selector.replace(/^\./, ""))[0] ?? null;
  }
  /** The first descendant (or this) whose text is exactly `text`. */
  withText(text: string): FakeElement {
    const walk = (el: FakeElement): FakeElement | null => {
      if (el.text === text && el.children.length === 0) return el;
      for (const c of el.children) {
        const found = walk(c);
        if (found) return found;
      }
      return null;
    };
    const found = walk(this);
    if (!found) throw new Error(`no element reading "${text}"`);
    return found;
  }
}

export function stubDom(): void {
  vi.stubGlobal("document", {
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    get activeElement() {
      return active;
    },
  });
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => frames.push(fn));
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
}

/** Forget focus and pending frames between tests. */
export function resetDom(): void {
  active = null;
  frames.length = 0;
}

export function activeElement(): FakeElement | null {
  return active;
}

/** The animation frames requested so far (the panel's announcer writes in one). */
export function pendingFrames(): (() => void)[] {
  return frames;
}

/** Runs the pending animation frames. */
export function runFrames(): void {
  for (const f of frames.splice(0)) f();
}
