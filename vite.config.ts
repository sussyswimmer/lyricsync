import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: {
    // Never inline fonts as data: URLs. The app's CSP (default-src 'self', no font-src) refuses them,
    // and small Fontsource subsets (Cyrillic Extended, Vietnamese) would fall back to system faces.
    assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/i.test(file) ? false : undefined),
    rollupOptions: { input: {
      overlay: fileURLToPath(new URL("./index.html", import.meta.url)),
      settings: fileURLToPath(new URL("./settings.html", import.meta.url)),
    } },
  },
});
