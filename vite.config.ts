import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { rollupOptions: { input: {
    overlay: fileURLToPath(new URL("./index.html", import.meta.url)),
    settings: fileURLToPath(new URL("./settings.html", import.meta.url)),
  } } },
});
