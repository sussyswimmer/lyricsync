import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../contract/contract";
import {
  PaletteCache,
  SAMPLE_SIZE,
  hexToHsl,
  hslToHex,
  paletteFromPixels,
  readArtwork,
  rgbToHsl,
  type Palette,
} from "../src/core/palette";

type Rgb = [number, number, number];
const PIXELS = SAMPLE_SIZE * SAMPLE_SIZE;

/** A 48×48 RGBA sample made of flat areas; each share is a fraction of the pixels. */
function cover(parts: [Rgb, number][], alpha = 255): Uint8ClampedArray {
  const px = new Uint8ClampedArray(PIXELS * 4);
  let i = 0;
  for (const [[r, g, b], share] of parts) {
    for (let k = Math.round(share * PIXELS); k > 0 && i < px.length; k--, i += 4) px.set([r, g, b, alpha], i);
  }
  return px;
}

const hue = (hex: string): number => hexToHsl(hex)[0];
/** Distance between two hues on the color wheel, 0..0.5. */
const hueGap = (a: number, b: number): number => Math.min(Math.abs(a - b), 1 - Math.abs(a - b));

function expectLegible(p: Palette): void {
  for (const color of Object.values(p)) expect(color).toMatch(/^#[0-9a-f]{6}$/);
  const [, , lyricL] = hexToHsl(p.lyric);
  const [, hiS, hiL] = hexToHsl(p.highlight);
  expect(lyricL).toBeGreaterThanOrEqual(0.85);
  expect(hiL).toBeGreaterThanOrEqual(0.6);
  expect(hiL).toBeLessThanOrEqual(0.75);
  expect(hiS).toBeGreaterThanOrEqual(0.55);
}

describe("color conversion", () => {
  it("round-trips between hex and HSL", () => {
    expect(hslToHex(0, 0, 1)).toBe("#ffffff");
    expect(hslToHex(0, 1, 0.5)).toBe("#ff0000");
    expect(rgbToHsl(128, 128, 128)).toEqual([0, 0, 128 / 255]);
    const [h, s, l] = hexToHsl("#f2a65a");
    expect(hslToHex(h, s, l)).toBe("#f2a65a");
  });
});

describe("paletteFromPixels", () => {
  it("tints lyrics with the dominant color and highlights with the most vivid one", () => {
    // like the prototype's Neon Monsoon cover: dark teal sky, orange sun, magenta stripes
    const p = paletteFromPixels(cover([[[15, 59, 70], 0.7], [[247, 169, 59], 0.2], [[212, 55, 122], 0.1]]));
    expect(hueGap(hue(p.highlight), hexToHsl("#f7a93b")[0])).toBeLessThan(0.02);
    expect(hueGap(hue(p.lyric), rgbToHsl(15, 59, 70)[0])).toBeLessThan(0.02);
    expect(hueGap(hue(p.dim), rgbToHsl(15, 59, 70)[0])).toBeLessThan(0.02);
    expectLegible(p);
  });

  it("prefers a strong mid-tone over a larger washed-out area", () => {
    // like the Jade Hour cover: cream paper, green hill, dark green sun, a thin gold frame
    const p = paletteFromPixels(
      cover([[[233, 228, 210], 0.55], [[31, 122, 92], 0.3], [[15, 61, 47], 0.1], [[201, 180, 107], 0.05]]),
    );
    expect(hueGap(hue(p.highlight), rgbToHsl(31, 122, 92)[0])).toBeLessThan(0.02);
    expectLegible(p);
  });

  it("brightens a dark vivid color into the highlight band", () => {
    const p = paletteFromPixels(cover([[[40, 0, 80], 1]]));
    expect(hueGap(hue(p.highlight), rgbToHsl(40, 0, 80)[0])).toBeLessThan(0.02);
    expectLegible(p);
  });

  it("keeps lyrics neutral when the dominant color is nearly black", () => {
    const p = paletteFromPixels(cover([[[10, 10, 14], 0.85], [[40, 90, 220], 0.15]]));
    expect(hexToHsl(p.lyric)[1]).toBeLessThan(0.1);
    expect(hueGap(hue(p.highlight), rgbToHsl(40, 90, 220)[0])).toBeLessThan(0.02);
  });

  it("falls back to the defaults on a gray cover", () => {
    expect(paletteFromPixels(cover([[[30, 30, 30], 0.6], [[200, 200, 200], 0.4]]))).toEqual(DEFAULT_SETTINGS.colors);
  });

  it("does not invent a hue from a black cover with a faint tint", () => {
    expect(paletteFromPixels(cover([[[12, 2, 4], 1]]))).toEqual(DEFAULT_SETTINGS.colors);
  });

  it("takes the highlight from a tiny colorful accent on a gray cover", () => {
    const p = paletteFromPixels(cover([[[40, 40, 40], 0.996], [[220, 30, 40], 0.004]]));
    expect(p.lyric).toBe(DEFAULT_SETTINGS.colors.lyric);
    expect(p.dim).toBe(DEFAULT_SETTINGS.colors.dim);
    expect(hueGap(hue(p.highlight), rgbToHsl(220, 30, 40)[0])).toBeLessThan(0.02);
    expectLegible(p);
  });

  it("ignores a dull accent on a gray cover", () => {
    expect(paletteFromPixels(cover([[[40, 40, 40], 0.996], [[120, 100, 100], 0.004]])).highlight).toBe(
      DEFAULT_SETTINGS.colors.highlight,
    );
  });

  it("skips transparent pixels", () => {
    const px = cover([[[220, 30, 40], 0.5], [[40, 90, 220], 0.5]]);
    for (let i = 3; i < px.length / 2; i += 4) px[i] = 0;
    expect(hueGap(hue(paletteFromPixels(px).highlight), rgbToHsl(40, 90, 220)[0])).toBeLessThan(0.02);
    expect(paletteFromPixels(cover([[[220, 30, 40], 1]], 0))).toEqual(DEFAULT_SETTINGS.colors);
    expect(paletteFromPixels([])).toEqual(DEFAULT_SETTINGS.colors);
  });

  it("stays legible on any cover", () => {
    let seed = 7;
    const rand = (): number => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    for (let n = 0; n < 300; n++) {
      const colors = 1 + Math.floor(rand() * 5);
      const parts = Array.from({ length: colors }, (): [Rgb, number] => [
        [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256)],
        rand(),
      ]);
      const total = parts.reduce((sum, [, share]) => sum + share, 0);
      expectLegible(paletteFromPixels(cover(parts.map(([rgb, share]) => [rgb, share / total]))));
    }
  });
});

describe("PaletteCache", () => {
  const pixels = cover([[[40, 90, 220], 1]]);

  it("computes once per track and artwork", async () => {
    const read = vi.fn(async () => pixels);
    const cache = new PaletteCache(read);
    const first = cache.get("a", "data:a");
    expect(cache.get("a", "data:a")).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
    expect(hueGap(hue((await first)?.highlight ?? ""), rgbToHsl(40, 90, 220)[0])).toBeLessThan(0.02);
  });

  it("recomputes when the artwork for a track changes or arrives late", async () => {
    const read = vi.fn(async () => pixels);
    const cache = new PaletteCache(read);
    expect(await cache.get("a", null)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    await cache.get("a", "data:a");
    await cache.get("a", "data:b");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("resolves to null when artwork can't be read", async () => {
    expect(await new PaletteCache(async () => null).get("a", "data:bad")).toBeNull();
    expect(await new PaletteCache(() => Promise.reject(new Error("boom"))).get("a", "data:bad")).toBeNull();
  });

  it("forgets the least recently used tracks past its limit", async () => {
    const read = vi.fn(async () => pixels);
    const cache = new PaletteCache(read, 2);
    cache.get("a", "data:a");
    cache.get("b", "data:b");
    cache.get("a", "data:a");
    cache.get("c", "data:c");
    expect(read).toHaveBeenCalledTimes(3);
    cache.get("a", "data:a");
    expect(read).toHaveBeenCalledTimes(3);
    cache.get("b", "data:b");
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("reads real artwork by default", async () => {
    expect(await new PaletteCache().get("a", null)).toBeNull();
  });
});

describe("readArtwork", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubDom(opts: { decode?: () => Promise<void>; context?: boolean } = {}): { drawImage: ReturnType<typeof vi.fn> } {
    const drawImage = vi.fn();
    const data = new Uint8ClampedArray(PIXELS * 4);
    const canvas = {
      width: 0,
      height: 0,
      getContext: () =>
        opts.context === false
          ? null
          : { imageSmoothingQuality: "low", drawImage, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data, width: w, height: h }) },
    };
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        decode = opts.decode ?? (async () => undefined);
      },
    );
    vi.stubGlobal("document", { createElement: () => canvas });
    return { drawImage };
  }

  it("samples the decoded image at 48×48", async () => {
    const { drawImage } = stubDom();
    const px = await readArtwork("data:image/png;base64,AAAA");
    expect(px).toHaveLength(PIXELS * 4);
    expect(drawImage).toHaveBeenCalledWith(expect.objectContaining({ src: "data:image/png;base64,AAAA" }), 0, 0, 48, 48);
  });

  it("returns null when the image won't decode", async () => {
    stubDom({ decode: () => Promise.reject(new Error("EncodingError")) });
    expect(await readArtwork("data:image/png;base64,broken")).toBeNull();
  });

  it("returns null without a 2D context", async () => {
    stubDom({ context: false });
    expect(await readArtwork("data:image/png;base64,AAAA")).toBeNull();
  });
});
