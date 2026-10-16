import "../styles/overlay.css";
import "./fonts";
import { connect } from "../bridge";
import { OverlayController } from "./controller";
import { workAreaReference } from "./look";
import { LyricStage } from "./stage";

const host = document.getElementById("app");
if (host) {
  const bridge = await connect();
  if (bridge.kind === "mock") {
    // In a plain browser, paint a stand-in wallpaper behind the transparent overlay (?wallpaper=dusk|light|busy|none).
    document.documentElement.dataset.wallpaper = new URLSearchParams(location.search).get("wallpaper") ?? "dusk";
  }
  let controller: OverlayController | null = null;
  const stage = new LyricStage(host, {
    onInvalidate: () => controller?.kick(),
    // The native overlay covers its display's work area, not the whole screen: Size follows the screen.
    ...(bridge.kind === "tauri" ? { referenceHeight: () => workAreaReference(innerHeight, screen.height) } : {}),
  });
  controller = new OverlayController(bridge, stage, { gate: true });
  await controller.start();
  if (bridge.kind === "mock") Object.assign(window, { undertone: { bridge, stage, controller } });
}
