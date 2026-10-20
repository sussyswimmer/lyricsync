import { describe, expect, it } from "vitest";
import type { Line, Word } from "../src/core/lrc";
import { planPictures } from "../src/core/wordpics";
import { planScenes, SAME_SCENE_GAP_MS, SCENE_GAP_MS, SCENE_IDS, sceneWords, scenesIn, type SceneId } from "../src/core/wordscenes";
import type { Track } from "../src/overlay/motion/karaoke";
import { planScene, SCENE_COLORS, type SceneBox } from "../src/overlay/motion/scenes";

/** A line of these words, 400 ms each from `start`. */
function line(text: string, start = 0): Line {
  const words: Word[] = text.split(" ").map((w, i, all) => ({ text: i < all.length - 1 ? `${w} ` : w, start: start + 400 * i, end: start + 400 * (i + 1) }));
  return { start, end: start + 400 * words.length, words, text };
}

const BOX: SceneBox = { w: 180, size: 58, baseline: 46 };
const AMP = 1;

/** A track's transform and opacity at song time `t`, linear between keyframes (held at the ends). */
function at(track: Track, t: number): { x: number; y: number; deg: number; sx: number; sy: number; opacity: number } {
  const read = (f: Keyframe): number[] => {
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) rotate\((-?[\d.]+)deg\) scale\((-?[\d.]+), (-?[\d.]+)\)/u.exec(String(f.transform));
    return [...[1, 2, 3, 4, 5].map((i) => Number(m?.[i] ?? 0)), Number(f.opacity ?? 0)];
  };
  const u = Math.min(1, Math.max(0, (t - track.t0) / track.duration));
  const frames = track.frames;
  let i = 0;
  while (i + 1 < frames.length && Number(frames[i + 1]?.offset) <= u) i++;
  const a = read(frames[i] as Keyframe);
  const next = frames[i + 1];
  const b = next ? read(next) : a;
  const o0 = Number(frames[i]?.offset);
  const o1 = next ? Number(next.offset) : o0;
  const p = o1 > o0 ? (u - o0) / (o1 - o0) : 0;
  const v = a.map((x, c) => x + ((b[c] ?? x) - x) * p);
  return { x: v[0] ?? 0, y: v[1] ?? 0, deg: v[2] ?? 0, sx: v[3] ?? 1, sy: v[4] ?? 1, opacity: v[5] ?? 0 };
}

describe("which words become a scene (wordscenes.ts)", () => {
  it("knows each scene by its words, each word calling one scene", () => {
    const seen = new Map<string, SceneId>();
    for (const id of SCENE_IDS) {
      expect(sceneWords(id).length, id).toBeGreaterThan(4);
      for (const word of sceneWords(id)) {
        expect(seen.get(word), word).toBeUndefined();
        seen.set(word, id);
      }
    }
  });

  it("matches sung words whatever their case or punctuation, and a phrase on its last word", () => {
    expect(scenesIn(line("Set the night on fire!"))).toEqual([{ word: 4, id: "fire" }]);
    expect(scenesIn(line("Sunrise over the bay"))).toEqual([{ word: 0, id: "sun" }]);
    expect(scenesIn(line("Under the MOONLIGHT, we stay"))).toEqual([{ word: 2, id: "moon" }]);
    expect(scenesIn(line("snow and rain and gold"))).toEqual([
      { word: 0, id: "snow" },
      { word: 2, id: "rain" },
      { word: 4, id: "gold" },
    ]);
    expect(scenesIn(line("a quiet room with nothing in it"))).toEqual([]);
  });

  it("shows one a line, the first it calls, apart from the last scene and further from the same one", () => {
    const lines = [line("fire and rain", 0), line("more fire here", 1000), line("rain on the glass", SCENE_GAP_MS + 100), line("fire again", SAME_SCENE_GAP_MS + 100), line("", 20_000)];
    lines[4] = { start: 20_000, end: 20_001, words: [], text: "" };
    const plans = planScenes(lines);
    expect([...plans.entries()].map(([i, p]) => [i, p.id])).toEqual([
      [0, "fire"],
      [2, "rain"],
      [3, "fire"],
    ]);
    expect(plans.get(2)?.at).toBe(SCENE_GAP_MS + 100);
  });

  it("covers words that used to call a picture, which a scene now outdoes", () => {
    const lines = [line("rain on the roof"), line("a star above", 30_000)];
    expect([...planScenes(lines).values()].map((p) => p.id)).toEqual(["rain", "stars"]);
    expect([...planPictures(lines).values()].map((p) => p.id)).toEqual(["rain", "star"]);
  });
});

describe("a word's scene (scenes.ts)", () => {
  it("plans well-formed tracks for every scene: unseen at both ends, the same for a seed", () => {
    for (const id of SCENE_IDS) {
      const scene = planScene(id, 10_000, 12_000, BOX, AMP, 7);
      expect(scene.pieces.length, id).toBeGreaterThan(1);
      expect(scene.colors, id).toEqual(SCENE_COLORS[id]);
      for (const p of scene.pieces) {
        const frames = p.track.frames;
        expect(Number(frames[0]?.offset), id).toBe(0);
        expect(Number(frames[frames.length - 1]?.offset), id).toBe(1);
        expect(Number(frames[0]?.opacity), `${id} ${p.cls} starts unseen`).toBeLessThan(0.05);
        expect(Number(frames[frames.length - 1]?.opacity), `${id} ${p.cls} ends unseen`).toBeLessThan(0.05);
        expect(p.w, id).toBeGreaterThan(0);
        expect(p.h, id).toBeGreaterThan(0);
      }
      expect(scene.until).toBeGreaterThanOrEqual(10_000 + 2600);
      expect(planScene(id, 10_000, 12_000, BOX, AMP, 7), id).toEqual(scene);
      // each its own, from the seed (the sun has nothing to vary)
      if (id !== "sun") expect(planScene(id, 10_000, 12_000, BOX, AMP, 8), id).not.toEqual(scene);
    }
  });

  it("sets fire behind the word, catching from left to right, with embers in front", () => {
    const scene = planScene("fire", 10_000, 12_000, BOX, AMP, 3);
    const flames = scene.pieces.filter((p) => p.cls === "sc-flame");
    expect(flames.length).toBeGreaterThanOrEqual(3);
    expect(flames.every((p) => p.layer === "back")).toBe(true);
    expect(scene.pieces.some((p) => p.cls === "sc-ember" && p.layer === "front")).toBe(true);
    // the first flame is up before the last one has caught
    const first = flames[0] as (typeof flames)[number];
    const last = flames[flames.length - 1] as (typeof flames)[number];
    expect(at(first.track, 10_120).sy).toBeGreaterThan(at(last.track, 10_120).sy);
    // a wider word gets more flames
    expect(planScene("fire", 10_000, 12_000, { ...BOX, w: 400 }, AMP, 3).pieces.filter((p) => p.cls === "sc-flame").length).toBeGreaterThan(flames.length);
  });

  it("raises a half sun behind the word out of a horizon at its baseline, and sets it again", () => {
    const scene = planScene("sun", 10_000, 12_000, BOX, AMP, 3);
    const sun = scene.pieces.find((p) => p.cls === "sc-sun");
    expect(sun?.layer).toBe("back");
    expect(sun?.clip).toBeDefined();
    // its middle on the baseline, the horizon window's bottom there too: only its top half shows
    expect(sun?.y).toBe(BOX.baseline);
    expect((sun?.clip?.y ?? 0) + (sun?.clip?.h ?? 0)).toBeCloseTo(BOX.baseline, 6);
    const R = (sun?.h ?? 0) / 2;
    expect(at(sun?.track as Track, 10_000).y).toBeGreaterThan(0.8 * R);
    expect(Math.abs(at(sun?.track as Track, 11_500).y)).toBeLessThan(0.05 * R);
    expect(at(sun?.track as Track, scene.until - 100).y).toBeGreaterThan(0.5 * R);
    expect(scene.pieces.some((p) => p.cls === "sc-rays")).toBe(true);
    expect(scene.pieces.some((p) => p.cls === "sc-line")).toBe(true);
    const moon = planScene("moon", 10_000, 12_000, BOX, AMP, 3).pieces;
    expect(moon.some((p) => p.cls === "sc-moon" && p.clip)).toBe(true);
    expect(moon.some((p) => p.cls === "sc-twinkle")).toBe(true);
  });

  it("piles snow at the word's feet while flakes fall around it", () => {
    const scene = planScene("snow", 10_000, 13_000, BOX, AMP, 3);
    const drift = scene.pieces.find((p) => p.cls === "sc-drift");
    expect(drift?.oy).toBe(1);
    expect(at(drift?.track as Track, 10_200).sy).toBeLessThan(at(drift?.track as Track, 12_000).sy);
    const flakes = scene.pieces.filter((p) => p.cls === "sc-flake");
    expect(flakes.length).toBeGreaterThanOrEqual(10);
  });

  it("moves the word itself for some scenes, at rest at both ends of its window", () => {
    for (const id of ["fire", "snow", "electric", "love", "water"] as const) {
      const word = planScene(id, 10_000, 12_000, BOX, AMP, 3).word;
      expect(word, id).not.toBeNull();
      const frames = word?.frames ?? [];
      for (const f of [frames[0], frames[frames.length - 1]]) {
        expect(f?.translate, id).toBe("0px 0px");
        expect(f?.scale, id).toBe("1 1");
      }
    }
    for (const id of ["sun", "moon", "gold", "stars", "rain"] as const) expect(planScene(id, 10_000, 12_000, BOX, AMP, 3).word, id).toBeNull();
  });

  it("without motion, fades in and out where it stands, and leaves the word still", () => {
    for (const id of SCENE_IDS) {
      const scene = planScene(id, 10_000, 12_000, BOX, 0, 3);
      expect(scene.word, id).toBeNull();
      for (const p of scene.pieces) expect(new Set(p.track.frames.map((f) => f.transform)).size, `${id} ${p.cls}`).toBe(1);
    }
  });
});
