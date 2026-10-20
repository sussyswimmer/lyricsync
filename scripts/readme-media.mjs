// Renders two of the images in docs/media/ from the app itself:
//   - social-preview.png, the repository's GitHub social preview (1280x640), from social-preview.svg
//     (scripts/banner.py writes the SVG).
//   - settings-light.png and settings-dark.png, the settings window as the README shows it, from the real
//     page on the mock bridge.
//
// Needs `pnpm dev` running and Playwright with Chromium:
//
//   pnpm dev &
//   node scripts/readme-media.mjs                   # both
//   node scripts/readme-media.mjs social-preview    # just the social preview
//   node scripts/readme-media.mjs settings          # just the settings window
//
// Playwright isn't a dependency of the app. Point PLAYWRIGHT at an install if `import("playwright")`
// can't find one, e.g. PLAYWRIGHT=/usr/lib/node_modules/playwright/index.js.

import { pathToFileURL } from "node:url";

const MEDIA = new URL("../docs/media/", import.meta.url);
const BASE = process.env.BASE ?? "http://localhost:1420";
const settings = (patch) => encodeURIComponent(JSON.stringify(patch));
const media = (name) => new URL(name, MEDIA).pathname;

const playwright = await import(process.env.PLAYWRIGHT ? pathToFileURL(process.env.PLAYWRIGHT).href : "playwright");
const chromium = playwright.chromium ?? playwright.default.chromium;

/** Paper Lanterns has real per-word timing. 6.65 s is at the end of its second line. */
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

async function socialPreview(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
  await page.goto(new URL("social-preview.svg", MEDIA).href);
  await page.screenshot({ path: media("social-preview.png") });
  await page.close();
}

async function settingsWindow(browser) {
  for (const colorScheme of ["light", "dark"]) {
    // The settings window's size, at 2x for sharp text.
    const context = await browser.newContext({ viewport: { width: 380, height: 640 }, deviceScaleFactor: 2, colorScheme });
    const page = await context.newPage();
    await playingAt(page, "settings.html", STILL_MS);
    await page.screenshot({ path: media(`settings-${colorScheme}.png`) });
    await context.close();
  }
}

const jobs = { "social-preview": socialPreview, settings: settingsWindow };
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
