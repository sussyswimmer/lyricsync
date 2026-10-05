import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../contract/contract";
import { FONTS, fontFor } from "../src/overlay/fonts";
import { resolveLook, shadowLayers, type Frame, type Look } from "../src/overlay/look";
import { drawnShadow, fitRow, pull, rowWidth, whenFaceLoads, zoomAt, type Shape } from "../src/overlay/modes/lens";

const look = (over: Partial<Settings> = {}, frame: Partial<Frame> = {}): Look =>
  resolveLook({ ...structuredClone(DEFAULT_SETTINGS), mode: "lens", ...over }, null, {
    width: 1280,
    height: 720,
    dpr: 1,
    motion: true,
    unsynced: false,
    ...frame,
  });

/** The fisheye's settings (lens.ts): far words shrink to `low`, the word being sung grows to SCALE_MAX. */
const SCALE_MAX = 1.35;
const ROW_FIT = 0.92;

/** A row of `n` words, each `width` px wide at the base size, a space of `space` px between them. */
function row(n: number, width: number, space: number): Shape {
  return {
    widths: new Array<number>(n).fill(width),
    order: Array.from({ length: n }, (_, j) => j),
    gaps: Array.from({ length: n }, (_, v) => (v < n - 1 ? space : 0)),
  };
}

/** The row's drawn width with the lens eased in by `lens` and the singing position at `a`, at the zoom the mode draws it with. */
function drawnWidth(shape: Shape, low: number, lens: number, a: number, zoom: number): number {
  const scales = shape.widths.map((_, j) => 1 + lens * (low + (SCALE_MAX - low) * pull(j, a) - 1));
  return rowWidth(shape, scales) * zoom;
}

// Regression (lens-long-line-fit): the lens was fitted to the row's at-rest width (every word at
// scale 1). Under the lens far words are at half size, so a 16-word line used 57% of the stage and
// its far words shrank to 13 px (a 34-word line hit the 11 px floor), while a 10-word line got 19 px.
describe("Lens: fitting a long line", () => {
  // Fraunces at 38.7 px (1280×720): about 2.6 em per word, a quarter-em space
  const size = look().size;
  const word = size * 2.6;
  const space = size * 0.25;

  it("fits the lensed row on its own: a 16-word line keeps full size under the lens, like a 10-word line", () => {
    const short = fitRow(row(10, word, space), size, 1280, true);
    const long = fitRow(row(16, word, space), size, 1280, true);
    expect(long.fit).toBe(short.fit);
    expect(long.fit).toBe(1);
    expect(size * long.low * long.fit).toBeGreaterThan(19);
    // ...while at rest the same line needs a smaller size to fit
    expect(zoomAt(long, 0, 1280)).toBeLessThan(0.75);
  });

  it("fills the stage under the lens instead of a band in the middle", () => {
    for (const n of [24, 34, 50]) {
      const shape = row(n, word, space);
      const f = fitRow(shape, size, 1280, true);
      expect(f.fit, `${n} words`).toBeLessThan(1);
      const zoom = zoomAt(f, 1, 1280);
      const widest = Math.max(...Array.from({ length: n * 8 + 1 }, (_, i) => drawnWidth(shape, f.low, 1, i / 8, zoom)));
      expect(widest, `${n} words`).toBeGreaterThan(0.97 * ROW_FIT * 1280);
      expect(widest, `${n} words`).toBeLessThanOrEqual(ROW_FIT * 1280 + 1e-6);
    }
  });

  it("never runs wider than the stage allows while the lens eases in, wherever the singing position is", () => {
    for (const [n, w] of [
      [3, word],
      [8, word],
      [16, word],
      [34, word],
      [12, size * 4],
    ] as const) {
      const shape = row(n, w, space);
      const f = fitRow(shape, size, 1280, true);
      for (let l = 0; l <= 1.0001; l += 0.05) {
        const zoom = zoomAt(f, l, 1280);
        for (let a = 0; a <= n; a += 0.25) {
          expect(drawnWidth(shape, f.low, l, a, zoom), `n=${n} lens=${l.toFixed(2)} a=${a}`).toBeLessThanOrEqual(ROW_FIT * 1280 + 1e-6);
        }
      }
    }
  });

  it("keeps a short line's size steady as the lens eases in (only long lines grow into the lens)", () => {
    const f = fitRow(row(5, word, space), size, 1280, true);
    expect(zoomAt(f, 0, 1280)).toBe(1);
    expect(zoomAt(f, 1, 1280)).toBe(1);
    // three long words: the lensed row is the wider one and has to shrink, the same throughout
    const g = fitRow(row(3, size * 9.6, space), size, 1280, true);
    expect(g.widest).toBeGreaterThan(g.rest);
    expect(g.fit).toBeLessThan(1);
    expect(zoomAt(g, 0, 1280)).toBeCloseTo(zoomAt(g, 1, 1280), 9);
    expect(zoomAt(g, 0.5, 1280)).toBeCloseTo(zoomAt(g, 1, 1280), 9);
  });

  it("fits a line without a lens (unsynced, reduced motion) to its at-rest width, at one size", () => {
    const shape = row(16, word, space);
    const f = fitRow(shape, size, 1280, false);
    expect(f.widest).toBe(f.rest);
    expect(zoomAt(f, 0, 1280)).toBe(f.fit);
    expect(f.rest * f.fit).toBeCloseTo(ROW_FIT * 1280, 6);
  });

  it("keeps far words of very long lines readable in portrait", () => {
    const portrait = look({}, { width: 1080, height: 1920 });
    const f = fitRow(row(16, portrait.size * 2, portrait.size * 0.25), portrait.size, 1080, true);
    expect(portrait.size * f.low * zoomAt(f, 1, 1080)).toBeGreaterThan(16);
  });
});

/** A parsed text-shadow layer: offset y, blur, alpha. */
function layers(shadow: string): { y: number; blur: number; alpha: number }[] {
  return shadow.split(/,\s*(?![^()]*\))/).map((layer) => {
    const [, y = "0", blur = "0"] = layer.match(/-?[\d.]+px/g) ?? [];
    const alpha = Number(/,\s*([\d.]+)\)\s*$/.exec(layer)?.[1] ?? "1");
    return { y: Number.parseFloat(y), blur: Number.parseFloat(blur), alpha };
  });
}

// Regression (lens-far-word-legibility): far words faded by element opacity took their dark shadow
// down with them (alpha 0.46 → 0.28), and the shadow, built for the base size, shrank with the
// word's transform to about a pixel. On a light wallpaper "drift toward home" all but vanished.
describe("Lens: the shadow of a word drawn small and faded", () => {
  const l = look();

  it("lands on screen as the shadow of text its drawn size, floors included", () => {
    for (const scale of [1, 0.75, 0.5, 0.3]) {
      const drawn = layers(drawnShadow(l, scale, 1));
      const want = layers(shadowLayers(l, l.size * scale, false).map((x) => x.join(" ")).join(", "));
      expect(drawn).toHaveLength(want.length);
      drawn.forEach((layer, i) => {
        const target = want[i];
        expect(target).toBeDefined();
        if (!target) return;
        // the word's transform scales the shadow by `scale` on the way to the screen
        expect(layer.y * scale, `scale ${scale} layer ${i}`).toBeCloseTo(target.y, 1);
        expect(layer.blur * scale, `scale ${scale} layer ${i}`).toBeCloseTo(target.blur, 1);
      });
    }
    // a half-size word keeps at least a pixel of offset and a 1.5 px blur on screen
    const [first] = layers(drawnShadow(l, 0.25, 0.6));
    expect((first?.y ?? 0) * 0.25).toBeGreaterThanOrEqual(0.99);
    expect((first?.blur ?? 0) * 0.25).toBeGreaterThanOrEqual(1.49);
  });

  it("isn't faded with the word: its alpha times the word's opacity is the full alpha", () => {
    const full = layers(shadowLayers(l, l.size * 0.5, false).map((x) => x.join(" ")).join(", "));
    const faded = layers(drawnShadow(l, 0.5, 0.6));
    faded.forEach((layer, i) => {
      expect(layer.alpha * 0.6).toBeCloseTo(Math.min(0.6, full[i]?.alpha ?? 0), 2);
    });
  });

  it("keeps the active word's highlight halo in its highlight color", () => {
    const glow = drawnShadow(l, 1, 1, true);
    expect(glow).toContain("rgba(0, 0, 0,");
    expect(layers(glow)).toHaveLength(3);
  });
});

// Regression (lens-perf): a 200 ms text-shadow transition on every word re-laid out and re-rastered
// it on every frame of each glow change and shadow step.
describe("Lens: styles", () => {
  // Read from disk: vitest hands CSS imports (even ?raw) to its CSS pipeline, which yields "" in node. A
  // non-literal specifier, because the strict type check runs without node's types.
  let lensCss = "";
  beforeAll(async () => {
    const fsModule = "node:fs";
    const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: URL, encoding: "utf8"): string };
    lensCss = fs.readFileSync(new URL("../src/styles/lens.css", import.meta.url), "utf8");
  });

  it("transitions a word's color only, never its text-shadow", () => {
    const css = lensCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toContain(".lens-word");
    const rule = /\.lens-word\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const transition = /transition:\s*([^;]*);/.exec(rule)?.[1] ?? "";
    expect(transition).toContain("color");
    expect(transition).not.toContain("text-shadow");
    expect(css).not.toMatch(/transition:[^;]*text-shadow/);
  });
});

// Regression (lens-fontcheck-freeze): every build asked FontFaceSet.check about the whole song
// (every line joined, nothing deduplicated) against the whole fallback stack at the current size.
// Blink looks every family up for every character, so a settings slider step cost 300-400 ms.
describe("Lens: waiting for the lyric face", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFonts(loaded: boolean): { check: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn> } {
    const check = vi.fn((_spec: string, _text?: string) => loaded);
    const load = vi.fn(async (_spec: string, _text?: string) => []);
    vi.stubGlobal("document", { fonts: { check, load } });
    return { check, load };
  }

  it("asks about the bundled family alone, at one size, for each distinct character once", () => {
    const { check } = stubFonts(true);
    const fraunces = fontFor("Fraunces");
    const text = "Paper lanterns over the river Paper lanterns over the river";
    expect(whenFaceLoads(fraunces.stack, 700, text)).toBeNull();
    expect(check).toHaveBeenCalledTimes(1);
    const [spec, chars] = check.mock.calls[0] ?? [];
    expect(spec).toBe('700 16px "Fraunces"');
    expect(chars).toBeDefined();
    expect([...(chars ?? "")].sort().join("")).toBe([...new Set(text)].sort().join(""));
  });

  it("never asks again for the same face and lyrics (a Size drag rebuilds with them on every step)", () => {
    const { check } = stubFonts(true);
    const syne = fontFor("Syne");
    const text = "Neon on the wet street, every sign a little sun";
    for (let i = 0; i < 10; i++) expect(whenFaceLoads(syne.stack, 800, text)).toBeNull();
    expect(check).toHaveBeenCalledTimes(1);
    // another weight or other lyrics are asked about once each
    whenFaceLoads(syne.stack, 700, text);
    whenFaceLoads(syne.stack, 800, `${text}!`);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("loads the missing characters when the face isn't in yet, and asks again next time", async () => {
    const { check, load } = stubFonts(false);
    const caveat = fontFor("Caveat");
    const text = "Thương nhớ con đường cũ";
    const loading = whenFaceLoads(caveat.stack, 600, text);
    expect(loading).not.toBeNull();
    await loading;
    expect(load).toHaveBeenCalledWith('600 16px "Caveat"', [...new Set(text)].join(""));
    whenFaceLoads(caveat.stack, 600, text);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("has nothing to load for the system stack, or without a document", () => {
    const { check } = stubFonts(false);
    const system = FONTS.find((f) => f.family === "System");
    expect(system).toBeDefined();
    expect(whenFaceLoads(system?.stack ?? "", 700, "anything")).toBeNull();
    expect(check).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    expect(whenFaceLoads(fontFor("Fraunces").stack, 700, "anything")).toBeNull();
  });
});
