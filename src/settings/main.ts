import "@fontsource/figtree/400.css";
import "@fontsource/figtree/500.css";
import "@fontsource/figtree/600.css";
import "../styles/settings.css";
import { DEFAULT_SETTINGS, type MediaStatus, type NowPlaying, type Settings, type ShortcutsStatus } from "../../contract/contract";
import { connect } from "../bridge";
import { PaletteCache } from "../core/palette";
import { h } from "../overlay/dom";
import { TrackHold } from "./hold";
import { SettingsPanel, type PanelState } from "./panel";
import { SettingsPreview, type PreviewInfo } from "./preview";
import { defaultsPatch, SettingsSync, withDefaults } from "./store";

async function boot(host: HTMLElement): Promise<void> {
  const bridge = await connect();

  // Subscribe first, then read the initial state, so nothing that happens in between is lost.
  // An event that beats its query's reply is newer than the reply.
  const early: {
    settings: Settings | null;
    track: NowPlaying | null;
    heardTrack: boolean;
    media: MediaStatus | null;
    shortcuts: ShortcutsStatus | null;
  } = {
    settings: null,
    track: null,
    heardTrack: false,
    media: null,
    shortcuts: null,
  };
  let onSettings = (s: Settings): void => {
    early.settings = s;
  };
  let onTrack = (np: NowPlaying | null): void => {
    early.track = np;
    early.heardTrack = true;
  };
  let onMedia = (m: MediaStatus): void => {
    early.media = m;
  };
  let onShortcuts = (status: ShortcutsStatus): void => {
    early.shortcuts = status;
  };
  await bridge.listen("settings-changed", (s) => onSettings(s));
  await bridge.listen("now-playing", (np) => onTrack(np));
  await bridge.listen("media-status", (m) => onMedia(m));
  await bridge.listen("shortcuts-status", (status) => onShortcuts(status));
  const [fetched, fetchedTrack, fetchedMedia, fetchedShortcuts] = await Promise.all([
    bridge.invoke("get_settings").catch(() => structuredClone(DEFAULT_SETTINGS)),
    bridge.invoke("get_now_playing").catch(() => null),
    // Contract v2. A core without it rejects, and the window stays as it was before media-status.
    bridge.invoke("get_media_status").catch(() => null),
    // Contract v3. A core without it rejects, and the shortcut rows show no status.
    bridge.invoke("get_shortcuts_status").catch(() => null),
  ]);

  const track: NowPlaying | null = early.heardTrack ? early.track : fetchedTrack;
  // An older core's settings lack the contract v3 fields; the window shows their defaults.
  let view: Settings = withDefaults(early.settings ?? fetched);
  let media: MediaStatus | null = early.media ?? fetchedMedia;
  let shortcuts: ShortcutsStatus | null = early.shortcuts ?? fetchedShortcuts;
  let loginError = false;
  /** The value a refused Launch at login change asked for: once the settings reach it (from the menu, or the
   * core taking the login item's real state), the note under the switch no longer applies. */
  let loginErrorFor: boolean | null = null;
  let info: PreviewInfo = { track: null, demo: false, palette: null, paletteFrom: null, artPending: false };

  const palettes = new PaletteCache();
  // Created below; the closures only run after both exist.
  let panel: SettingsPanel | null = null;
  let preview: SettingsPreview | null = null;

  // The panel's song rides out the brief "nothing playing" between songs (as the preview does), so the
  // sync controls neither flash "Nothing playing" nor drop keyboard focus on every track change.
  const held = new TrackHold<NowPlaying>(track, () => render());

  // now-playing resyncs arrive about once a second; only a change the panel shows re-renders it.
  let shown: PanelState | null = null;
  const render = (): void => {
    const song = held.value;
    const state: PanelState = {
      settings: view,
      palette: info.palette,
      paletteFor: info.demo ? null : info.paletteFrom,
      artPending: info.artPending,
      track: song ? { key: song.trackKey, title: song.title, artist: song.artist } : null,
      media,
      shortcuts,
      loginError,
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
      if (loginError && next.launchAtLogin === loginErrorFor) loginError = false;
      preview?.setSettings(next);
      render();
    },
    onError: (error, write) => {
      console.warn("Undertone: couldn't save settings", error);
      // The core keeps Launch at login as it was when the OS refuses the login item; the switch has
      // already snapped back to it, and the note under it says why.
      if (write.kind === "patch" && write.patch.launchAtLogin !== undefined) {
        loginError = true;
        loginErrorFor = write.patch.launchAtLogin;
        render();
        panel?.announce("Couldn't change Launch at login");
        return;
      }
      panel?.announce("Couldn't save that change");
    },
  });

  // In order, so a quick start and stop of the key recorder can't reach the core the other way round.
  let suspending: Promise<void> = Promise.resolve();
  const suspendShortcuts = (suspended: boolean): void => {
    suspending = suspending
      .then(() => bridge.invoke("suspend_shortcuts", { suspended }))
      // An older core has no such command; its shortcuts just stay on while recording.
      .catch(() => undefined);
  };

  panel = new SettingsPanel({
    edit: (patch) => sync.edit(patch),
    editNow: (patch) => {
      if (patch.launchAtLogin !== undefined) loginError = false;
      sync.editNow(patch);
    },
    setTrackOffset: (key, ms) => sync.setTrackOffset(key, ms),
    reset: (forgetSongs) => {
      const offsets = Object.entries(view.trackOffsetsMs);
      sync.edit(defaultsPatch());
      sync.flush();
      if (forgetSongs) for (const [key, ms] of offsets) if (ms !== 0) sync.setTrackOffset(key, 0);
    },
    suspendShortcuts,
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
    preview?.setMainTrack(np);
    held.set(np);
  };
  onMedia = (m) => {
    media = m;
    render();
  };
  onShortcuts = (status) => {
    shortcuts = status;
    render();
  };
  render();

  // Don't drop an edit made just before the window hides or closes, and never leave the global
  // shortcuts suspended by a key recorder still listening in a window that is gone.
  const leave = (): void => {
    panel?.cancelRecording();
    sync.flush();
  };
  window.addEventListener("pagehide", leave);
  window.addEventListener("blur", leave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") leave();
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
    a.track?.artist === b.track?.artist &&
    a.media?.source === b.media?.source &&
    a.media?.problem === b.media?.problem &&
    a.shortcuts?.toggleLyrics === b.shortcuts?.toggleLyrics &&
    a.shortcuts?.nudgeEarlier === b.shortcuts?.nudgeEarlier &&
    a.shortcuts?.nudgeLater === b.shortcuts?.nudgeLater &&
    a.loginError === b.loginError
  );
}

const host = document.getElementById("app");
if (host) {
  host.setAttribute("aria-busy", "true");
  void boot(host);
}
