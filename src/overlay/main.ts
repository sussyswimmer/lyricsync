import "../styles/overlay.css";
import "./fonts";
import { connect, type Bridge } from "../bridge";
import { OverlayController } from "./controller";
import { mergeOverrides, overrideFromSettings, parseFlairOverride, parseLookOverride, workAreaReference } from "./look";
import { detectPower } from "./motion/power";
import { LyricStage } from "./stage";

/** What this page puts on `window`: the app's `--look` hand-off in, the overlay's parts out (mock and dev). */
type OverlayWindow = Window & {
  /** `--look=<style>[,<family>[,<curve>]]`: Rust sets it on page load, then dispatches "undertone-look" */
  __UNDERTONE_LOOK__?: unknown;
  undertone?: { bridge: Bridge; stage: LyricStage; controller: OverlayController };
};

const host = document.getElementById("app");
if (host) {
  const bridge = await connect();
  const params = new URLSearchParams(location.search);
  const win = window as OverlayWindow;
  if (bridge.kind === "mock") {
    // In a plain browser, paint a stand-in wallpaper behind the transparent overlay (?wallpaper=dusk|light|busy|none).
    document.documentElement.dataset.wallpaper = params.get("wallpaper") ?? "dusk";
  }
  // The power tier the stage draws with (full, or lite on software compositing), readable in the
  // developer tools for docs/ACCEPTANCE.md's lite check. detectPower() is memoized: the stage reuses it.
  document.documentElement.dataset.power = detectPower();
  let controller: OverlayController | null = null;
  const stage = new LyricStage(host, {
    onInvalidate: () => controller?.kick(),
    // The native overlay covers its display's work area, not the whole screen: Size follows the screen.
    ...(bridge.kind === "tauri" ? { referenceHeight: () => workAreaReference(innerHeight, screen.height) } : {}),
  });
  // Picks each song's look (SPEC §4.6) and brings refinements in at the stage's safe points, which it
  // listens for itself.
  controller = new OverlayController(bridge, stage, { gate: true });
  // QA overrides, never stored (SPEC §4.10): `mode`, `font` and `curve` inside the mock's ?settings=
  // (so the harness tools keep working), ?look=style[,family[,curve]] and ?flair=move[,accent[,splash]]
  // on any bridge, and the app's --look hand-off, which can arrive after load.
  const fromUrl = mergeOverrides(
    mergeOverrides(bridge.kind === "mock" ? overrideFromSettings(params.get("settings")) : null, parseLookOverride(params.get("look"))),
    parseFlairOverride(params.get("flair")),
  );
  let fromApp = parseLookOverride(win.__UNDERTONE_LOOK__);
  if (fromUrl || fromApp) controller.forceLook(mergeOverrides(fromUrl, fromApp));
  window.addEventListener("undertone-look", () => {
    fromApp = parseLookOverride(win.__UNDERTONE_LOOK__);
    controller?.forceLook(mergeOverrides(fromUrl, fromApp));
  });
  await controller.start();
  if (bridge.kind === "mock" || import.meta.env.DEV) win.undertone = { bridge, stage, controller };
}
