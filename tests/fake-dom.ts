import { vi } from "vitest";

/*
 * Fake DOMs for node, shared by the suites; not a test file itself. First, one just big enough for the
 * settings window's panel, recorder and preview bar.
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

/*
 * Just enough DOM, HTML and SVG, for the stage, its states and every mode to build and paint in node:
 * elements with inline styles and attributes, text half an em wide per character (rows wrap at 88% of
 * the stage width), Web Animations that only record themselves, and counts of what a build costs.
 */

/** The size every stage element reports (clientWidth/Height), and the width rows wrap against. */
export const stageSize = { width: 1280, height: 720 };
/** What an SVG path measures (getTotalLength): about 90% of a 1280 px stage, unless a test sets its own. */
export const svgPath = { length: 1160 };
/** Elements made and layout reads (path and text lengths) so far. */
export const cost = { created: 0, measured: 0 };

class FakeStyle {
  readonly props = new Map<string, string>();
  [key: string]: unknown;
  setProperty(name: string, value: string): void {
    this.props.set(name, value);
  }
  getPropertyValue(name: string): string {
    return this.props.get(name) ?? "";
  }
}

/** Never finishes by itself; cancelling it rejects `finished`, as in a browser. */
export class FakeAnimation {
  readonly keyframes: Keyframe[];
  readonly options: KeyframeAnimationOptions;
  readonly finished: Promise<void>;
  cancelled = false;
  private reject: (e: Error) => void = () => undefined;
  constructor(keyframes: Keyframe[] = [], options: KeyframeAnimationOptions = {}) {
    this.keyframes = keyframes;
    this.options = options;
    this.finished = new Promise<void>((_, reject) => {
      this.reject = reject;
    });
    // code that never awaits a cancelled animation mustn't fail the run
    this.finished.catch(() => undefined);
  }
  cancel(): void {
    this.cancelled = true;
    this.reject(new Error("AbortError"));
  }
}

export class StageElement {
  readonly tagName: string;
  className = "";
  dir = "";
  readonly style = new FakeStyle();
  readonly attrs = new Map<string, string>();
  readonly animations: FakeAnimation[] = [];
  children: StageElement[] = [];
  parent: StageElement | null = null;
  own = "";
  readonly offsetWidth = 0;
  readonly classList = {
    add: (...names: string[]): void => {
      this.className = [...new Set([...this.className.split(" "), ...names])].filter(Boolean).join(" ");
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

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
    cost.created++;
  }

  get textContent(): string {
    return this.own + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.own = value;
  }
  get isConnected(): boolean {
    return this.parent !== null;
  }
  get clientWidth(): number {
    return stageSize.width;
  }
  get clientHeight(): number {
    return stageSize.height;
  }
  /** Rows wrap at 88% of the stage width with glyphs about 0.5 em wide, 1.12 em per row. */
  get offsetHeight(): number {
    const size = this.fontSize();
    const width = this.textContent.length * size * 0.5;
    const rows = Math.max(1, Math.ceil(width / (stageSize.width * 0.88)));
    return Math.round(rows * size * 1.12);
  }
  fontSize(): number {
    for (let el: StageElement | null = this; el; el = el.parent) {
      const v = el.style["fontSize"];
      if (typeof v === "string" && v) return Number.parseFloat(v);
    }
    return 16;
  }
  /** Text half an em wide per character; an <i> (Lens's baseline mark) sits 0.8 em down. */
  getBoundingClientRect(): { width: number; left: number; top: number } {
    const size = this.fontSize();
    return { width: this.textContent.length * size * 0.5, left: 0, top: this.tagName === "I" ? 0.8 * size : 0 };
  }
  getTotalLength(): number {
    cost.measured++;
    return svgPath.length;
  }
  getComputedTextLength(): number {
    cost.measured++;
    return this.textContent.length * Number(this.attrs.get("font-size") ?? "16") * 0.5;
  }
  append(...nodes: StageElement[]): void {
    for (const n of nodes) {
      n.remove();
      n.parent = this;
      this.children.push(n);
    }
  }
  appendChild(node: StageElement): StageElement {
    this.append(node);
    return node;
  }
  after(node: StageElement): void {
    const p = this.parent;
    if (!p) return;
    node.remove();
    node.parent = p;
    p.children.splice(p.children.indexOf(this) + 1, 0, node);
  }
  remove(): void {
    const p = this.parent;
    if (!p) return;
    p.children.splice(p.children.indexOf(this), 1);
    this.parent = null;
  }
  contains(other: StageElement): boolean {
    for (let el: StageElement | null = other; el; el = el.parent) if (el === this) return true;
    return false;
  }
  setAttribute(name: string, value: string): void {
    if (name === "class") this.className = value;
    else this.attrs.set(name, value);
  }
  setAttributeNS(_ns: string, name: string, value: string): void {
    this.setAttribute(name, value);
  }
  toggleAttribute(name: string, force?: boolean): boolean {
    const on = force ?? !this.attrs.has(name);
    if (on) this.attrs.set(name, "");
    else this.attrs.delete(name);
    return on;
  }
  cloneNode(deep = false): StageElement {
    const copy = new StageElement(this.tagName);
    copy.className = this.className;
    copy.dir = this.dir;
    copy.own = this.own;
    for (const [k, v] of Object.entries(this.style)) if (k !== "props") copy.style[k] = v;
    for (const [k, v] of this.style.props) copy.style.props.set(k, v);
    for (const [k, v] of this.attrs) copy.attrs.set(k, v);
    if (deep) copy.append(...this.children.map((c) => c.cloneNode(true)));
    return copy;
  }
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): FakeAnimation {
    const anim = new FakeAnimation(keyframes, options);
    this.animations.push(anim);
    return anim;
  }
  getAnimations(): FakeAnimation[] {
    return this.animations.filter((a) => !a.cancelled);
  }
  /** Every descendant with this class, in document order. */
  find(className: string): StageElement[] {
    return this.children.flatMap((c) => [...(c.classList.contains(className) ? [c] : []), ...c.find(className)]);
  }
}

/** A document that makes StageElements (HTML and SVG alike), plus anything in `extra` (`fonts`, say). */
export function stubStageDom(extra: Record<string, unknown> = {}): void {
  vi.stubGlobal("document", {
    createElement: (tag: string) => new StageElement(tag),
    createElementNS: (_ns: string, tag: string) => new StageElement(tag),
    ...extra,
  });
}

/** A StageElement where the code under test wants an HTMLElement. */
export const asHtml = (el: StageElement): HTMLElement => el as unknown as HTMLElement;
