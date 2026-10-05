import type { NowPlaying, Settings } from "../../contract/contract";
import type { Bridge, Unlisten } from "../bridge/types";
import type { MockBridge } from "../bridge/mock";
import { hexToHsl, hslToHex, type Palette, type PaletteCache } from "../core/palette";
import { OverlayController } from "../overlay/controller";
import { h } from "../overlay/dom";
import { LyricStage } from "../overlay/stage";
import { setText } from "./controls";
import { GAP_GRACE_MS } from "./hold";

/**
 * The preview stage counts this many px as 1× for `Settings.size` (the overlay uses 1080, which would
 * be an exact miniature). About 1.6× magnified: default-size lyrics read at about 15 px on the 176 px
 * tall stage under the preview's menu bar, yet lines wrap, fit and shrink nearly where they would on
 * the desktop, so moving the Size slider looks the way it will there. (At 2.5× every long Drift line
 * wrapped and Arc and Lens were already shrunk to fit, so size changes barely showed.)
 */
export const PREVIEW_REFERENCE_HEIGHT = 680;
/** Same grace as the overlay controller: a song without artwork keeps the last song's colors this long. */
const ARTWORK_GRACE_MS = 1500;
/** The demo plays these mock tracks (both synced) in a loop... */
const DEMO_TRACKS = [0, 1];
/** ...starting mid-verse, so switching to it never shows an empty intro. */
const DEMO_START_MS = 5000;

const SOURCE_LABEL: Record<NowPlaying["source"], string> = {
  spotify: "Spotify",
  "apple-music": "Music",
  system: "Now playing",
};

/** What the preview is showing, for the rest of the window. */
export interface PreviewInfo {
  track: NowPlaying | null;
  /** true when the preview plays the built-in demo because nothing is playing */
  demo: boolean;
  /**
   * The album colors the preview stage uses: the shown track's, or, while its artwork is still on the
   * way, the previous track's (as the overlay does). Null without artwork.
   */
  palette: Palette | null;
  /** title of the track `palette` came from */
  paletteFrom: string | null;
  /** true while the shown track's colors are still being worked out */
  artPending: boolean;
}

export interface PreviewOptions {
  /** The window's bridge. In mock mode the preview follows it directly. */
  bridge: Bridge;
  palettes: PaletteCache;
  settings: Settings;
  onInfo?: (info: PreviewInfo) => void;
}

type SourceKind = "main" | "demo";

/**
 * A miniature desktop at the top of the settings window: the real overlay stage and controller on
 * a wallpaper, with a slim menu bar naming the song. The stage starts below the bar (settings.css),
 * so its Height clamp never tucks the focus line under it. It plays the current track, or a private
 * demo player when nothing is playing (Tauri only; the mock always has a track). Settings come from
 * the window, not the bridge, so unsaved edits show at once.
 */
export class SettingsPreview {
  readonly el: HTMLElement;
  private readonly options: PreviewOptions;
  private readonly stage: LyricStage;
  private readonly cover: HTMLImageElement;
  private readonly title: HTMLElement;
  private readonly artist: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly wallpaper: HTMLElement;
  private settings: Settings;
  private controller: OverlayController | null = null;
  private demo: MockBridge | null = null;
  private sourceKind: SourceKind | null = null;
  private wanted: SourceKind = "main";
  private chain: Promise<void> = Promise.resolve();
  private unlistenSource: Unlisten[] = [];
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private artTimer: ReturnType<typeof setTimeout> | null = null;
  private info: PreviewInfo = { track: null, demo: false, palette: null, paletteFrom: null, artPending: false };
  private disposed = false;

  constructor(options: PreviewOptions) {
    this.options = options;
    this.settings = options.settings;

    this.el = h("section", "pv");
    this.el.setAttribute("aria-label", "Live preview");
    this.wallpaper = h("div", "pv-screen");
    const stageHost = h("div", "pv-stage");
    stageHost.setAttribute("aria-hidden", "true");
    const bar = h("div", "pv-bar");
    this.cover = h("img", "pv-cover");
    this.cover.alt = "";
    this.cover.width = 16;
    this.cover.height = 16;
    const text = h("p", "pv-track");
    this.title = h("span", "pv-title");
    this.artist = h("span", "pv-artist");
    text.append(this.title, this.artist);
    this.badge = h("span", "pv-badge");
    bar.append(this.cover, text, this.badge);
    this.wallpaper.append(stageHost, bar);
    this.el.append(this.wallpaper);

    this.stage = new LyricStage(stageHost, {
      referenceHeight: PREVIEW_REFERENCE_HEIGHT,
      onInvalidate: () => this.controller?.kick(),
    });
    this.stage.setSettings(this.settings);
    this.renderBar();
  }

  /**
   * Starts on the window's bridge, or straight on the demo when the app has nothing playing.
   * Afterwards `setMainTrack` moves between them.
   */
  start(np: NowPlaying | null): Promise<void> {
    return this.switchTo(np === null && this.options.bridge.kind !== "mock" ? "demo" : "main");
  }

  /** Every settings change, saved or not. */
  setSettings(settings: Settings): void {
    this.settings = settings;
    this.controller?.setSettings(settings);
  }

  /**
   * The window bridge's now-playing. Tauri: show the demo while nothing plays, the real track as soon
   * as one starts. The mock never reports nothing, so it never switches.
   */
  setMainTrack(np: NowPlaying | null): void {
    if (this.options.bridge.kind === "mock") return;
    if (np) {
      if (this.graceTimer) clearTimeout(this.graceTimer);
      this.graceTimer = null;
      void this.switchTo("main");
    } else if (!this.graceTimer && this.wanted === "main") {
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        void this.switchTo("demo");
      }, GAP_GRACE_MS); // a brief gap between songs never shows the demo
    }
  }

  get current(): PreviewInfo {
    return this.info;
  }

  dispose(): void {
    this.disposed = true;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.clearArtTimer();
    void this.chain.then(() => {
      this.detach();
      this.stage.destroy();
    });
  }

  /** Swaps are queued so a controller is never torn down while it is still starting. */
  private switchTo(kind: SourceKind): Promise<void> {
    this.wanted = kind;
    this.chain = this.chain.then(() => this.attach()).catch((error: unknown) => console.warn("preview:", error));
    return this.chain;
  }

  private async attach(): Promise<void> {
    const kind = this.wanted;
    if (this.disposed || kind === this.sourceKind) return;
    this.detach();
    this.sourceKind = kind;
    const bridge = kind === "demo" ? await this.createDemo() : this.options.bridge;
    const controller = new OverlayController(bridge, this.stage, {
      followSettings: false,
      palettes: this.options.palettes,
    });
    controller.setSettings(this.settings);
    this.controller = controller;
    this.unlistenSource.push(await bridge.listen("now-playing", (np) => this.onTrack(np)));
    await controller.start();
    this.onTrack(controller.track);
  }

  private detach(): void {
    for (const off of this.unlistenSource) off();
    this.unlistenSource = [];
    this.controller?.destroy();
    this.controller = null;
    this.demo?.dispose();
    this.demo = null;
    this.sourceKind = null;
  }

  /** A private, silent mock player (no keys, no storage, not shared with other windows). */
  private async createDemo(): Promise<Bridge> {
    const { createMockBridge, MOCK_TRACKS, trackKeyOf } = await import("../bridge/mock");
    const demo = createMockBridge({ shared: false, keys: false, storage: null, params: new URLSearchParams() });
    const keys = new Set(DEMO_TRACKS.flatMap((i) => (MOCK_TRACKS[i] ? [trackKeyOf(MOCK_TRACKS[i])] : [])));
    // Loop the synced demo songs instead of moving on to the not-found and instrumental ones.
    this.unlistenSource.push(
      await demo.listen("now-playing", (np) => {
        if (np && !keys.has(np.trackKey)) demo.player.select(DEMO_TRACKS[0] ?? 0);
      }),
    );
    demo.player.seek(DEMO_START_MS);
    this.demo = demo;
    return demo;
  }

  private onTrack(np: NowPlaying | null): void {
    if (this.disposed) return;
    const before = this.info;
    const sameArt = before.track?.trackKey === np?.trackKey && before.track?.artwork === np?.artwork;
    this.info = { ...before, track: np, demo: this.sourceKind === "demo" };
    if (!np) {
      this.clearArtTimer();
      this.info = { ...this.info, palette: null, paletteFrom: null, artPending: false };
      this.paintWallpaper();
    } else if (!sameArt) {
      this.loadPalette(np);
    }
    this.renderBar();
    this.options.onInfo?.(this.info);
  }

  /**
   * Album colors follow the artwork exactly as the overlay controller's do: the last song's colors stay
   * until this song's art is decoded, or for a grace period when it has none yet. So the swatches, the
   * caption and the wallpaper never flash "no cover art" while the art is on its way.
   */
  private loadPalette(np: NowPlaying): void {
    const { trackKey, artwork, title } = np;
    this.clearArtTimer();
    this.info = { ...this.info, artPending: true };
    const current = (): boolean => this.info.track?.trackKey === trackKey && this.info.track.artwork === artwork;
    void this.options.palettes.get(trackKey, artwork).then((palette) => {
      if (this.disposed || !current()) return;
      if (palette || artwork !== null) {
        // The demo's song names mean nothing to the user, so its colors stay unattributed.
        this.setPalette(palette, palette && this.sourceKind !== "demo" ? title : null);
        return;
      }
      this.artTimer = setTimeout(() => {
        this.artTimer = null;
        if (!this.disposed && current()) this.setPalette(null, null);
      }, ARTWORK_GRACE_MS);
    });
  }

  private setPalette(palette: Palette | null, from: string | null): void {
    this.info = { ...this.info, palette, paletteFrom: from, artPending: false };
    this.paintWallpaper();
    this.options.onInfo?.(this.info);
  }

  private clearArtTimer(): void {
    if (this.artTimer) clearTimeout(this.artTimer);
    this.artTimer = null;
  }

  /** Runs on every now-playing resync (about once a second), so it only touches what changed. */
  private renderBar(): void {
    const { track, demo } = this.info;
    const artwork = track?.artwork ?? null;
    this.cover.hidden = artwork === null;
    if (artwork !== null && this.cover.src !== artwork) this.cover.src = artwork;
    this.el.classList.toggle("pv-no-cover", artwork === null);
    setText(this.title, track ? track.title : this.sourceKind === null ? "" : "Nothing playing");
    setText(this.artist, track ? track.artist : "");
    const badge = demo ? "Demo" : track && !track.isPlaying ? "Paused" : track ? SOURCE_LABEL[track.source] : "";
    setText(this.badge, badge);
    this.badge.hidden = badge === "";
    const kind = demo ? "demo" : track && !track.isPlaying ? "paused" : "source";
    if (this.badge.dataset.kind !== kind) this.badge.dataset.kind = kind;
    const tip = track ? `${demo ? "Demo: " : ""}${track.title} by ${track.artist}` : "";
    if (this.el.title !== tip) this.el.title = tip;
  }

  /** A dark wallpaper tinted with the song's colors, like the prototype's desktop. */
  private paintWallpaper(): void {
    const p = this.info.palette;
    const style = this.wallpaper.style;
    if (!p) {
      style.removeProperty("--wp-1");
      style.removeProperty("--wp-2");
      style.removeProperty("--wp-3");
      return;
    }
    // The cover's main hue (carried, faintly, by the dim color) lights the top left; the highlight's
    // hue warms the bottom right, the way the prototype's desktop picked up the album.
    const [hh, hs] = hexToHsl(p.highlight);
    const [dh, ds] = hexToHsl(p.dim);
    const base = Math.min(ds * 2.5, 0.42);
    style.setProperty("--wp-1", hslToHex(dh, base, 0.075));
    style.setProperty("--wp-2", hslToHex(dh, base, 0.25));
    style.setProperty("--wp-3", hslToHex(hh, Math.min(hs, 0.5), 0.2));
  }
}
