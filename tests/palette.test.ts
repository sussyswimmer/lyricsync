import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../contract/contract";
import {
  PaletteCache,
  SAMPLE_SIZE,
  accentFor,
  coverStats,
  hexToHsl,
  hslToHex,
  paletteFromPixels,
  readArtwork,
  rgbToHsl,
  type CoverStats,
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

/** Readable on any wallpaper (behind the dark legibility shadow), and the words being sung stand out. */
function expectLegible(p: Palette): void {
  for (const color of Object.values(p)) expect(color).toMatch(/^#[0-9a-f]{6}$/);
  const [, lyricS, lyricL] = hexToHsl(p.lyric);
  const [, hiS, hiL] = hexToHsl(p.highlight);
  const [, , dimL] = hexToHsl(p.dim);
  expect(lyricL).toBeGreaterThanOrEqual(0.72);
  expect(dimL).toBeGreaterThanOrEqual(0.54);
  expect(dimL).toBeLessThan(lyricL);
  // a vivid mid-light highlight, or a near-white one over gray lyrics
  const vivid = hiL >= 0.6 && hiL <= 0.75 && hiS >= 0.55;
  const white = hiL >= 0.94 && hiS <= 0.15 && lyricL <= 0.8;
  expect(vivid || white).toBe(true);
  expect(Math.abs(hiL - lyricL) >= 0.1 || Math.abs(hiS - lyricS) >= 0.4).toBe(true);
  // the color the sung words blend into reads as well: mid-light and with a hue, or a light gray
  if (p.accent !== undefined) {
    const [, acS, acL] = hexToHsl(p.accent);
    expect((acL >= 0.6 && acL <= 0.83 && acS >= 0.33) || (acL >= 0.94 && acS <= 0.15)).toBe(true);
  }
}

/** Near-gray: a color with no hue to speak of. */
const grayish = (hex: string): boolean => hexToHsl(hex)[1] <= 0.12;

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
  it("highlights with the most vivid color, and tints the lyrics and the other lines with the cover's tone", () => {
    // like the prototype's Neon Monsoon cover: dark teal sky, orange sun, magenta stripes
    const p = paletteFromPixels(cover([[[15, 59, 70], 0.7], [[247, 169, 59], 0.2], [[212, 55, 122], 0.1]]));
    expect(hueGap(hue(p.highlight), hexToHsl("#f7a93b")[0])).toBeLessThan(0.02);
    // one tone for both, and a faint one: an orange sun on a teal sky clash, so neither tints much
    expect(hueGap(hue(p.lyric), hue(p.dim))).toBeLessThan(0.01);
    expect(hexToHsl(p.lyric)[1]).toBeLessThan(0.3);
    expectLegible(p);
    // where the cover's colors agree, its tone is the lyrics' color
    const sunset = paletteFromPixels(cover([[[20, 10, 30], 0.6], [[247, 120, 40], 0.3], [[230, 70, 60], 0.1]]));
    expect(hueGap(hue(sunset.lyric), rgbToHsl(247, 120, 40)[0])).toBeLessThan(0.04);
    expect(hexToHsl(sunset.lyric)[1]).toBeGreaterThan(0.4);
    expectLegible(sunset);
  });

  it("tints as deeply as the cover is colorful, a black background notwithstanding", () => {
    const blue = paletteFromPixels(cover([[[10, 10, 14], 0.85], [[40, 90, 220], 0.15]]));
    expect(hueGap(hue(blue.lyric), rgbToHsl(40, 90, 220)[0])).toBeLessThan(0.02);
    expect(hueGap(hue(blue.highlight), rgbToHsl(40, 90, 220)[0])).toBeLessThan(0.02);
    const deep = paletteFromPixels(cover([[[30, 70, 200], 0.8], [[240, 240, 240], 0.2]]));
    const faint = paletteFromPixels(cover([[[110, 120, 150], 0.8], [[240, 240, 240], 0.2]]));
    expect(hexToHsl(deep.lyric)[1]).toBeGreaterThan(hexToHsl(faint.lyric)[1] + 0.2);
    expect(hexToHsl(deep.dim)[1]).toBeGreaterThan(hexToHsl(faint.dim)[1]);
    for (const p of [blue, deep, faint]) expectLegible(p);
  });

  it("keeps a highlight of the lyrics' own hue a step darker than them", () => {
    const p = paletteFromPixels(cover([[[30, 70, 200], 0.8], [[240, 240, 240], 0.2]]));
    expect(hueGap(hue(p.highlight), hue(p.lyric))).toBeLessThan(0.05);
    expect(hexToHsl(p.highlight)[2]).toBeLessThanOrEqual(0.665);
    expect(hexToHsl(p.lyric)[2] - hexToHsl(p.highlight)[2]).toBeGreaterThanOrEqual(0.17);
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

  it("gives a black-and-white cover grays: a near-white highlight over light gray lyrics", () => {
    const p = paletteFromPixels(cover([[[30, 30, 30], 0.6], [[200, 200, 200], 0.4]]));
    expect(Object.values(p).every(grayish)).toBe(true);
    expect(hexToHsl(p.highlight)[2]).toBeGreaterThanOrEqual(0.94);
    expectLegible(p);
  });

  it("does not invent a hue from a black cover with a faint tint", () => {
    expect(Object.values(paletteFromPixels(cover([[[12, 2, 4], 1]]))).every(grayish)).toBe(true);
  });

  it("takes the highlight from a tiny colorful accent on a gray cover", () => {
    const p = paletteFromPixels(cover([[[40, 40, 40], 0.996], [[220, 30, 40], 0.004]]));
    expect(grayish(p.lyric) && grayish(p.dim)).toBe(true);
    expect(hueGap(hue(p.highlight), rgbToHsl(220, 30, 40)[0])).toBeLessThan(0.02);
    expectLegible(p);
  });

  it("ignores a dull accent on a gray cover", () => {
    const p = paletteFromPixels(cover([[[40, 40, 40], 0.996], [[120, 100, 100], 0.004]]));
    expect(grayish(p.highlight)).toBe(true);
    expect(hexToHsl(p.highlight)[2]).toBeGreaterThanOrEqual(0.94);
  });

  it("skips transparent pixels", () => {
    const px = cover([[[220, 30, 40], 0.5], [[40, 90, 220], 0.5]]);
    for (let i = 3; i < px.length / 2; i += 4) px[i] = 0;
    expect(hueGap(hue(paletteFromPixels(px).highlight), rgbToHsl(40, 90, 220)[0])).toBeLessThan(0.02);
    expect(paletteFromPixels(cover([[[220, 30, 40], 1]], 0))).toEqual(DEFAULT_SETTINGS.colors);
    expect(paletteFromPixels([])).toEqual(DEFAULT_SETTINGS.colors);
  });

  it("blends the highlight into the cover's second color, a muted one counting by how much of the cover it takes", () => {
    // like a cover of a brown wooden door in dark green ivy: the ivy is muted, but a lot of the cover
    const p = paletteFromPixels(cover([[[120, 80, 45], 0.25], [[38, 50, 28], 0.45], [[30, 30, 30], 0.3]]));
    expect(hueGap(hue(p.highlight), rgbToHsl(120, 80, 45)[0])).toBeLessThan(0.03);
    expect(hueGap(hue(p.accent ?? "#000000"), rgbToHsl(38, 50, 28)[0])).toBeLessThan(0.04);
    // light enough to read, but still as muted as the cover has it: an olive, not a lime
    expect(hexToHsl(p.accent ?? "#000000")[1]).toBeLessThan(0.5);
    expectLegible(p);
  });

  it("takes a true second color over the fringe of the main one", () => {
    // a blue sky with a violet edge and a small orange horizon: orange, however much violet there is
    const p = paletteFromPixels(cover([[[20, 40, 120], 0.65], [[70, 40, 150], 0.1], [[230, 110, 50], 0.1], [[10, 10, 10], 0.15]]));
    expect(hueGap(hue(p.highlight), rgbToHsl(20, 40, 120)[0])).toBeLessThan(0.04);
    expect(hueGap(hue(p.accent ?? "#000000"), rgbToHsl(230, 110, 50)[0])).toBeLessThan(0.04);
    expectLegible(p);
  });

  it("blends a one-color cover's highlight into its neighbor on the color wheel", () => {
    const p = paletteFromPixels(cover([[[40, 90, 220], 0.6], [[8, 8, 10], 0.4]]));
    expect(p.accent).toBe(accentFor(p.highlight));
    // a second color too small to count changes nothing
    expect(paletteFromPixels(cover([[[40, 90, 220], 0.6], [[8, 8, 10], 0.39], [[230, 110, 50], 0.01]])).accent).toBe(p.accent);
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

describe("accentFor", () => {
  it("is the highlight's neighbor on the color wheel, a touch lighter", () => {
    const [h, s, l] = hexToHsl("#4a88e8");
    const [ah, as, al] = hexToHsl(accentFor("#4a88e8"));
    expect(hueGap(ah, (h + 0.055) % 1)).toBeLessThan(0.01);
    expect(Math.abs(as - s)).toBeLessThan(0.03);
    expect(al).toBeCloseTo(l + 0.08, 1);
    // never past 0.82, however light the highlight
    expect(hexToHsl(accentFor("#f5c8a0"))[2]).toBeLessThanOrEqual(0.825);
  });

  it("keeps a gray highlight gray, a little lighter", () => {
    const [, s, l] = hexToHsl(accentFor("#f5f5f5"));
    expect(s).toBeLessThan(0.05);
    expect(l).toBeGreaterThan(hexToHsl("#f5f5f5")[2]);
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

describe("coverStats", () => {
  const RED: Rgb = [255, 0, 0];
  const ORANGE: Rgb = [255, 170, 0]; // hue 40°, the warmest
  const BLUE: Rgb = [0, 85, 255]; // hue 220°, the coolest
  const stats = (parts: [Rgb, number][]): CoverStats => {
    const s = coverStats(cover(parts));
    if (!s) throw new Error("no opaque pixels");
    return s;
  };

  it("reads lightness, its spread and chroma; black and white is all gray, with no hue or warmth", () => {
    expect(stats([[[0, 0, 0], 0.5], [[255, 255, 255], 0.5]])).toEqual({
      lightness: 0.5,
      contrast: 0.5,
      chroma: 0,
      colorfulness: 0,
      warmth: 0,
      gray: 1,
      hue: null,
    });
  });

  it("reads a flat color: its lightness and hue, full chroma, no spread", () => {
    // colorfulness 0.3 × |(r − g, (r + g) / 2 − b)| / 110 = 0.3 × 285.1 / 110; warmth cos(0° − 40°)
    expect(stats([[RED, 1]])).toEqual({ lightness: 0.5, contrast: 0, chroma: 1, colorfulness: 0.778, warmth: 0.766, gray: 0, hue: 0 });
    expect(stats([[[40, 0, 80], 1]]).hue).toBeCloseTo(rgbToHsl(40, 0, 80)[0], 3);
  });

  it("runs warmth from orange (+1) to blue (−1)", () => {
    expect(stats([[ORANGE, 1]]).warmth).toBe(1);
    expect(stats([[BLUE, 1]]).warmth).toBe(-1);
    expect(stats([[ORANGE, 0.5], [BLUE, 0.5]]).warmth).toBe(0);
  });

  it("weights the hue by chroma, and gives a mostly gray cover none", () => {
    // half vivid red, half a muted blue (hue 228°): the mean stays within 10° of red
    expect(hueGap(stats([[RED, 0.5], [[90, 100, 140], 0.5]]).hue ?? -1, 0)).toBeLessThan(0.03);
    // gray pixels have no hue to add: a red accent on near-gray is red
    expect(hueGap(stats([[[200, 30, 40], 0.3], [[120, 110, 110], 0.7]]).hue ?? -1, rgbToHsl(200, 30, 40)[0])).toBeLessThan(0.01);
    const faint = stats([[[40, 40, 40], 0.95], [ORANGE, 0.05]]);
    expect(faint.gray).toBeCloseTo(0.95, 2);
    expect(faint.hue).toBeNull();
    // a little color on a gray cover is only a little warm
    expect(faint.warmth).toBeGreaterThan(0);
    expect(faint.warmth).toBeLessThan(0.3);
  });

  it("grows colorfulness with clashing colors, up to 1", () => {
    const muted = stats([[[120, 100, 90], 1]]).colorfulness;
    const clash = stats([[[255, 0, 255], 0.5], [[0, 255, 0], 0.5]]).colorfulness;
    expect(muted).toBeLessThan(0.3);
    expect(clash).toBe(1);
  });

  it("reads only pixels at least half opaque, and is null with none", () => {
    const px = cover([[RED, 0.5], [BLUE, 0.5]]);
    for (let i = 3; i < px.length / 2; i += 4) px[i] = 127;
    expect(coverStats(px)).toEqual(stats([[BLUE, 1]]));
    expect(coverStats(cover([[RED, 1]], 0))).toBeNull();
    expect(coverStats([])).toBeNull();
  });

  it("stays in range on any cover", () => {
    let seed = 11;
    const rand = (): number => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    for (let n = 0; n < 200; n++) {
      const parts = Array.from({ length: 1 + Math.floor(rand() * 5) }, (): [Rgb, number] => [
        [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256)],
        rand(),
      ]);
      const total = parts.reduce((sum, [, share]) => sum + share, 0);
      const s = stats(parts.map(([rgb, share]) => [rgb, share / total]));
      for (const v of [s.lightness, s.chroma, s.colorfulness, s.gray]) expect(v >= 0 && v <= 1).toBe(true);
      expect(s.contrast >= 0 && s.contrast <= 0.5).toBe(true);
      expect(s.warmth >= -1 && s.warmth <= 1).toBe(true);
      if (s.hue !== null) expect(s.hue >= 0 && s.hue <= 1).toBe(true);
    }
  });
});

describe("PaletteCache.cover", () => {
  const pixels = cover([[[15, 59, 70], 0.7], [[247, 169, 59], 0.2], [[212, 55, 122], 0.1]]);

  /** A reader whose reads finish when the test says so. */
  function manualReader(): { read: (art: string) => Promise<ArrayLike<number> | null>; finish: (art: string, px: ArrayLike<number> | null) => Promise<void> } {
    const waiting = new Map<string, (px: ArrayLike<number> | null) => void>();
    return {
      read: (art) => new Promise((resolve) => waiting.set(art, resolve)),
      finish: async (art, px) => {
        waiting.get(art)?.(px);
        await Promise.resolve();
      },
    };
  }

  it("is filled by the same decode as the palette, before the palette resolves", async () => {
    const read = vi.fn(async () => pixels);
    const cache = new PaletteCache(read);
    const seen: (CoverStats | null)[] = [];
    const palette = cache.get("a", "data:a").then((p) => {
      seen.push(cache.cover("a"));
      return p;
    });
    expect(cache.cover("a")).toBeNull(); // not decoded yet
    expect(await palette).toEqual(paletteFromPixels(pixels));
    expect(seen).toEqual([coverStats(pixels)]);
    // a hit keeps both, with no second decode
    await cache.get("a", "data:a");
    expect(cache.cover("a")).toEqual(coverStats(pixels));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("is null without artwork, with artwork that can't be read, and for a track it doesn't hold", async () => {
    const cache = new PaletteCache(async (art) => (art === "data:good" ? pixels : null));
    await cache.get("none", null);
    await cache.get("bad", "data:bad");
    expect(cache.cover("none")).toBeNull();
    expect(cache.cover("bad")).toBeNull();
    expect(cache.cover("never")).toBeNull();
    const failing = new PaletteCache(() => Promise.reject(new Error("boom")));
    await failing.get("x", "data:x");
    expect(failing.cover("x")).toBeNull();
    await cache.get("good", "data:good");
    expect(cache.cover("good")).toEqual(coverStats(pixels));
  });

  it("follows the track's latest artwork: a slower decode of the art it replaced changes nothing", async () => {
    const { read, finish } = manualReader();
    const cache = new PaletteCache(read);
    const old = cover([[[40, 90, 220], 1]]);
    void cache.get("a", "data:old");
    void cache.get("a", "data:new");
    await finish("data:new", pixels);
    expect(cache.cover("a")).toEqual(coverStats(pixels));
    await finish("data:old", old);
    expect(cache.cover("a")).toEqual(coverStats(pixels));
    // and artwork going away for the track takes its cover with it
    await cache.get("a", null);
    expect(cache.cover("a")).toBeNull();
  });

  it("forgets a track's cover with its palette, past the cache's limit", async () => {
    const cache = new PaletteCache(async () => pixels, 2);
    await cache.get("a", "data:a");
    await cache.get("b", "data:b");
    expect(cache.cover("a")).not.toBeNull(); // a peek: "a" stays the oldest
    await cache.get("c", "data:c");
    expect(cache.cover("a")).toBeNull();
    expect(cache.cover("b")).toEqual(coverStats(pixels));
    expect(cache.cover("c")).toEqual(coverStats(pixels));
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
