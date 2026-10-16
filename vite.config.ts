import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/** CLAUDE.md C8: at least 90% coverage on the parser, word timing and the playback clock, enforced by `pnpm coverage` (CI). */
const CORE_FLOOR = { lines: 90, branches: 90, functions: 90, statements: 90 };

export default defineConfig({
  clearScreen: false,
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
      include: ["src/core/**", "src/bridge/**", "src/overlay/view.ts", "src/overlay/look.ts", "src/overlay/stage.ts"],
      // one entry per file: a glob matching several would be checked against their total
      thresholds: {
        "src/core/lrc.ts": CORE_FLOOR,
        "src/core/timing.ts": CORE_FLOOR,
        "src/core/clock.ts": CORE_FLOOR,
      },
    },
  },
});
