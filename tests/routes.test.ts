import { describe, expect, it } from "vitest";
import { PICTURE_IDS, type PictureId } from "../src/core/wordpics";
import type { Track } from "../src/overlay/motion/karaoke";
import { planPictureRoute, routeOf, type RouteInput, type Stop } from "../src/overlay/motion/routes";

/** Where a track draws the picture at song time `t`: its translate and opacity, linear between keyframes (held at the ends). */
function poseAt(track: Track, t: number): { x: number; y: number; opacity: number } {
  const u = Math.min(1, Math.max(0, (t - track.t0) / track.duration));
  const read = (f: Keyframe): [number, number, number] => {
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/u.exec(String(f.transform));
    return [Number(m?.[1] ?? 0), Number(m?.[2] ?? 0), Number(f.opacity ?? 1)];
  };
  const frames = track.frames;
  let i = 0;
  while (i + 1 < frames.length && Number(frames[i + 1]?.offset) <= u) i++;
  const a = read(frames[i] as Keyframe);
  const next = frames[i + 1];
  if (!next) return { x: a[0], y: a[1], opacity: a[2] };
  const b = read(next);
  const o0 = Number(frames[i]?.offset);
  const o1 = Number(next.offset);
  const p = o1 > o0 ? (u - o0) / (o1 - o0) : 0;
  return { x: a[0] + (b[0] - a[0]) * p, y: a[1] + (b[1] - a[1]) * p, opacity: a[2] + (b[2] - a[2]) * p };
}

const L = 58;
/** A line of five words 120 px apart, sung 450 ms apart from 10 s; the picture on word `i`. */
function input(id: PictureId, i = 1, amp = 1): RouteInput {
  const spots: Stop[] = [0, 1, 2, 3, 4].map((j) => ({ x: 60 + 120 * j, y: 100, w: 100, t: 10_000 + 450 * j, word: j }));
  const home = spots[i] as Stop;
  return { id, word: i, at: home.t, until: 12_200, side: L, size: L, amp, seed: 7, home, stops: spots.slice(i + 1), prev: spots[i - 1] ?? null, left: 10, right: 590 };
}

function wellFormed(track: Track): void {
  const offsets = track.frames.map((f) => Number(f.offset));
  expect(offsets[0]).toBe(0);
  expect(offsets[offsets.length - 1]).toBe(1);
  for (let i = 1; i < offsets.length; i++) expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1] ?? 0);
  // it comes in from nothing and leaves to nothing
  expect(Number(track.frames[0]?.opacity)).toBeLessThan(0.2);
  expect(Number(track.frames[track.frames.length - 1]?.opacity)).toBeLessThan(0.05);
}

describe("picture routes (routes.ts)", () => {
  it("gives every picture a route, hopping by default", () => {
    for (const id of PICTURE_IDS) expect(["hop", "fly", "launch", "drive", "float", "fall", "burst", "orbit", "roll", "dance"]).toContain(routeOf(id));
    expect(routeOf("wine")).toBe("hop");
    expect(routeOf("bird")).toBe("fly");
    expect(routeOf("car")).toBe("drive");
    expect(routeOf("rain")).toBe("fall");
  });

  it("plans a well-formed track for every picture, the same every time for a seed", () => {
    for (const id of PICTURE_IDS) {
      const plan = planPictureRoute(input(id));
      wellFormed(plan.track);
      for (const c of plan.copies) wellFormed(c.track);
      expect(plan.track.t0 + plan.track.duration, id).toBeLessThanOrEqual(10_450 + 9000);
      expect(planPictureRoute(input(id)), id).toEqual(plan);
    }
  });

  it("hops onto each word after its own as that word starts, like a bouncing ball", () => {
    const plan = planPictureRoute(input("wine"));
    for (const j of [2, 3, 4]) {
      const t = 10_000 + 450 * j;
      const at = poseAt(plan.track, t);
      expect(at.x, `word ${j}`).toBeCloseTo(60 + 120 * j, 0);
      expect(Math.abs(at.y - (100 + 0.06 * L)), `word ${j}`).toBeLessThan(2);
      expect(at.opacity).toBeCloseTo(1, 2);
      // in the air halfway to it
      expect(poseAt(plan.track, t - 200).y).toBeLessThan(100);
    }
    // and jumps off the end of the line
    const end = plan.track.t0 + plan.track.duration;
    expect(poseAt(plan.track, end - 100).x).toBeGreaterThan(540);
  });

  it("flies across above the line, nose first, over its word as it's sung", () => {
    const bird = planPictureRoute(input("bird"));
    const dove = planPictureRoute(input("dove"));
    const over = poseAt(dove.track, 10_450);
    expect(over.x).toBeCloseTo(180, 0);
    expect(over.y).toBeLessThan(100);
    // a dove faces right and flies left to right; the bird faces left and flies the other way
    expect(poseAt(dove.track, dove.track.t0).x).toBeLessThan(10);
    expect(poseAt(dove.track, dove.track.t0 + dove.track.duration).x).toBeGreaterThan(590);
    expect(poseAt(bird.track, bird.track.t0).x).toBeGreaterThan(590);
  });

  it("drives along the tops of the words from one end of the line to the other", () => {
    const car = planPictureRoute(input("car"));
    expect(poseAt(car.track, car.track.t0).x).toBeLessThan(10);
    expect(poseAt(car.track, 10_450).x).toBeCloseTo(180, 0);
    expect(poseAt(car.track, car.track.t0 + car.track.duration).x).toBeGreaterThan(590);
    expect(Math.abs(poseAt(car.track, 11_500).y - 100)).toBeLessThan(0.3 * L);
  });

  it("brings copies: a shower falls across the line, a burst flies out from the word", () => {
    const rain = planPictureRoute(input("rain"));
    expect(rain.copies.length).toBe(7);
    for (const c of rain.copies) {
      const top = poseAt(c.track, c.track.t0 + 1);
      const low = poseAt(c.track, c.track.t0 + c.track.duration - 1);
      expect(low.y).toBeGreaterThan(top.y);
      expect(c.scale).toBeLessThan(1);
    }
    const star = planPictureRoute(input("star"));
    expect(star.copies.length).toBe(6);
    for (const c of star.copies) {
      const out = poseAt(c.track, c.track.t0 + 0.6 * c.track.duration);
      expect(Math.hypot(out.x - 180, out.y - 100)).toBeGreaterThan(0.6 * L);
    }
    expect(planPictureRoute(input("wine")).copies).toEqual([]);
  });

  it("floats up, orbits above, rolls to the end, or dances on its word", () => {
    const heart = planPictureRoute(input("heart"));
    expect(poseAt(heart.track, heart.track.t0 + heart.track.duration - 600).y).toBeLessThan(100 - L);
    const moon = planPictureRoute(input("moon"));
    const xs = [0, 650, 1300, 1950].map((ms) => poseAt(moon.track, 10_450 + ms).x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(L);
    const disco = planPictureRoute(input("disco"));
    expect(poseAt(disco.track, disco.track.t0 + disco.track.duration - 600).x).toBeGreaterThan(560);
    const candle = planPictureRoute(input("candle"));
    for (const ms of [0, 800, 1600]) expect(poseAt(candle.track, 10_450 + 200 + ms).x).toBeCloseTo(180, 0);
  });

  it("only fades in and out on its word without motion", () => {
    const plan = planPictureRoute(input("car", 1, 0));
    expect(plan.copies).toEqual([]);
    expect(new Set(plan.track.frames.map((f) => f.transform)).size).toBe(1);
    expect(plan.track.t0).toBe(10_450);
    const mid = poseAt(plan.track, 11_500);
    expect(mid.x).toBe(180);
    expect(mid.opacity).toBe(1);
  });

  it("stays while its line is sung, within its bounds", () => {
    // a short line: at least 2.6 s; a long one: until its last word ends, at most 9 s
    expect(planPictureRoute({ ...input("dance" as PictureId), until: 10_500 }).track.duration).toBeGreaterThanOrEqual(2600);
    const long = planPictureRoute({ ...input("candle"), until: 40_000 });
    expect(long.track.t0 + long.track.duration).toBe(10_450 + 9000);
  });
});

/** A reaction's pose at song time `t`: translate, rotate and scale as numbers, linear between keyframes (rest outside). */
function pushAt(track: Track, t: number): { dx: number; dy: number; deg: number; sx: number; sy: number } {
  const read = (f: Keyframe): number[] => {
    const [dx = 0, dy = 0] = String(f.translate).split(" ").map((v) => Number.parseFloat(v));
    const [sx = 1, sy = 1] = String(f.scale).split(" ").map(Number);
    return [dx, dy, Number.parseFloat(String(f.rotate)), sx, sy];
  };
  const u = (t - track.t0) / track.duration;
  if (u <= 0 || u >= 1) return { dx: 0, dy: 0, deg: 0, sx: 1, sy: 1 };
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
  return { dx: v[0] ?? 0, dy: v[1] ?? 0, deg: v[2] ?? 0, sx: v[3] ?? 1, sy: v[4] ?? 1 };
}

/** The most a reaction moves its word over its window: offset (px), turn (degrees), squash. */
function reach(track: Track): { move: number; turn: number; squash: number } {
  let move = 0;
  let turn = 0;
  let squash = 0;
  for (let t = track.t0; t <= track.t0 + track.duration; t += 10) {
    const p = pushAt(track, t);
    move = Math.max(move, Math.hypot(p.dx, p.dy));
    turn = Math.max(turn, Math.abs(p.deg));
    squash = Math.max(squash, Math.abs(p.sx - 1), Math.abs(p.sy - 1));
  }
  return { move, turn, squash };
}

describe("the words answer the picture (reactions)", () => {
  it("every picture moves at least its own word, and every reaction starts and ends at rest", () => {
    for (const id of PICTURE_IDS) {
      const plan = planPictureRoute(input(id));
      expect(plan.reactions.length, id).toBeGreaterThan(0);
      for (const r of plan.reactions) {
        const first = r.track.frames[0];
        const last = r.track.frames[r.track.frames.length - 1];
        for (const f of [first, last]) {
          expect(f?.translate, id).toBe("0px 0px");
          expect(f?.rotate, id).toBe("0deg");
          expect(f?.scale, id).toBe("1 1");
        }
        expect([0, 1, 2, 3, 4], id).toContain(r.word);
        // a nudge, never a shove off the line
        const most = reach(r.track);
        expect(most.move, id).toBeLessThan(0.3 * L);
        expect(most.turn, id).toBeLessThan(8);
        expect(most.squash, id).toBeLessThan(0.2);
      }
      expect(new Set(plan.reactions.map((r) => r.word)).size, `${id}: one reaction a word`).toBe(plan.reactions.length);
    }
  });

  it("a hopping picture squashes each word it lands on, as it lands", () => {
    const plan = planPictureRoute(input("wine"));
    const own = plan.reactions.find((r) => r.word === 1);
    expect(own).toBeDefined();
    expect(pushAt(own?.track as Track, 10_450 + 90).dy).toBeGreaterThan(0.03 * L);
    // and the words after it, each at its own start
    const third = plan.reactions.find((r) => r.word === 3);
    expect(pushAt(third?.track as Track, 10_000 + 3 * 450 - 30).dy).toBeCloseTo(0, 6);
    expect(pushAt(third?.track as Track, 10_000 + 3 * 450 + 90).dy).toBeGreaterThan(0.03 * L);
  });

  it("a balloon lifts its word and lets go; a rocket kicks its word up as it lifts off", () => {
    const balloon = planPictureRoute(input("balloon")).reactions.find((r) => r.word === 1)?.track as Track;
    expect(pushAt(balloon, 10_450 + 900).dy).toBeLessThan(-0.1 * L);
    expect(pushAt(balloon, 10_450 + 2290).dy).toBeGreaterThan(-0.02 * L);
    const rocket = planPictureRoute(input("rocket")).reactions.find((r) => r.word === 1)?.track as Track;
    expect(pushAt(rocket, 10_450 + 650 + 240).dy).toBeLessThan(-0.15 * L);
    expect(Math.abs(pushAt(rocket, 10_450 + 300).dx)).toBeGreaterThan(0);
  });

  it("a burst pops its word and shoves the words either side apart", () => {
    const plan = planPictureRoute(input("star", 2));
    const own = plan.reactions.find((r) => r.word === 2)?.track as Track;
    expect(pushAt(own, 10_900 + 200).sx).toBeGreaterThan(1.05);
    const left = plan.reactions.find((r) => r.word === 1)?.track as Track;
    const right = plan.reactions.find((r) => r.word === 3)?.track as Track;
    expect(pushAt(left, 10_900 + 250).dx).toBeLessThan(-2);
    expect(pushAt(right, 10_900 + 250).dx).toBeGreaterThan(2);
  });

  it("a car dips the words it drives over, a bird ducks them, rain hits them", () => {
    for (const id of ["car", "bird", "rain"] as const) {
      const plan = planPictureRoute(input(id));
      const touched = plan.reactions.filter((r) => reach(r.track).move > 0.02 * L);
      expect(touched.length, id).toBeGreaterThanOrEqual(2);
    }
  });

  it("asks nothing of the words without motion", () => {
    for (const id of PICTURE_IDS) expect(planPictureRoute(input(id, 1, 0)).reactions, id).toEqual([]);
  });
});
