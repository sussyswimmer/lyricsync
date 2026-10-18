import { describe, expect, it } from "vitest";
import type { Lyrics, Mode } from "../contract/contract";
import { MOCK_TRACKS, lyricsOf, trackKeyOf } from "../src/bridge/mock";
import { FONTS } from "../src/core/faces";
import { parseLrc } from "../src/core/lrc";
import { coverStats, type CoverStats } from "../src/core/palette";
import {
  CONTRACT_STYLES,
  LookKeeper,
  hasWordTags,
  hintsOf,
  lookLabel,
  pickLook,
  qualityOf,
  songFeatures,
  stableHash,
  timingOf,
  type EmphasisRule,
  type SongFeatures,
  type SongInput,
  type SongLook,
} from "../src/core/songlook";
import { pacePlain } from "../src/core/timing";
import { viewFor } from "../src/overlay/view";

// All lyrics below are original placeholder text written for these tests.

// ───────────────────────────── inputs ─────────────────────────────

/**
 * coverStats of the three procedural demo covers (src/bridge/covers.ts), sampled at 48×48 in Chromium
 * the way readArtwork does. Precomputed, since the pixels need a real canvas.
 */
const DEMO_COVERS: readonly CoverStats[] = [
  // Neon Monsoon: teal night, orange sun, magenta stripes
  { lightness: 0.239, contrast: 0.17, chroma: 0.263, colorfulness: 0.749, warmth: 0.161, gray: 0.084, hue: 0.039 },
  // Jade Hour: cream paper, green hill, dark sun, gold frame
  { lightness: 0.579, contrast: 0.273, chroma: 0.22, colorfulness: 0.577, warmth: -0.05, gray: 0.021, hue: 0.373 },
  // Ultraviolet: pink-to-violet radial glow with cyan rings
  { lightness: 0.434, contrast: 0.102, chroma: 0.482, colorfulness: 0.721, warmth: -0.616, gray: 0, hue: 0.748 },
];
/** A demo cover's stats; null for no cover, and for covers added after these tests were written. */
const demoCover = (index: number | null): CoverStats | null => (index === null ? null : (DEMO_COVERS[index] ?? null));

/** A 48×48 cover made of color blocks, by share: [["#rrggbb", 0.5], ...]. */
function swatchCover(blocks: readonly [string, number][]): CoverStats {
  const n = 48 * 48;
  const px = new Uint8ClampedArray(n * 4);
  const total = blocks.reduce((s, [, w]) => s + w, 0);
  let i = 0;
  for (const [hex, w] of blocks) {
    const v = Number.parseInt(hex.slice(1), 16);
    const count = Math.round((w / total) * n);
    for (let k = 0; k < count && i < n; k++, i++) {
      px[i * 4] = (v >> 16) & 255;
      px[i * 4 + 1] = (v >> 8) & 255;
      px[i * 4 + 2] = v & 255;
      px[i * 4 + 3] = 255;
    }
  }
  const stats = coverStats(px);
  if (!stats) throw new Error("empty cover");
  return stats;
}

/** Deterministic PRNG (mulberry32) for building synthetic songs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const stamp = (ms: number): string => {
  const m = Math.floor(ms / 60_000);
  const s = (ms % 60_000) / 1000;
  return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
};

interface SungLine {
  /** silence before the line, ms */
  gap: number;
  /** words (or CJK characters) with how long each is sung, ms */
  words: [string, number][];
}

/** Enhanced LRC with a tag on every word and a closing tag; an empty stamp marks gaps of 6 s or more. */
function enhancedLrc(lines: readonly SungLine[], startMs = 8000): { lrc: string; end: number } {
  const rows: string[] = [];
  let t = startMs;
  for (const line of lines) {
    if (line.gap >= 6000 && rows.length > 0) rows.push(`[${stamp(t + 400)}]`);
    t += line.gap;
    let body = "";
    const lineStart = t;
    for (const [word, ms] of line.words) {
      body += `<${stamp(t)}>${word}`;
      t += ms;
    }
    rows.push(`[${stamp(lineStart)}]${body}<${stamp(t)}>`);
  }
  return { lrc: rows.join("\n"), end: t };
}

/** Line-only LRC: the same lines, stamps only. */
function lineLrc(lines: readonly SungLine[], startMs = 8000): { lrc: string; end: number } {
  const { lrc, end } = enhancedLrc(lines, startMs);
  return { lrc: lrc.replace(/<[^>]*>/gu, ""), end };
}

const join = (words: readonly string[]): string[] => words.map((w, i) => (i < words.length - 1 ? `${w} ` : w));

interface Built {
  name: string;
  input: SongInput;
  lyrics: Lyrics;
}

function build(
  name: string,
  opts: { title: string; album?: string; durationMs: number; cover: CoverStats | null; lyrics: Omit<Lyrics, "trackKey" | "source"> },
): Built {
  const track = { title: opts.title, artist: "Synthetic", album: opts.album ?? "Profiles", durationMs: opts.durationMs };
  const trackKey = trackKeyOf(track);
  const lyrics: Lyrics = { ...opts.lyrics, trackKey, source: "cache" };
  const view = viewFor(lyrics, track.durationMs);
  const timeline = view.kind === "lyrics" ? view.timeline : null;
  return {
    name,
    lyrics,
    input: { track: { ...track, trackKey }, lines: timeline?.lines ?? [], timing: timingOf(lyrics, timeline), cover: opts.cover },
  };
}

/** A line-timed song from fixed lines of text, each word sung for `wordMs`. */
function lineTimed(name: string, title: string, texts: readonly string[], count: number, wordMs: number, cover: CoverStats | null): Built {
  const lines: SungLine[] = Array.from({ length: count }, (_, i) => ({
    gap: 700 + (i % 3) * 300,
    words: join((texts[i % texts.length] as string).split(" ")).map((w): [string, number] => [w, wordMs]),
  }));
  const { lrc, end } = lineLrc(lines, 9000);
  return build(name, { title, durationMs: end + 15_000, cover, lyrics: { status: "found", synced: lrc, plain: null } });
}

// Original placeholder vocabulary (no real lyrics).
const BANK = ("we count the coins in a paper cup and run it back past the corner store my pen is loud city never sleeps on me " +
  "chalk lines rhythm bricks late train talk fast stack it up north side ledger ink window keys pocket change subway static").split(" ");
const SOFT = ("harbor light velvet morning quiet river silver lantern evening paper window ocean slowly over under candle " +
  "winter letters shadow distant hollow golden").split(" ");

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)] as T;
}

// ── fast rap verse: 48 long lines, ~7 syllables/s, little air, a short hook
function rapVerse(): Built {
  const r = rng(7);
  const hook = [0, 1].map(() => Array.from({ length: 12 }, () => pick(r, BANK)));
  const lines: SungLine[] = [];
  for (let i = 0; i < 48; i++) {
    const words = i % 12 < 2 ? (hook[i % 12] as string[]) : Array.from({ length: 12 + Math.floor(r() * 3) }, () => pick(r, BANK));
    lines.push({ gap: 120 + Math.floor(r() * 200), words: join(words).map((w) => [w, 130 + Math.floor(r() * 90) + (w.length > 5 ? 120 : 0)]) });
  }
  const { lrc, end } = enhancedLrc(lines, 6000);
  return build("fast rap verse", {
    title: "Concrete Arithmetic",
    durationMs: end + 12_000,
    cover: swatchCover([["#141414", 0.5], ["#3a3a3a", 0.3], ["#8a8a8a", 0.15], ["#c0392b", 0.05]]),
    lyrics: { status: "found", synced: lrc, plain: null },
  });
}

// ── slow ballad: short lines, long held line endings, a repeated chorus, roomy gaps
function slowBallad(): Built {
  const r = rng(11);
  const chorus = [0, 1, 2].map(() => Array.from({ length: 5 }, () => pick(r, SOFT)));
  const lines: SungLine[] = [];
  for (let i = 0; i < 24; i++) {
    const words =
      i >= 8 && i < 11 ? (chorus[i - 8] as string[]) : i >= 18 && i < 21 ? (chorus[i - 18] as string[]) : Array.from({ length: 4 + Math.floor(r() * 3) }, () => pick(r, SOFT));
    const timed = join(words).map((w, k, all): [string, number] => [
      w,
      k === all.length - 1 ? 1700 + Math.floor(r() * 900) : k === 1 && i % 3 === 0 ? 1150 : 420 + Math.floor(r() * 260),
    ]);
    lines.push({ gap: 1500 + Math.floor(r() * 2200), words: timed });
  }
  const { lrc, end } = enhancedLrc(lines, 14_000);
  return build("slow ballad, held notes", {
    title: "Harbor Light (Piano Version)",
    durationMs: end + 20_000,
    cover: swatchCover([["#3a2a2a", 0.5], ["#6b4a3a", 0.3], ["#c89a6a", 0.15], ["#e8d2b0", 0.05]]),
    lyrics: { status: "found", synced: lrc, plain: null },
  });
}

// ── sparse ambient: nine short lines over five minutes, line-timed, huge gaps
function sparseAmbient(): Built {
  const r = rng(5);
  const lines: SungLine[] = [];
  for (let i = 0; i < 9; i++) {
    const words = Array.from({ length: 3 + Math.floor(r() * 3) }, () => pick(r, SOFT));
    lines.push({ gap: i === 0 ? 0 : 18_000 + Math.floor(r() * 20_000), words: join(words).map((w) => [w, 700 + Math.floor(r() * 500)]) });
  }
  const { lrc, end } = lineLrc(lines, 24_000);
  return build("sparse ambient, long gaps", {
    title: "Tidewater (Slowed + Reverb)",
    durationMs: Math.max(300_000, end + 30_000),
    cover: swatchCover([["#0a1424", 0.6], ["#1d3550", 0.3], ["#6fa0c8", 0.1]]),
    lyrics: { status: "found", synced: lrc, plain: null },
  });
}

// ── dense CJK pop: Japanese placeholder phrases, per-character tags, ~7 characters/s, English hook
const JA = ["夜の街を", "走り出す", "光の中で", "君と僕は", "何度でも", "夢を見てる", "ネオンの雨", "止まらない", "秘密の地図", "明日の窓"];
function denseCjkPop(): Built {
  const r = rng(21);
  const chorus = [0, 1, 2, 3].map(() => `${pick(r, JA)}${pick(r, JA)}${pick(r, JA)}`);
  const lines: SungLine[] = [];
  for (let i = 0; i < 44; i++) {
    const inChorus = i % 11 >= 7;
    if (i % 11 === 10) {
      lines.push({ gap: 300, words: join(["run", "run", "into", "the", "light"]).map((w) => [w, 220]) });
      continue;
    }
    const text = inChorus ? (chorus[i % 4] as string) : `${pick(r, JA)}${pick(r, JA)}${pick(r, JA)}`;
    lines.push({ gap: 250 + Math.floor(r() * 300), words: [...text].map((ch) => [ch, 120 + Math.floor(r() * 60)]) });
  }
  const { lrc, end } = enhancedLrc(lines, 9000);
  return build("dense CJK pop", {
    title: "Neon Diary",
    durationMs: end + 15_000,
    cover: swatchCover([["#ff5fa8", 0.4], ["#ffd1e6", 0.3], ["#35d0ff", 0.2], ["#ffffff", 0.1]]),
    lyrics: { status: "found", synced: lrc, plain: null },
  });
}

// ── plain-only: thirty untimed lines and a black-and-white photo
function plainOnly(): Built {
  const r = rng(3);
  const plain = Array.from({ length: 30 }, () => Array.from({ length: 5 + Math.floor(r() * 4) }, () => pick(r, SOFT)).join(" ")).join("\n");
  return build("plain-only lyrics", {
    title: "Polaroid Weather",
    durationMs: 214_000,
    cover: swatchCover([["#1a1a1a", 0.4], ["#555555", 0.3], ["#999999", 0.2], ["#dddddd", 0.1]]),
    lyrics: { status: "plain-only", synced: null, plain },
  });
}

// ── club remix: short shouted chant lines, lots of repetition, neon on black
function clubRemix(): Built {
  const chants = [["JUMP", "WHEN", "THE", "LIGHTS", "GO"], ["HANDS", "UP", "NOW!"], ["VOLTAGE", "IN", "MY", "VEINS"], ["ONE", "MORE", "TIME!"]];
  const r = rng(13);
  const lines: SungLine[] = [];
  for (let i = 0; i < 36; i++) {
    const words = i % 9 < 6 ? (chants[i % 4] as string[]) : Array.from({ length: 5 }, () => pick(r, BANK));
    lines.push({ gap: 400 + Math.floor(r() * 400), words: join(words).map((w) => [w, 190 + Math.floor(r() * 80)]) });
  }
  const { lrc, end } = enhancedLrc(lines, 16_000);
  return build("club remix chant", {
    title: "Voltage (Club Mix)",
    durationMs: end + 30_000,
    cover: swatchCover([["#050505", 0.5], ["#ff2bd6", 0.25], ["#b6ff2b", 0.25]]),
    lyrics: { status: "found", synced: lrc, plain: null },
  });
}

// ── acoustic diary: line-timed, unhurried, short lines, warm light cover
function acousticDiary(): Built {
  const r = rng(17);
  const lines: SungLine[] = [];
  for (let i = 0; i < 22; i++) {
    const words = Array.from({ length: 4 + Math.floor(r() * 3) }, () => pick(r, SOFT));
    lines.push({ gap: 900 + Math.floor(r() * 1500), words: join(words).map((w) => [w, 520 + Math.floor(r() * 300)]) });
  }
  const { lrc, end } = lineLrc(lines, 10_000);
  return build("acoustic diary", {
    title: "Kitchen Radio (Acoustic)",
    durationMs: end + 12_000,
    cover: swatchCover([["#f2e6d0", 0.5], ["#d9a36a", 0.3], ["#8a5a3a", 0.2]]),
    lyrics: { status: "found", synced: lrc, plain: null },
  });
}

// ── bright pop: mid-tempo, word-timed, a chorus three times, bright warm cover
function brightPop(): Built {
  const r = rng(29);
  const chorus = [0, 1, 2, 3].map(() => Array.from({ length: 6 }, () => pick(r, [...SOFT, ...BANK])));
  const lines: SungLine[] = [];
  for (let i = 0; i < 40; i++) {
    const words = i % 12 >= 8 ? (chorus[i % 4] as string[]) : Array.from({ length: 6 + Math.floor(r() * 2) }, () => pick(r, [...SOFT, ...BANK]));
    lines.push({ gap: 500 + Math.floor(r() * 900), words: join(words).map((w) => [w, 230 + Math.floor(r() * 120) + (w.length > 5 ? 90 : 0)]) });
  }
  const { lrc, end } = enhancedLrc(lines, 12_000);
  return build("bright pop", {
    title: "Lemonade Static",
    durationMs: end + 15_000,
    cover: swatchCover([["#ffd23f", 0.4], ["#ff6b3d", 0.3], ["#3dd6ff", 0.2], ["#ffffff", 0.1]]),
    lyrics: { status: "found", synced: lrc, plain: null },
  });
}

// ── Vietnamese ballad: lines with stacked diacritics, line-timed, slow
const VI = ["Đèn phố nhỏ vẫn đợi người về", "Mưa rơi trên mái hiên chiều", "Gió đưa câu hát qua sông", "Thuyền giấy trôi về phía biển", "Ánh trăng nghiêng bên khung cửa", "Lời ru còn ấm trong tay"];
function vietnameseBallad(): Built {
  const lines: SungLine[] = Array.from({ length: 18 }, (_, i) => ({
    gap: 2000 + (i % 3) * 700,
    words: join((VI[i % VI.length] as string).split(" ")).map((w, k, all): [string, number] => [w, k === all.length - 1 ? 1600 : 520]),
  }));
  const { lrc, end } = lineLrc(lines, 12_000);
  return build("Vietnamese ballad", {
    title: "Thuyền Giấy",
    durationMs: end + 15_000,
    cover: swatchCover([["#2b2f3a", 0.6], ["#5a6577", 0.3], ["#d8c9a8", 0.1]]),
    lyrics: { status: "found", synced: lrc, plain: null },
  });
}

// ── Cyrillic mid-tempo: Russian lines, line-timed
const RU = ["Город не спит этой ночью", "Свет фонарей на воде", "Мы бежим по мокрым крышам", "Ветер знает наши имена", "Сердце бьётся в такт трамваю"];
function cyrillicSong(): Built {
  const lines: SungLine[] = Array.from({ length: 30 }, (_, i) => ({
    gap: 600 + (i % 4) * 200,
    words: join((RU[i % RU.length] as string).split(" ")).map((w) => [w, 330]),
  }));
  const { lrc, end } = lineLrc(lines, 9000);
  return build("Cyrillic mid-tempo", {
    title: "Ночной трамвай",
    durationMs: end + 15_000,
    cover: swatchCover([["#101820", 0.5], ["#2a4a6a", 0.3], ["#e04848", 0.2]]),
    lyrics: { status: "found", synced: lrc, plain: null },
  });
}

// ── cold electronic: steady mid-tempo, word-timed, short lines, cyan/violet neon on black
function coldElectronic(): Built {
  const r = rng(31);
  const lines: SungLine[] = [];
  for (let i = 0; i < 32; i++) {
    const words = Array.from({ length: 4 + Math.floor(r() * 2) }, () => pick(r, BANK));
    lines.push({ gap: 900 + Math.floor(r() * 600), words: join(words).map((w) => [w, 300 + Math.floor(r() * 60)]) });
  }
  const { lrc, end } = enhancedLrc(lines, 20_000);
  return build("cold electronic", {
    title: "Signal Loss",
    durationMs: end + 20_000,
    cover: swatchCover([["#06060c", 0.55], ["#20e3ff", 0.2], ["#7a2bff", 0.2], ["#ffffff", 0.05]]),
    lyrics: { status: "found", synced: lrc, plain: null },
  });
}

const SYNTHETIC: readonly (() => Built)[] = [
  rapVerse,
  slowBallad,
  sparseAmbient,
  denseCjkPop,
  plainOnly,
  clubRemix,
  acousticDiary,
  brightPop,
  vietnameseBallad,
  cyrillicSong,
  coldElectronic,
];

/** Every demo track, as the overlay would offer it once its lyrics and cover are in. */
function mockInputs(): Built[] {
  return MOCK_TRACKS.map((t) => {
    const lyrics = lyricsOf(t);
    const view = viewFor(lyrics, t.durationMs);
    const timeline = view.kind === "lyrics" ? view.timeline : null;
    return {
      name: `mock: ${t.title}`,
      lyrics,
      input: {
        track: { trackKey: trackKeyOf(t), title: t.title, album: t.album, durationMs: t.durationMs },
        lines: timeline?.lines ?? [],
        timing: timingOf(lyrics, timeline),
        cover: demoCover(t.cover),
      },
    };
  });
}

function looksOf(builds: readonly Built[]): Map<string, SongLook> {
  return new Map(builds.map((b) => [b.name, pickLook(songFeatures(b.input))]));
}

const face = (family: string) => FONTS.find((x) => x.family === family);
const MODES: readonly Mode[] = ["arc", "lens", "drift", "stack"];

// ───────────────────────────── tests ─────────────────────────────

describe("cover stats", () => {
  it("reads the three demo covers sensibly", () => {
    const [monsoon, jade, ultraviolet] = DEMO_COVERS;
    expect(monsoon?.lightness).toBeLessThan(0.35); // teal night
    expect(jade?.lightness).toBeGreaterThan(0.5); // cream paper, green hill
    expect(ultraviolet?.chroma).toBeGreaterThan(monsoon?.chroma ?? 1); // pink-violet glow, no neutral areas
    expect(ultraviolet?.warmth).toBeLessThan(jade?.warmth ?? -1);
  });

  it("calls a gray cover gray, with no hue and no warmth", () => {
    const gray = swatchCover([["#111111", 0.5], ["#777777", 0.3], ["#eeeeee", 0.2]]);
    expect(gray.gray).toBe(1);
    expect(gray.hue).toBeNull();
    expect(gray.warmth).toBe(0);
    expect(coverStats(new Uint8ClampedArray(16))).toBeNull(); // fully transparent
  });
});

describe("timing detection", () => {
  it("tells word tags from line stamps", () => {
    expect(hasWordTags("[00:01.00]<00:01.00>a <00:01.50>b\n[00:02.00]<00:02.00>c")).toBe(true);
    expect(hasWordTags("[00:01.00]a b\n[00:02.00]c\n[00:03.00]")).toBe(false);
    const lines = parseLrc("[00:01.00]a b\n[00:03.00]c d", 10_000);
    expect(timingOf({ synced: "[00:01.00]a b" }, { lines, unsynced: false })).toBe("line");
    expect(timingOf(null, pacePlain("a\nb", 10_000))).toBe("unsynced");
    expect(timingOf(null, null)).toBe("none");
  });
});

describe("mock tracks", () => {
  const builds = mockInputs();
  const looks = looksOf(builds);

  it("gives plain lyrics the calm list, with no word emphasis", () => {
    const look = looks.get("mock: Letters Never Sent");
    expect(look?.style).toBe("stack");
    expect(look?.emphasis).toBeNull();
    expect(look?.energy).toBeLessThanOrEqual(0.2);
  });

  it("never sets the script sampler in a face without Vietnamese, nor on a curve or lens", () => {
    const look = looks.get("mock: Script Sampler");
    expect(face(look?.font.family ?? "")?.vietnamese).toBe(true);
    expect(["stack", "drift"]).toContain(look?.style);
  });

  it("has a look for every track, lyrics or not", () => {
    for (const b of builds) expect(looks.get(b.name)?.reason.length, b.name).toBeGreaterThan(5);
    expect(looks.get("mock: Tidal Interlude")?.traits).toContain("no lyrics");
  });
});

describe("synthetic profiles", () => {
  const looks = looksOf(SYNTHETIC.map((make) => make()));
  const get = (name: string): SongLook => {
    const look = looks.get(name);
    if (!look) throw new Error(name);
    return look;
  };

  it("fast rap verse: a flat readable list in a sturdy grotesque, snappy and lively", () => {
    const look = get("fast rap verse");
    expect(look.style).toBe("stack");
    expect(look.font.family).toBe("Bricolage Grotesque");
    expect(look.energy).toBeGreaterThanOrEqual(0.6);
    expect(look.snap).toBeGreaterThanOrEqual(0.75);
  });

  it("slow ballad: Arc in a serif, only the longest notes emphasized", () => {
    const look = get("slow ballad, held notes");
    expect(look.style).toBe("arc");
    expect(face(look.font.family)?.serif).toBe(true);
    expect(look.emphasis?.minMs).toBeGreaterThanOrEqual(1100);
    expect(look.energy).toBeGreaterThanOrEqual(0.3); // synced songs always move
    expect(look.energy).toBeLessThanOrEqual(0.5);
  });

  it("sparse ambient: Drift, low energy", () => {
    const look = get("sparse ambient, long gaps");
    expect(look.style).toBe("drift");
    expect(look.energy).toBeLessThanOrEqual(0.45);
  });

  it("dense CJK pop: a list in a sans (Gothic) stack", () => {
    const look = get("dense CJK pop");
    expect(["stack", "lens"]).toContain(look.style);
    expect(face(look.font.family)?.serif).toBe(false);
  });

  it("plain-only: Stack, calm, no emphasis", () => {
    const look = get("plain-only lyrics");
    expect(look.style).toBe("stack");
    expect(look.emphasis).toBeNull();
    expect(look.energy).toBeLessThanOrEqual(0.2);
  });

  it("club remix: Lens in Unbounded capitals", () => {
    const look = get("club remix chant");
    expect(look.style).toBe("lens");
    expect(look.font.family).toBe("Unbounded");
    expect(look.textCase).toBe("upper");
  });

  it("acoustic diary: handwriting or a hairline serif, never a fast style", () => {
    const look = get("acoustic diary");
    expect(["Caveat", "Instrument Serif"]).toContain(look.font.family);
    expect(["arc", "drift"]).toContain(look.style);
  });

  it("bright pop: Lens in Syne", () => {
    const look = get("bright pop");
    expect(look.style).toBe("lens");
    expect(look.font.family).toBe("Syne");
  });

  it("Vietnamese: only faces with Vietnamese letters", () => {
    expect(face(get("Vietnamese ballad").font.family)?.vietnamese).toBe(true);
  });

  it("Cyrillic: only faces with Cyrillic letters", () => {
    expect(["Unbounded", "Caveat", "JetBrains Mono", "System"]).toContain(get("Cyrillic mid-tempo").font.family);
  });
});

describe("scripts the bundled faces don't all have", () => {
  const night = swatchCover([["#101820", 0.5], ["#2a4a6a", 0.3], ["#e0b048", 0.2]]);

  it("Greek: only faces with Greek letters, and the reason says why", () => {
    const greek = ["Χάρτινα φανάρια πάνω στο νερό", "Η θάλασσα θυμάται τα ονόματά μας", "Μετράμε τα φώτα στην απέναντι όχθη", "Ο άνεμος κρατά τη μελωδία", "Περιμένω το πρωί στο μπαλκόνι"];
    const f = songFeatures(lineTimed("Greek", "Φανάρια", greek, 20, 360, night).input);
    expect(f.script).toBe("greek");
    expect(f.greek).toBe(true);
    const look = pickLook(f);
    expect(face(look.font.family)?.greek).toBe(true);
    expect(look.traits[0]).toBe("Greek lyrics");
  });

  it("right-to-left and other scripts: the system face, the only one with their letters", () => {
    const rtl = ["الفوانيس تطفو فوق الماء", "הפנסים צפים על המים", "الريح تتذكر أسماءنا", "הרוח זוכרת את השמות שלנו", "نعدّ الأضواء في الليل", "אנחנו סופרים את האורות בלילה"];
    const rtlLook = pickLook(songFeatures(lineTimed("RTL", "Fawanees", rtl, 18, 380, night).input));
    expect(rtlLook.font.family).toBe("System");
    expect(rtlLook.traits[0]).toBe("right-to-left lyrics");
    const thai = ["โคมกระดาษลอยบนน้ำ", "ลมจำชื่อของเรา", "เรานับแสงไฟยามค่ำ", "ทะเลยังรอเราอยู่"];
    const f = songFeatures(lineTimed("Thai", "Khom", thai, 16, 900, night).input);
    expect(f.script).toBe("other");
    expect(pickLook(f).font.family).toBe("System");
  });

  it("Vietnamese written decomposed (NFD) is still Vietnamese", () => {
    // no đ, the one letter NFD leaves whole: every other Vietnamese letter decomposes into a base and marks
    const nfd = ["Mưa rơi trên mái hiên chiều", "Thuyền giấy trôi về phía biển", "Ánh trăng nghiêng bên khung cửa", "Lời ru còn ấm trong tay"].map((t) => t.normalize("NFD"));
    const f = songFeatures(lineTimed("NFD", "Mua", nfd, 16, 520, night).input);
    expect(f.vietnamese).toBe(true);
    expect(face(pickLook(f).font.family)?.vietnamese).toBe(true);
  });

  it("names the CJK language first, then the rest", () => {
    const ko = ["작은 불빛이 창문을 두드려요", "바다는 우리 이름을 기억해", "종이배가 강을 건너요"];
    expect(pickLook(songFeatures(lineTimed("Korean", "Bulbit", ko, 15, 300, night).input)).traits[0]).toBe("Korean lyrics");
    const zh = ["灯笼漂过安静的河面", "我们说好再见", "风记得我们的名字"];
    expect(pickLook(songFeatures(lineTimed("Chinese", "Denglong", zh, 15, 300, night).input)).traits[0]).toBe("Chinese lyrics");
  });
});

describe("determinism and stability", () => {
  it("picks the same look for the same song, every time", () => {
    for (const make of SYNTHETIC) {
      const b = make();
      const a = JSON.stringify(pickLook(songFeatures(b.input)));
      expect(JSON.stringify(pickLook(songFeatures(make().input)))).toBe(a);
    }
  });

  it("breaks near-ties by trackKey only: stable per key, varied across keys", () => {
    const base = brightPop().input;
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const input = { ...base, track: { ...base.track, trackKey: `synthetic|bright pop ${i}|profiles|99` } };
      const first = lookLabel(pickLook(songFeatures(input)));
      expect(lookLabel(pickLook(songFeatures(input)))).toBe(first);
      seen.add(`${first} ${pickLook(songFeatures(input)).curve}`);
    }
    expect(seen.size).toBeGreaterThan(1); // at least the curve wobble varies
    expect(stableHash("abc")).toBe(stableHash("abc"));
    expect(stableHash("abc")).not.toBe(stableHash("abd"));
    for (const key of ["", "a", "demo artist|neon monsoon|undertone demo|35"]) {
      expect(stableHash(key)).toBeGreaterThanOrEqual(0);
      expect(stableHash(key)).toBeLessThan(1);
    }
  });

  it("LookKeeper: provisional look before lyrics, replaced freely when they arrive", () => {
    const b = slowBallad();
    const keeper = new LookKeeper();
    expect(keeper.current).toBeNull();
    const loading = keeper.offer({ ...b.input, lines: [], timing: "none", cover: null });
    expect(loading.traits).toContain("no lyrics");
    expect(loading.reason).toMatch(/^no lyrics.* → [A-Z]/u);
    const withLyrics = keeper.offer(b.input);
    expect(withLyrics.style).toBe("arc");
    expect(keeper.current).toBe(withLyrics);
    expect(keeper.waiting).toBe(false);
  });

  it("LookKeeper: a provisional look keeps the better of two lyric-less offers", () => {
    const b = slowBallad();
    const keeper = new LookKeeper();
    const withCover = keeper.offer({ ...b.input, lines: [], timing: "none", cover: demoCover(0) });
    expect(keeper.offer({ ...b.input, lines: [], timing: "none", cover: null })).toBe(withCover);
  });

  it("LookKeeper: late artwork refines once, at the next safe point", () => {
    const b = brightPop();
    const keeper = new LookKeeper();
    const first = keeper.offer({ ...b.input, cover: null });
    const after = keeper.offer(b.input);
    expect(after).toBe(first); // nothing changes mid-line
    expect(keeper.waiting).toBe(true);
    const settled = keeper.settle();
    expect(lookLabel(first)).toBe("Lens · Bricolage");
    expect(settled && lookLabel(settled)).toBe("Lens · Syne");
    expect(keeper.current).toBe(settled);
    // a second upgrade is ignored: one refinement per song
    expect(keeper.offer({ ...b.input, cover: demoCover(2) })).toBe(settled);
    expect(keeper.waiting).toBe(false);
    expect(keeper.settle()).toBeNull();
  });

  it("LookKeeper: plain lyrics upgraded to synced ones refine the look once, at a safe point", () => {
    const synced = brightPop();
    const plain = build("bright pop, plain first", {
      title: "Lemonade Static",
      durationMs: synced.input.track.durationMs,
      cover: synced.input.cover,
      lyrics: { status: "plain-only", synced: null, plain: synced.input.lines.filter((l) => l.words.length > 0).map((l) => l.text).join("\n") },
    });
    const keeper = new LookKeeper();
    const first = keeper.offer({ ...plain.input, track: synced.input.track });
    expect(first.style).toBe("stack");
    expect(keeper.offer(synced.input)).toBe(first); // still the calm list until the stage says it's safe
    expect(keeper.waiting).toBe(true);
    const refined = keeper.settle();
    expect(refined?.style).toBe("lens");
  });

  it("LookKeeper: better information that changes nothing on screen is taken quietly", () => {
    const b = rapVerse();
    const keeper = new LookKeeper();
    const first = keeper.offer({ ...b.input, cover: null });
    // a cover that reads exactly like none: neutral vivid (0.4), lightness 0.45, warmth 0, half gray
    const neutral: CoverStats = { lightness: 0.45, contrast: 0.08, chroma: 0.08, colorfulness: 0.4 / 0.55, warmth: 0, gray: 0.5, hue: null };
    expect(keeper.offer({ ...b.input, cover: neutral })).toBe(first);
    expect(keeper.waiting).toBe(false);
    expect(keeper.settle()).toBeNull();
    // that cover was the news; the real one now tells nothing new
    expect(keeper.offer(b.input)).toBe(first);
    expect(keeper.waiting).toBe(false);
  });

  it("reads version tags from the title, and only unambiguous ones from the album", () => {
    expect(hintsOf("Harbor Light (Piano Version)", "x")).toContain("intimate");
    expect(hintsOf("Song (Demo)", "x")).toContain("intimate");
    expect(hintsOf("Neon Monsoon", "Undertone Demo")).toEqual([]);
    expect(hintsOf("Live Forever", "x")).toEqual([]);
    expect(hintsOf("Live Forever - Live at the Harbor", "x")).toContain("live");
    expect(hintsOf("Voltage (Club Mix)", "x")).toContain("dance");
    expect(hintsOf("Tidewater (Slowed + Reverb)", "x")).toContain("dreamy");
    expect(hintsOf("Song", "MTV Unplugged")).toContain("intimate");
  });

  it("LookKeeper: the same information again changes nothing; a new track starts over", () => {
    const keeper = new LookKeeper();
    const a = keeper.offer(rapVerse().input);
    expect(keeper.offer(rapVerse().input)).toBe(a);
    expect(keeper.waiting).toBe(false);
    const b = keeper.offer(slowBallad().input);
    expect(b.style).toBe("arc");
  });

  it("ranks information by timing first, then the cover", () => {
    const ranks = (["none", "unsynced", "line", "word"] as const).flatMap((timing) => [
      qualityOf({ timing, cover: null }),
      qualityOf({ timing, cover: demoCover(0) }),
    ]);
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});

describe("the look as the stage takes it", () => {
  /** PickedLook in src/overlay/look.ts, restated: every SongLook must be one. */
  interface PickedLook {
    style: Mode;
    font: { family: string; weight: number };
    curve: number;
    energy: number;
    snap: number;
    glow: number;
    emphasis: { minMs: number; maxChars: number; lastWordOnly: boolean } | null;
    scale: number;
    letterSpacing: number;
    textCase: "as-is" | "upper";
  }
  type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

  it("is a PickedLook, with the emphasis rule's exact shape", () => {
    const exact: Same<EmphasisRule, { minMs: number; maxChars: number; lastWordOnly: boolean }> = true;
    const picked: PickedLook = pickLook(songFeatures(brightPop().input));
    expect(exact).toBe(true);
    expect(MODES).toContain(picked.style);
    expect(face(picked.font.family)?.weight).toBe(picked.font.weight);
  });

  it("labels a look by style and face, keeping an unknown family's own name", () => {
    expect(lookLabel({ style: "lens", font: { family: "Bricolage Grotesque", weight: 700 } })).toBe("Lens · Bricolage");
    expect(lookLabel({ style: "drift", font: { family: "Comic Neue", weight: 400 } })).toBe("Drift · Comic Neue");
  });

  it("reads a song with an unknown duration up to the end of its last line", () => {
    const b = slowBallad();
    const lyric = b.input.lines.filter((l) => l.words.length > 0);
    const f = songFeatures({ ...b.input, track: { ...b.input.track, durationMs: Number.NaN } });
    expect(f.durationMs).toBe(lyric[lyric.length - 1]?.end);
    expect(f.instrumental).toBeGreaterThan(0);
  });
});

describe("legibility invariants over a feature grid", () => {
  const base = songFeatures(brightPop().input);
  const covers: (CoverStats | null)[] = [null, ...DEMO_COVERS, swatchCover([["#111111", 1]]), swatchCover([["#ffd23f", 0.6], ["#ff2bd6", 0.4]])];
  const grid: SongFeatures[] = [];
  for (const timing of ["word", "line", "unsynced"] as const)
    for (const rate of [1.6, 3, 4.5, 6, 8])
      for (const width of [[14, 20], [26, 34], [40, 60], [70, 110]] as const)
        for (const held of [0, 0.1, 0.3])
          for (const repetition of [0, 0.4, 0.8])
            for (const extras of [{}, { vietnamese: true }, { cyrillic: true }, { shout: 0.5 }, { instrumental: 0.7, longestGapMs: 25_000 }] as const)
              for (const cover of covers)
                grid.push({
                  ...base,
                  trackKey: `grid|${grid.length}`,
                  timing,
                  rate,
                  widthMedian: width[0],
                  widthP90: width[1],
                  held,
                  repetition,
                  cover,
                  wordMsP90: timing === "word" ? 600 + held * 3000 : null,
                  ...extras,
                });

  it(`holds on all ${3 * 5 * 4 * 3 * 3 * 5 * 6} combinations`, () => {
    for (const f of grid) {
      const look = pickLook(f);
      const fc = face(look.font.family);
      if (f.vietnamese) expect(fc?.vietnamese).toBe(true);
      if (f.cyrillic) expect(fc?.cyrillic).toBe(true);
      if (look.font.family === "Unbounded") expect(f.widthP90).toBeLessThanOrEqual(38);
      if (look.font.family === "Caveat") expect(f.widthMedian).toBeLessThanOrEqual(36);
      if (f.timing === "unsynced") {
        expect(look.style).toBe("stack");
        expect(look.emphasis).toBeNull();
        expect(look.energy).toBeLessThanOrEqual(0.2);
      }
      if (f.widthP90 >= 100) expect(["arc", "lens"]).not.toContain(look.style);
      expect(look.energy).toBeGreaterThanOrEqual(f.timing === "unsynced" ? 0.2 : 0.3);
      expect(look.energy).toBeLessThanOrEqual(1);
      expect(Math.abs(look.curve)).toBeLessThanOrEqual(100);
      expect(look.scale).toBeGreaterThanOrEqual(0.82);
      expect(look.scale).toBeLessThanOrEqual(1.2);
      expect(look.glow).toBeGreaterThanOrEqual(0.3);
      expect(look.glow).toBeLessThanOrEqual(1);
    }
  });

  it("never picks anything but the contract's four modes", () => {
    expect(CONTRACT_STYLES).toEqual(MODES);
    const looks = [...grid.map((f) => pickLook(f)), ...looksOf([...SYNTHETIC.map((make) => make()), ...mockInputs()]).values()];
    const picked = new Set<string>();
    for (const look of looks) {
      expect(MODES).toContain(look.style);
      expect(Object.keys(look.scores.style).sort()).toEqual([...MODES].sort());
      picked.add(look.style);
    }
    expect([...picked].sort()).toEqual([...MODES].sort()); // and every one of them gets picked somewhere
  });
});

describe("cost", () => {
  it("features + pick for a long word-timed song cost a few milliseconds at most, once per track", () => {
    const input = rapVerse().input; // 48 lines, ~650 words
    const medians: number[] = [];
    for (let run = 0; run < 3; run++) {
      const times: number[] = [];
      for (let i = 0; i < 60; i++) {
        const t0 = performance.now();
        pickLook(songFeatures(input));
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      medians.push(times[Math.floor(times.length / 2)] ?? 0);
    }
    medians.sort((a, b) => a - b);
    expect(medians[1]).toBeLessThan(20);
  });
});
