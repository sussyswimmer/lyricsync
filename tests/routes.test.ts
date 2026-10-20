import { describe, expect, it } from "vitest";
import { PICTURE_IDS, type PictureId } from "../src/core/wordpics";
import type { Track } from "../src/overlay/motion/karaoke";
import { BALL_EM, planBall, planPictureRoute, routeOf, type RouteInput, type Stop } from "../src/overlay/motion/routes";

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
  const spots = [0, 1, 2, 3, 4].map((j) => ({ x: 60 + 120 * j, y: 100, w: 100, t: 10_000 + 450 * j }));
  const home = spots[i] as Stop;
  return { id, at: home.t, until: 12_200, side: L, size: L, amp, seed: 7, home, stops: spots.slice(i + 1), left: 10, right: 590 };
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

describe("karaoke mode's dot (routes.ts planBall)", () => {
  /** Five words 120 px apart on a row whose tops are at y 100, sung 450 ms apart from 10 s; the line ends at 12.2 s. */
  const words: Stop[] = [0, 1, 2, 3, 4].map((j) => ({ x: 60 + 120 * j, y: 100, w: 100, t: 10_000 + 450 * j }));
  const ball = (bounce = true, over: readonly Stop[] = words): Track => {
    const track = planBall({ words: over, until: 12_200, size: L, bounce });
    if (!track) throw new Error("no track");
    return track;
  };

  it("is well formed, and the same every time", () => {
    wellFormed(ball());
    wellFormed(ball(false));
    expect(ball()).toEqual(ball());
    expect(BALL_EM * L).toBeGreaterThan(8);
  });

  it("lands on every word exactly as it starts, just above its top, and stays while it's sung", () => {
    for (const bounce of [true, false]) {
      const track = ball(bounce);
      for (const w of words) {
        for (const t of [w.t, w.t + 40]) {
          const p = poseAt(track, t);
          expect(p.x, `${bounce} ${t}`).toBeCloseTo(w.x, 0);
          expect(p.y).toBeLessThan(w.y);
          expect(p.y).toBeGreaterThan(w.y - 0.3 * L);
          expect(p.opacity).toBeCloseTo(1, 2);
        }
      }
    }
  });

  it("hops between words in an arc, and slides without one under reduced motion", () => {
    // the hop to the second word takes 360 ms of the 450 (BALL_FLIGHT): its top is halfway through
    const mid = (words[0] as Stop).t + 450 - 360 / 2;
    const rest = poseAt(ball(), (words[0] as Stop).t).y;
    expect(poseAt(ball(), mid).y).toBeLessThan(rest - 0.25 * L);
    for (let t = 10_000; t < 11_800; t += 25) expect(poseAt(ball(false), t).y).toBeCloseTo(rest, 0);
  });

  it("drops in before the first word, and fades out where it is after the line's last word", () => {
    const track = ball();
    expect(track.t0).toBeLessThan(10_000);
    expect(poseAt(track, track.t0).opacity).toBeLessThan(0.2);
    const end = track.t0 + track.duration;
    expect(end).toBeGreaterThan(12_200);
    expect(end).toBeLessThan(12_200 + 1000);
    expect(poseAt(track, 12_200).x).toBeCloseTo(540, 0);
    expect(poseAt(track, end).x).toBeCloseTo(540, 0);
    expect(poseAt(track, end).opacity).toBeLessThan(0.05);
  });

  it("takes words that start together as one landing, and has nothing to plan without words", () => {
    const together: Stop[] = [
      { x: 60, y: 100, w: 100, t: 10_000 },
      { x: 180, y: 100, w: 100, t: 10_010 },
      { x: 300, y: 100, w: 100, t: 10_500 },
    ];
    expect(poseAt(ball(true, together), 10_050).x).toBeCloseTo(60, 0);
    expect(poseAt(ball(true, together), 10_500).x).toBeCloseTo(300, 0);
    expect(planBall({ words: [], until: 0, size: L, bounce: true })).toBeNull();
  });
});
