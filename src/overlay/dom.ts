/**
 * Per-frame style writes that skip unchanged values, so a paint only touches what moved.
 * Keys are CSS property names (`opacity`, `transform`, `--x`) or SVG attributes prefixed with `@`.
 */
const written = new WeakMap<Element, Map<string, string>>();

export function put(el: HTMLElement | SVGElement, prop: string, value: string): void {
  let seen = written.get(el);
  if (!seen) {
    seen = new Map();
    written.set(el, seen);
  }
  if (seen.get(prop) === value) return;
  seen.set(prop, value);
  if (prop.startsWith("@")) el.setAttribute(prop.slice(1), value);
  else el.style.setProperty(prop, value);
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

export const SVG_NS = "http://www.w3.org/2000/svg";

export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}
