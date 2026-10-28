import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../contract/contract";
import { hookLines, HELD_SPLASH_MS, MOVES, PLAIN_FLAIR, planDecor, saneFlair, SPLASH_GAP_MS, SPLASHES, themesOf, type Flair, type Move } from "../src/core/flair";
import { parseLrc, type Line, type Word } from "../src/core/lrc";
import { pickLook, songFeatures, type SongInput } from "../src/core/songlook";
import { cleanOverride, DEFAULT_PICK, mergeOverrides, parseFlairOverride, resolveLook, withOverride } from "../src/overlay/look";
import { picturesOf, planSplash, reachOf, songDecor, splashUntil } from "../src/overlay/motion/decor";
import { fullTransform, planWord, restTransform, FULL_TRANSFORM, type WordShape } from "../src/overlay/motion/karaoke";
import { LineMoves, motionParams, moveTuning, paramsKey, BL_INPUT, BL_REFERENCE, type MotionInput } from "../src/overlay/motion/params";
import glacier from "./fixtures/demo-glacier-nocturne.lrc?raw";
import strobe from "./fixtures/demo-strobe-hearts.lrc?raw";

/** A line of words, each `each` ms long, from `start`. */
function line(text: string, start = 0, each = 400): Line {
  const parts = text.split(" ");
  const words: Word[] = parts.map((w, i) => ({ text: i < parts.length - 1 ? `${w} ` : w, start: start + i * each, end: start + (i + 1) * each }));
  return { start, end: start + parts.length * each, words, text };
}

const FLAIR: Flair = { move: "bounce", accent: "pulse", splash: "drops" };
const RULE = { minMs: 1000, maxChars: 12, lastWordOnly: false };

/** The last item of a list (the tests' TypeScript target predates Array.prototype.at). */
const last = <T>(list: readonly T[]): T | undefined => list[list.length - 1];

describe("what a song's words are about", () => {
  it("counts the share of lyric lines that mention each theme, gaps left out", () => {
    const lines = [line("rain on the window"), line("tears and thunder"), { start: 0, end: 1, words: [], text: "" }, line("stars over the party"), line("plain words")];
    expect(themesOf(lines)).toEqual({ water: 0.5, fire: 0, party: 0.25, night: 0.25 });
    expect(themesOf([])).toEqual({ water: 0, fire: 0, party: 0, night: 0 });
  });
});

describe("a song's hooks", () => {
  it("are the lines it sings more than once, word for word or nearly", () => {
    const lines = [
      line("Hold on to the light tonight"),
      line("Something else entirely"),
      line("hold on, to the light tonight!"),
      line("Hold on to the light tonight now"),
      line("Once only"),
    ];
    expect([...hookLines(lines)].sort()).toEqual([0, 2, 3]);
  });

  it("needs three words for a near repeat; short lines must repeat exactly", () => {
    expect([...hookLines([line("oh no"), line("oh yes"), line("oh no")])].sort()).toEqual([0, 2]);
  });
});

describe("a song's decor, line by line", () => {
  it("is nothing without a flair, or with Text effects and Graphics both off: every line rises", () => {
    for (const decor of [planDecor([line("rain rain rain"), line("fire")], null, RULE), planDecor([line("rain rain rain"), line("fire")], FLAIR, RULE, { text: false, graphics: false })]) {
      expect(decor.map((d) => [d.move, d.hook, d.words.size])).toEqual([
        ["rise", false, 0],
        ["rise", false, 0],
      ]);
    }
  });

  it("moves without pictures or splashes with Graphics off, and shows them on rising words with Text effects off", () => {
    const lines = [line("roses on the roof", 0), line("a verse goes by", 5000), line("roses on the roof", 10_000)];
    const text = planDecor(lines, FLAIR, RULE, { text: true, graphics: false });
    expect(text.map((d) => d.move)).toEqual(["pulse", "bounce", "pulse"]);
    expect(text.every((d) => d.words.size === 0)).toBe(true);
    const graphics = planDecor(lines, FLAIR, RULE, { text: false, graphics: true });
    expect(graphics.map((d) => d.move)).toEqual(["rise", "rise", "rise"]);
    expect(graphics[0]?.words.get(0)?.picture).toBe("rose");
    expect(graphics.some((d) => [...d.words.values()].some((w) => w.splash))).toBe(true);
  });

  it("keeps the splashes and the scenes but no pictures for a style whose words are stacked (pictures: false)", () => {
    const lines = [line("roses on the roof", 0), line("a verse goes by", 5000), line("roses on the roof", 10_000), line("set the night on fire", 15_000)];
    const stacked = planDecor(lines, FLAIR, RULE, { text: true, graphics: true, pictures: false });
    expect(stacked.map((d) => d.move)).toEqual(["pulse", "bounce", "pulse", "bounce"]);
    expect(stacked.every((d) => [...d.words.values()].every((w) => !w.picture))).toBe(true);
    expect(stacked.some((d) => [...d.words.values()].some((w) => w.splash))).toBe(true);
    expect(stacked[3]?.words.get(4)?.scene).toBe("fire");
    expect(planDecor(lines, FLAIR, RULE, { text: true, graphics: true, pictures: true })[0]?.words.get(0)?.picture).toBe("rose");
  });

  it("moves hooks with the accent and the rest with the move", () => {
    const lines = [line("we sing the chorus here", 0), line("a verse goes by", 5000), line("we sing the chorus here", 10_000)];
    expect(planDecor(lines, FLAIR, RULE).map((d) => d.move)).toEqual(["pulse", "bounce", "pulse"]);
  });

  it("splashes a held note, and the last word of a hook or a shouted line, at most one a line, SPLASH_GAP_MS apart", () => {
    const held = line("a long note held", 0);
    const long = held.words[1] as Word;
    long.end = long.start + HELD_SPLASH_MS + 200;
    const lines = [held, line("Hands up!", 1000), line("Jump around now!", SPLASH_GAP_MS + 500), line("QUIET NOW LOUD", 2 * SPLASH_GAP_MS + 1000)];
    const splashes = planDecor(lines, FLAIR, null).map((d) => [...d.words.entries()].filter(([, w]) => w.splash).map(([i, w]) => `${i}:${w.splash}`));
    expect(splashes).toEqual([["1:drops"], [], ["2:drops"], ["2:drops"]]);
  });

  it("follows the song's held-note rule, and never splashes a guessed word time", () => {
    const lines = [line("one two three", 0, 900), { ...line("four five six", 10_000, 1500), estimated: true }];
    // 900 ms words: held under a 800 ms rule, not under the default
    expect(planDecor(lines, FLAIR, { ...RULE, minMs: 800 })[0]?.words.get(0)?.splash).toBe("drops");
    expect(planDecor(lines, FLAIR, RULE)[0]?.words.size).toBe(0);
    // a line lit as a whole has no real word times: long "words" there don't splash
    expect(planDecor(lines, FLAIR, RULE)[1]?.words.size).toBe(0);
    // lastWordOnly: only the last word counts
    expect([...(planDecor(lines, FLAIR, { minMs: 800, maxChars: 12, lastWordOnly: true })[0]?.words.keys() ?? [])]).toEqual([2]);
  });

  it("puts the planned pictures on their words, next to any splash", () => {
    const roses = line("Here come the roses!", 0);
    const decor = planDecor([roses], { ...FLAIR, splash: "sparks" }, RULE);
    expect(decor[0]?.words.get(3)).toEqual({ picture: "rose", splash: "sparks" });
    // a word of rain becomes its scene instead, next to its splash
    const rain = line("Here comes the rain!", 0);
    expect(planDecor([rain], { ...FLAIR, splash: "sparks" }, RULE)[0]?.words.get(3)).toEqual({ scene: "rain", splash: "sparks" });
  });
});

describe("a song's flair, as the look picks it", () => {
  const input = (raw: string, title: string, timing: SongInput["timing"] = "word"): SongInput => ({
    track: { trackKey: `demo|${title}|x|100`.toLowerCase(), title, album: "Undertone Demo", durationMs: 100_000 },
    lines: parseLrc(raw, 100_000),
    timing,
    cover: null,
  });

  it("is a valid move, a different accent and a splash, the same every time", () => {
    for (const raw of [glacier, strobe]) {
      const f = songFeatures(input(raw, "Song"));
      const { flair } = pickLook(f);
      expect(MOVES).toContain(flair.move);
      expect(MOVES).toContain(flair.accent);
      expect(flair.accent).not.toBe(flair.move);
      expect(SPLASHES).toContain(flair.splash);
      expect(pickLook(songFeatures(input(raw, "Song"))).flair).toEqual(flair);
    }
  });

  it("follows what the words are about: a party song throws confetti, a slow cold one ripples or glints", () => {
    expect(pickLook(songFeatures(input(strobe, "Strobe Hearts (Club Mix)"))).flair.splash).toBe("confetti");
    expect(["ripple", "glints", "drops"]).toContain(pickLook(songFeatures(input(glacier, "Glacier Nocturne"))).flair.splash);
  });

  it("gives words without timing no flair of their own", () => {
    expect(pickLook(songFeatures(input(glacier, "Glacier Nocturne", "unsynced"))).flair).toEqual(PLAIN_FLAIR);
    expect(pickLook(songFeatures({ ...input("", "Nothing", "none"), lines: [] })).flair).toEqual(PLAIN_FLAIR);
  });

  it("varies between songs: not every song floats up", () => {
    const moves = new Set<Move>();
    for (let i = 0; i < 24; i++) moves.add(pickLook(songFeatures(input(glacier, `Take ${i}`))).flair.move);
    for (let i = 0; i < 24; i++) moves.add(pickLook(songFeatures(input(strobe, `Mix ${i}`))).flair.move);
    expect(moves.size).toBeGreaterThanOrEqual(3);
  });

  it("is made safe to draw", () => {
    expect(saneFlair({ move: "spin" as Move, accent: "drop", splash: "smoke" as Flair["splash"] })).toEqual({ move: "rise", accent: "drop", splash: "ripple" });
    expect(saneFlair(null)).toEqual(PLAIN_FLAIR);
  });
});

describe("each move's motion", () => {
  const input = (move: Move): MotionInput => ({ ...BL_INPUT, move });

  it("rise is the house motion, and an absent move is rise", () => {
    expect(motionParams(BL_INPUT).move).toBe("rise");
    expect(motionParams(input("rise"))).toEqual(motionParams(BL_INPUT));
    expect(motionParams(BL_INPUT).restScale).toBe(BL_REFERENCE.restScale);
  });

  it("reshapes the pop: bounce rests on the line, drop waits above it, pulse never lifts, wave hops its letters, sway tilts", () => {
    const rise = motionParams(input("rise"));
    const bounce = motionParams(input("bounce"));
    const drop = motionParams(input("drop"));
    const pulse = motionParams(input("pulse"));
    const wave = motionParams(input("wave"));
    const sway = motionParams(input("sway"));
    expect(bounce.restLift).toBe(0);
    expect(Math.min(...bounce.liftKeys.map(([, y]) => y))).toBeLessThan(Math.min(...rise.liftKeys.map(([, y]) => y)));
    expect(drop.restLift).toBeLessThan(0);
    expect(pulse.liftKeys.every(([, y]) => y === 0)).toBe(true);
    expect(pulse.rippleHeight).toBe(0);
    expect(Math.max(...pulse.scaleKeys.map(([, s]) => s))).toBeGreaterThan(Math.max(...rise.scaleKeys.map(([, s]) => s)));
    expect(wave.rippleHeight).toBeGreaterThan(rise.rippleHeight);
    expect(sway.swayDeg).toBeGreaterThan(0);
    for (const p of [rise, bounce, drop, pulse, wave]) expect(p.swayDeg).toBe(0);
    // every move is still: the same keys, and a different paramsKey each
    expect(new Set(MOVES.map((m) => paramsKey(motionParams(input(m))))).size).toBe(MOVES.length);
  });

  it("holds every move still without motion", () => {
    for (const m of MOVES) {
      const still = moveTuning(m, 0, 1);
      expect(still.restLift, m).toBeCloseTo(0, 12);
      expect(still.restScale, m).toBe(1);
      expect(still.rippleHeight, m).toBe(0);
      expect(still.swayDeg, m).toBe(0);
      expect(motionParams({ ...input(m), motion: false }).amp, m).toBe(0);
    }
  });

  it("tilts a swaying word to alternate sides, in one transform list from rest to rest", () => {
    const sway = motionParams(input("sway"));
    const shape: WordShape = { width: 100, size: 58, rtl: false, letters: [0, 1, 2, 3].map((i) => ({ text: "word"[i] ?? "", x: i * 25, w: 25, part: 0 })) };
    const word = { start: 1000, end: 1600 };
    const tilts = (index: number): number[] =>
      (planWord(word, "word", shape, sway, { index }).pop?.frames ?? []).map((f) => Number(/rotate\((-?[\d.]+)deg\)/.exec(String(f.transform))?.[1] ?? Number.NaN));
    const even = tilts(0);
    const odd = tilts(1);
    expect(even.every(Number.isFinite)).toBe(true);
    expect(Math.max(...even)).toBeGreaterThan(1);
    expect(Math.min(...odd)).toBeLessThan(-1);
    expect(last(even)).toBe(0);
    expect(restTransform(58, sway)).toMatch(/^translate\(0px, [\d.]+px\) rotate\(0deg\) scale\([\d.]+\)$/);
    expect(fullTransform(sway)).toBe("translate(0px, 0px) rotate(0deg) scale(1)");
    expect(fullTransform(motionParams(input("bounce")))).toBe(FULL_TRANSFORM);
    // other moves keep the house transform list
    expect(String(planWord(word, "word", shape, motionParams(input("bounce"))).pop?.frames[0]?.transform)).not.toContain("rotate");
  });

  it("works each line's parameters out once per move, and keeps Lens's swell to rise's", () => {
    const look = { ...BL_INPUT };
    const base = motionParams(look);
    const moves = new LineMoves();
    expect(moves.paramsFor(look, base, "rise")).toBe(base);
    const bounce = moves.paramsFor(look, base, "bounce");
    expect(bounce.move).toBe("bounce");
    expect(moves.paramsFor(look, base, "bounce")).toBe(bounce);
    // new song parameters (Effects moved): worked out again
    const louder = motionParams({ ...look, effects: 90 });
    expect(moves.paramsFor(look, louder, "bounce")).not.toBe(bounce);
    const lens = new LineMoves({ riseSwell: true }).paramsFor(look, base, "pulse");
    expect(lens.scaleKeys).toEqual(base.scaleKeys);
    expect(lens.liftKeys).toEqual(motionParams({ ...look, move: "pulse" }).liftKeys);
  });
});

describe("a splash", () => {
  it("bursts every kind into pieces that start unseen and end gone", () => {
    for (const kind of SPLASHES) {
      const pieces = planSplash(kind, 2000, 58, 120, 1.5, 42);
      expect(pieces.length, kind).toBeGreaterThan(0);
      for (const p of pieces) {
        expect(p.track.t0, kind).toBeGreaterThanOrEqual(2000);
        expect(p.track.frames[0]?.opacity, kind).toBe("0");
        expect(Number(last(p.track.frames)?.opacity), kind).toBeLessThan(0.05);
        expect(p.w > 0 && p.h > 0, kind).toBe(true);
        for (const f of p.track.frames) expect(String(f.transform)).toMatch(/^translate\(.+px, .+px\) rotate\(.+deg\) scale\(.+, .+\)$/);
      }
      expect(splashUntil(pieces), kind).toBeLessThan(2000 + 2000);
    }
  });

  it("is the same for the same word every time, and different for another", () => {
    expect(planSplash("confetti", 0, 58, 100, 1, 7)).toEqual(planSplash("confetti", 0, 58, 100, 1, 7));
    expect(planSplash("confetti", 0, 58, 100, 1, 8)).not.toEqual(planSplash("confetti", 0, 58, 100, 1, 7));
  });

  it("is nothing without motion, and reaches further for livelier songs", () => {
    for (const kind of SPLASHES) expect(planSplash(kind, 0, 58, 100, 0, 1)).toEqual([]);
    expect(reachOf(0)).toBe(0);
    expect(reachOf(2.5)).toBeGreaterThan(reachOf(1));
  });
});

describe("a mode's decor for a song", () => {
  const lines = [line("roses on the roof", 0), line("roses again later", 30_000)];
  const look = (over: Partial<Parameters<typeof songDecor>[1]> = {}): Parameters<typeof songDecor>[1] => ({ effectsMode: true, graphics: true, flair: FLAIR, unsynced: false, power: "full", emphasis: RULE, ...over });

  it("plans pictures and splashes with Graphics on, and fetches the pictures ahead", () => {
    const decor = songDecor(lines, look());
    expect(decor.map((d) => d.words.get(0)?.picture)).toEqual(["rose", "rose"]);
    expect(picturesOf(decor)).toEqual(["rose"]);
  });

  it("plans no pictures with Graphics off or for a mode whose words are stacked, and nothing for plain lyrics or in the lite tier", () => {
    expect(picturesOf(songDecor(lines, look({ graphics: false })))).toEqual([]);
    expect(picturesOf(songDecor(lines, look({ pictures: false })))).toEqual([]);
    expect(songDecor(lines, look({ pictures: false })).map((d) => d.move)).toEqual(songDecor(lines, look()).map((d) => d.move));
    expect(picturesOf(songDecor(lines, look({ effectsMode: false })))).toEqual(["rose"]);
    for (const over of [{ effectsMode: false, graphics: false }, { unsynced: true }, { power: "lite" as const }]) {
      const decor = songDecor(lines, look(over));
      expect(decor.every((d) => d.move === "rise" && d.words.size === 0)).toBe(true);
      expect(picturesOf(decor)).toEqual([]);
    }
  });
});

describe("forcing a flair for QA (?flair=)", () => {
  it("parses move[,accent[,splash]], an accent left out following the move", () => {
    expect(parseFlairOverride("bounce")).toEqual({ flair: { move: "bounce", accent: "bounce" } });
    expect(parseFlairOverride("Sway,Pulse,Confetti")).toEqual({ flair: { move: "sway", accent: "pulse", splash: "confetti" } });
    expect(parseFlairOverride(",,drops")).toEqual({ flair: { splash: "drops" } });
    expect(parseFlairOverride("spin,,smoke")).toBeNull();
    expect(parseFlairOverride(null)).toBeNull();
  });

  it("merges with ?look= and replaces only the parts it names", () => {
    const merged = mergeOverrides({ style: "lens" }, parseFlairOverride(",,glints"));
    expect(merged).toEqual({ style: "lens", flair: { splash: "glints" } });
    const pick = withOverride({ ...DEFAULT_PICK, flair: { move: "sway", accent: "rise", splash: "drops" } }, merged);
    expect(pick.style).toBe("lens");
    expect(pick.flair).toEqual({ move: "sway", accent: "rise", splash: "glints" });
    expect(cleanOverride({ flair: { move: "spin" as Move } })).toBeNull();
    const drawn = resolveLook(structuredClone(DEFAULT_SETTINGS), null, { width: 1920, height: 1080, dpr: 1, motion: true, unsynced: false }, pick);
    expect(drawn.flair).toEqual(pick.flair);
  });
});
