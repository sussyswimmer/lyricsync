import { defineConfig } from "vitest/config";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The commit the app is built from, short: CI's GITHUB_SHA, else git's HEAD, else "dev" (as build.rs does). */
function buildId(): string {
  const sha = process.env["GITHUB_SHA"];
  if (sha && sha.length >= 7) return sha.slice(0, 7);
  try {
    return execSync("git rev-parse --short=7 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "dev";
  } catch {
    return "dev";
  }
}
const version = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;

/** CLAUDE.md C8: at least 90% coverage on the parser, word timing and the playback clock, enforced by `pnpm coverage` (CI). */
const CORE_FLOOR = { lines: 90, branches: 90, functions: 90, statements: 90 };
/** The look picker and the motion engine (contract v4): 85% of lines, statements and functions, 75% of branches. */
const MOTION_FLOOR = { lines: 85, branches: 75, functions: 85, statements: 85 };

export default defineConfig({
  clearScreen: false,
  // Settings' footer says which build this is, so a new install can be told from an old one
  define: { __UNDERTONE_VERSION__: JSON.stringify(version), __UNDERTONE_BUILD__: JSON.stringify(buildId()) },
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: {
    // Never inline fonts as data: URLs. The app's CSP (default-src 'self', no font-src) refuses them,
    // and small Fontsource subsets (Cyrillic Extended, Vietnamese) would fall back to system faces.
    assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/i.test(file) ? false : undefined),
    // The one large chunk is THIRD_PARTY_NOTICES.txt (about 750 kB of license text), loaded only
    // when Settings › Licenses opens. Every chunk the pages load at startup stays far below this.
    chunkSizeWarningLimit: 1024,
    rollupOptions: { input: {
      overlay: fileURLToPath(new URL("./index.html", import.meta.url)),
      settings: fileURLToPath(new URL("./settings.html", import.meta.url)),
    } },
  },
  test: {
    coverage: {
      provider: "v8",
      include: ["src/core/**", "src/bridge/**", "src/overlay/view.ts", "src/overlay/look.ts", "src/overlay/stage.ts", "src/overlay/motion/**"],
      // one entry per file: a glob matching several would be checked against their total
      thresholds: {
        "src/core/lrc.ts": CORE_FLOOR,
        "src/core/timing.ts": CORE_FLOOR,
        "src/core/clock.ts": CORE_FLOOR,
        "src/core/songlook.ts": MOTION_FLOOR,
        "src/overlay/motion/spring.ts": MOTION_FLOOR,
        "src/overlay/motion/curve.ts": MOTION_FLOOR,
        "src/overlay/motion/keyframes.ts": MOTION_FLOOR,
        "src/overlay/motion/karaoke.ts": MOTION_FLOOR,
        "src/overlay/motion/interlude.ts": MOTION_FLOOR,
        "src/overlay/motion/schedule.ts": MOTION_FLOOR,
        "src/overlay/motion/params.ts": MOTION_FLOOR,
        "src/overlay/motion/timeline.ts": MOTION_FLOOR,
      },
    },
  },
});
