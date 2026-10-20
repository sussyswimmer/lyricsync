// Renders the README images in assets/ from the real overlay and settings pages, running on the mock
// bridge, so they show exactly what the app draws (on the dusk stand-in wallpaper, with the demo
// tracks' original placeholder lyrics).
//
// Needs `pnpm dev` running, Playwright with Chromium, and ffmpeg for the GIF:
//
//   pnpm dev &
//   node scripts/readme-media.mjs            # everything below
//   node scripts/readme-media.mjs banner     # assets/banner.png from assets/banner.svg (scripts/banner.py writes the SVG)
//   node scripts/readme-media.mjs styles     # assets/style-{arc,lens,drift,stack}.png
//   node scripts/readme-media.mjs settings   # assets/settings-{light,dark}.png
//   node scripts/readme-media.mjs demo       # assets/demo.gif
//
// Playwright isn't a dependency of the app. Point PLAYWRIGHT at an install if `import("playwright")`
// can't find one, e.g. PLAYWRIGHT=/usr/lib/node_modules/playwright/index.js.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);
const ASSETS = new URL("assets/", ROOT);
const BASE = process.env.BASE ?? "http://localhost:1420";
const settings = (patch) => encodeURIComponent(JSON.stringify(patch));
const asset = (name) => new URL(name, ASSETS).pathname;

const playwright = await import(process.env.PLAYWRIGHT ? pathToFileURL(process.env.PLAYWRIGHT).href : "playwright");
const chromium = playwright.chromium ?? playwright.default.chromium;

/** The overlay at 1280x720, and every crop of it: the lyrics band. */
const OVERLAY = { width: 1280, height: 720 };
const CROP = { width: 960, height: 300 };
/** Paper Lanterns has real per-word timing. 6.65 s is on "toward", the second-to-last word of its second line. */
const TRACK = 1;
const STILL_MS = 6650;
/** Real time to let fonts load and the cover decode, which the faked clock doesn't drive. */
const SETTLE_MS = 1500;

/**
 * Opens a page of the app playing the demo track with the page's clock frozen, then seeks to just
 * before `atMs` and runs the clock up to it. Everything the app times (the fake lookup, the artwork,
 * fades, the playback position) follows the faked clock, so the same call draws the same frame every run.
 */
async function playingAt(page, path, atMs, patch = {}) {
  const leadMs = 400; // longer than the clock's 300 ms slew, so the seek has fully landed
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1000);
  await page.goto(`${BASE}/${path}?mock&track=${TRACK}&t=${atMs}&settings=${settings(patch)}`);
  await page.waitForTimeout(SETTLE_MS);
  await page.clock.runFor(1000); // the lookup and the artwork arrive
  await page.waitForTimeout(SETTLE_MS); // the cover decodes and its palette applies
  await page.evaluate((ms) => window.undertone?.bridge.player.seek(ms), atMs - leadMs);
  await page.clock.runFor(leadMs);
}

/** Vertical center of the lyrics in a screenshot: the rows with any pixel brighter than the wallpaper. */
async function inkCenter(page, png) {
  return page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = new OffscreenCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, img.width, img.height);
    let top = img.height;
    let bottom = 0;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] > 120) {
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
          break;
        }
      }
    }
    return top <= bottom ? (top + bottom) / 2 : img.height / 2;
  }, `data:image/png;base64,${png.toString("base64")}`);
}

async function banner(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
  await page.goto(new URL("banner.svg", ASSETS).href);
  await page.screenshot({ path: asset("banner.png") });
  await page.close();
}

async function styles(browser) {
  for (const mode of ["arc", "lens", "drift", "stack"]) {
    const page = await browser.newPage({ viewport: OVERLAY });
    await playingAt(page, "", STILL_MS, { mode });
    const cy = await inkCenter(page, await page.screenshot());
    const clip = { x: (OVERLAY.width - CROP.width) / 2, y: Math.round(cy - CROP.height / 2), ...CROP };
    await page.screenshot({ path: asset(`style-${mode}.png`), clip });
    await page.close();
  }
}

async function settingsWindow(browser) {
  for (const colorScheme of ["light", "dark"]) {
    // The settings window's size, at 2x for sharp text.
    const context = await browser.newContext({ viewport: { width: 380, height: 640 }, deviceScaleFactor: 2, colorScheme });
    const page = await context.newPage();
    await playingAt(page, "settings.html", STILL_MS);
    await page.screenshot({ path: asset(`settings-${colorScheme}.png`) });
    await context.close();
  }
}

/** Paper Lanterns from 0.6 s to 9 s in Arc: two lines sung word by word, 25 frames a second. */
async function demo(browser) {
  const fps = 25;
  const startMs = 600;
  const endMs = 9000;
  const frames = mkdtempSync(join(tmpdir(), "undertone-demo-"));
  try {
    const page = await browser.newPage({ viewport: OVERLAY });
    await playingAt(page, "", startMs, { mode: "arc" });
    // Fixed, since the lines move: room for the line before, the sung line on its arch and the next one.
    const clip = { x: (OVERLAY.width - CROP.width) / 2, y: 150, width: CROP.width, height: 320 };
    const count = Math.round(((endMs - startMs) / 1000) * fps);
    for (let i = 0; i < count; i++) {
      await page.screenshot({ path: join(frames, `f${String(i).padStart(4, "0")}.png`), clip });
      await page.clock.runFor(1000 / fps);
    }
    await page.close();
    execFileSync("ffmpeg", [
      "-loglevel", "error", "-y", "-framerate", String(fps), "-i", join(frames, "f%04d.png"),
      "-vf", "split[a][b];[a]palettegen=max_colors=200:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle",
      asset("demo.gif"),
    ]);
  } finally {
    rmSync(frames, { recursive: true, force: true });
  }
}

const jobs = { banner, styles, settings: settingsWindow, demo };
const wanted = process.argv.slice(2);
const unknown = wanted.filter((name) => !(name in jobs));
if (unknown.length) {
  console.error(`Unknown: ${unknown.join(", ")}. Choose from: ${Object.keys(jobs).join(", ")}.`);
  process.exit(1);
}
const browser = await chromium.launch();
try {
  for (const name of wanted.length ? wanted : Object.keys(jobs)) {
    await jobs[name](browser);
    console.log(`${name}: done`);
  }
} finally {
  await browser.close();
}
