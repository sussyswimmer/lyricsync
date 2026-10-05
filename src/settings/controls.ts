import { h } from "../overlay/dom";

let uid = 0;
/** A unique element id for label and description wiring. */
export const nextId = (prefix: string): string => `${prefix}-${++uid}`;

/** A titled group of controls: a small heading over a card. */
export function group(title: string, ...children: HTMLElement[]): { el: HTMLElement; card: HTMLElement } {
  const el = h("section", "group");
  const id = nextId("group");
  const heading = h("h2", "group-title", title);
  heading.id = id;
  el.setAttribute("aria-labelledby", id);
  const card = h("div", "card");
  card.append(...children);
  el.append(heading, card);
  return { el, card };
}

/**
 * Writes text only when it differs. Rewriting the same text still replaces the text node, which churns
 * the accessibility tree and can make a screen reader repeat it.
 */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Sets or removes an attribute, touching the element only when it changes. */
export function setAttr(el: Element, name: string, value: string | null): void {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

export function hint(text: string, className = ""): HTMLParagraphElement {
  return h("p", `hint ${className}`.trim(), text);
}

export interface Option<T extends string> {
  value: T;
  label: string;
  /** extra content before the label (an icon, a font sample) */
  art?: Element;
  /** spoken name when the visible label is terse */
  description?: string;
}

export interface RadioGroup<T extends string> {
  el: HTMLElement;
  set(value: T): void;
  inputs: HTMLInputElement[];
}

/**
 * A set of native radios dressed as a segmented control or a grid of tiles. Native radios bring
 * the keyboard model for free: Tab enters the group, arrow keys move and select.
 */
export function radios<T extends string>(opts: {
  name: string;
  label: string;
  options: readonly Option<T>[];
  className: string;
  onChange: (value: T) => void;
  /** style each option (e.g. its font) */
  decorate?: (label: HTMLLabelElement, option: Option<T>) => void;
}): RadioGroup<T> {
  const el = h("div", opts.className);
  el.setAttribute("role", "radiogroup");
  el.setAttribute("aria-label", opts.label);
  const inputs = opts.options.map((option) => {
    const label = h("label", "opt");
    const input = h("input");
    input.type = "radio";
    input.name = opts.name;
    input.value = option.value;
    if (option.description) input.setAttribute("aria-label", option.description);
    input.addEventListener("change", () => {
      if (input.checked) opts.onChange(option.value);
    });
    const face = h("span", "opt-face");
    if (option.art) face.append(option.art);
    face.append(h("span", "opt-label", option.label));
    label.append(input, face);
    opts.decorate?.(label, option);
    el.append(label);
    return input;
  });
  return {
    el,
    inputs,
    set(value: T): void {
      for (const input of inputs) {
        const on = input.value === value;
        if (input.checked !== on) input.checked = on;
      }
    },
  };
}

export interface Slider {
  el: HTMLElement;
  input: HTMLInputElement;
  set(value: number, options?: { disabled?: boolean; note?: string }): void;
}

/**
 * A labeled range with its value on the right. The filled part of the track runs from `origin`
 * (the minimum by default; 0 for a centered slider like the sync offset) to the thumb.
 */
export function slider(opts: {
  label: string;
  min: number;
  max: number;
  step?: number;
  origin?: number;
  format: (value: number) => string;
  /** spoken value, when the visible one is terse */
  speak?: (value: number) => string;
  onInput: (value: number) => void;
  describedBy?: string;
  /** extra element after the value (a reset button) */
  trailing?: HTMLElement;
  className?: string;
}): Slider {
  const el = h("div", `row slider ${opts.className ?? ""}`.trim());
  const id = nextId("range");
  const label = h("label", "row-label", opts.label);
  label.htmlFor = id;
  const input = h("input", "range");
  input.type = "range";
  input.id = id;
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.step = String(opts.step ?? 1);
  if (opts.describedBy) input.setAttribute("aria-describedby", opts.describedBy);
  const out = h("output", "row-value");
  out.htmlFor.add(id);
  out.setAttribute("aria-hidden", "true");
  const tail = h("div", "row-tail");
  tail.append(out);
  if (opts.trailing) tail.append(opts.trailing);
  el.append(label, input, tail);

  const origin = opts.origin ?? opts.min;
  const fraction = (v: number): number => (v - opts.min) / (opts.max - opts.min);
  const paint = (v: number): void => {
    const a = fraction(Math.min(origin, v));
    const b = fraction(Math.max(origin, v));
    input.style.setProperty("--a", a.toFixed(4));
    input.style.setProperty("--b", b.toFixed(4));
    out.textContent = opts.format(v);
    input.setAttribute("aria-valuetext", (opts.speak ?? opts.format)(v));
  };
  input.addEventListener("input", () => {
    const v = Number(input.value);
    paint(v);
    opts.onInput(v);
  });

  return {
    el,
    input,
    set(value: number, options: { disabled?: boolean; note?: string } = {}): void {
      const disabled = options.disabled ?? false;
      if (input.disabled !== disabled) input.disabled = disabled;
      el.classList.toggle("is-disabled", disabled);
      // Writing the same value back would be a no-op, but skipping it keeps a drag untouched.
      if (input.value !== String(value)) input.value = String(value);
      paint(Number(input.value));
      if (options.note !== undefined) {
        out.textContent = options.note;
        input.setAttribute("aria-valuetext", options.note);
      }
    },
  };
}

export interface Switch {
  el: HTMLElement;
  input: HTMLInputElement;
  set(on: boolean): void;
}

/** A labeled on/off switch: a native checkbox with the switch role. */
export function toggle(opts: { label: string; describedBy?: string; onChange: (on: boolean) => void }): Switch {
  const el = h("div", "row toggle");
  const id = nextId("switch");
  const label = h("label", "row-label", opts.label);
  label.htmlFor = id;
  const input = h("input", "switch");
  input.type = "checkbox";
  input.id = id;
  input.setAttribute("role", "switch");
  if (opts.describedBy) input.setAttribute("aria-describedby", opts.describedBy);
  input.addEventListener("change", () => opts.onChange(input.checked));
  el.append(label, input);
  return {
    el,
    input,
    set(on: boolean): void {
      if (input.checked !== on) input.checked = on;
    },
  };
}

/** A small inline SVG icon from path specs: [d, stroke width, opacity]. */
export function icon(paths: readonly [d: string, width: number, opacity: number][], viewBox = "0 0 24 16"): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("icon");
  for (const [d, width, opacity] of paths) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    path.setAttribute("stroke-width", String(width));
    if (opacity < 1) path.setAttribute("opacity", String(opacity));
    svg.append(path);
  }
  return svg;
}
