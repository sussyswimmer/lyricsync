import "@fontsource/figtree/400.css";
import "@fontsource/figtree/500.css";
import "@fontsource/figtree/600.css";
import "../styles/settings.css";
import { DEFAULT_SETTINGS, type NowPlaying, type Settings } from "../../contract/contract";
import { connect } from "../bridge";
import { PaletteCache } from "../core/palette";
import { h } from "../overlay/dom";
import { SettingsPanel, type PanelState } from "./panel";
import { SettingsPreview, type PreviewInfo } from "./preview";
import { SettingsSync } from "./store";

/** Everything but `version` and per-song offsets (those go through `set_track_offset`). */
function defaultsPatch(): Partial<Settings> {
  const patch: Partial<Settings> = structuredClone(DEFAULT_SETTINGS);
  delete patch.version;
  delete patch.trackOffsetsMs;
  return patch;
}

async function boot(host: HTMLElement): Promise<void> {
  const bridge = await connect();

  // Subscribe first, then read the initial state, so nothing that happens in between is lost.
  // An event that beats its query's reply is newer than the reply.
  const early: { settings: Settings | null; track: NowPlaying | null; heardTrack: boolean } = {
    settings: null,
    track: null,
    heardTrack: false,
  };
  let onSettings = (s: Settings): void => {
    early.settings = s;
  };
  let onTrack = (np: NowPlaying | null): void => {
    early.track = np;
    early.heardTrack = true;
  };
  await bridge.listen("settings-changed", (s) => onSettings(s));
  await bridge.listen("now-playing", (np) => onTrack(np));
  const [fetched, fetchedTrack] = await Promise.all([
    bridge.invoke("get_settings").catch(() => structuredClone(DEFAULT_SETTINGS)),
    bridge.invoke("get_now_playing").catch(() => null),
  ]);

  let track: NowPlaying | null = early.heardTrack ? early.track : fetchedTrack;
  let view: Settings = early.settings ?? fetched;
  let info: PreviewInfo = { track: null, demo: false, palette: null, paletteFrom: null, artPending: false };

  const palettes = new PaletteCache();
  // Created below; the closures only run after both exist.
  let panel: SettingsPanel | null = null;
  let preview: SettingsPreview | null = null;

  // now-playing resyncs arrive about once a second; only a change the panel shows re-renders it.
  let shown: PanelState | null = null;
  const render = (): void => {
    const state: PanelState = {
      settings: view,
      palette: info.palette,
      paletteFor: info.demo ? null : info.paletteFrom,
      artPending: info.artPending,
      track: track ? { key: track.trackKey, title: track.title, artist: track.artist } : null,
    };
    if (!panel || (shown && samePanelState(shown, state))) return;
    shown = state;
    panel.render(state);
  };

  const sync = new SettingsSync({
    bridge,
    initial: view,
    onChange: (next) => {
      view = next;
      preview?.setSettings(next);
      render();
    },
    onError: (error) => {
      console.warn("Undertone: couldn't save settings", error);
      panel?.announce("Couldn't save that change");
    },
  });

  panel = new SettingsPanel({
    edit: (patch) => sync.edit(patch),
    setTrackOffset: (key, ms) => sync.setTrackOffset(key, ms),
    reset: (forgetSongs) => {
      const offsets = Object.entries(view.trackOffsetsMs);
      sync.edit(defaultsPatch());
      sync.flush();
      if (forgetSongs) for (const [key, ms] of offsets) if (ms !== 0) sync.setTrackOffset(key, 0);
    },
  });

  preview = new SettingsPreview({
    bridge,
    palettes,
    settings: view,
    onInfo: (next) => {
      info = next;
      render();
    },
  });

  const top = h("header", "top");
  top.append(preview.el);
  host.append(top, panel.el);
  host.removeAttribute("aria-busy");

  onSettings = (s) => sync.receive(s);
  onTrack = (np) => {
    track = np;
    preview?.setMainTrack(np);
    render();
  };
  render();

  // Don't drop an edit made just before the window hides or closes.
  const flush = (): void => sync.flush();
  window.addEventListener("pagehide", flush);
  window.addEventListener("blur", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });

  // Keyboard focus and scrollIntoView stop below the pinned preview, never under it.
  const pad = (): void => {
    document.documentElement.style.scrollPaddingTop = `${top.offsetHeight + 8}px`;
  };
  new ResizeObserver(pad).observe(top);
  pad();

  // A hairline under the preview once the controls scroll beneath it.
  const onScroll = (): void => {
    document.documentElement.classList.toggle("is-scrolled", window.scrollY > 2);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  if (bridge.kind === "mock") Object.assign(window, { undertone: { bridge, sync, preview, panel } });

  // Last: everything above must work even if the preview's first source is slow to start.
  await preview.start(track);
}

function samePanelState(a: PanelState, b: PanelState): boolean {
  return (
    a.settings === b.settings &&
    a.palette === b.palette &&
    a.paletteFor === b.paletteFor &&
    a.artPending === b.artPending &&
    a.track?.key === b.track?.key &&
    a.track?.title === b.track?.title &&
    a.track?.artist === b.track?.artist
  );
}

const host = document.getElementById("app");
if (host) {
  host.setAttribute("aria-busy", "true");
  void boot(host);
}
