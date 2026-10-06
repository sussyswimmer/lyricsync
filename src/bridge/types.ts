import type { Lyrics, MediaStatus, NowPlaying, Settings, ShortcutsStatus } from "../../contract/contract";

type NoArgs = Record<string, never>;

/** Every command in contract v3: the arguments it takes and what it resolves to. */
export interface Commands {
  get_settings: { args: NoArgs; result: Settings };
  update_settings: { args: { patch: Partial<Settings> }; result: Settings };
  get_now_playing: { args: NoArgs; result: NowPlaying | null };
  /** v2: an older core rejects it */
  get_media_status: { args: NoArgs; result: MediaStatus };
  /** v3: an older core rejects it */
  get_shortcuts_status: { args: NoArgs; result: ShortcutsStatus };
  /** v3: true while Settings records a new shortcut, so the current ones don't swallow its keys */
  suspend_shortcuts: { args: { suspended: boolean }; result: void };
  get_lyrics: { args: { trackKey: string }; result: Lyrics };
  refetch_lyrics: { args: { trackKey: string }; result: void };
  set_track_offset: { args: { trackKey: string; ms: number }; result: Settings };
  open_settings: { args: NoArgs; result: void };
  quit: { args: NoArgs; result: void };
}

/** Every event in contract v3 and its payload. */
export interface Events {
  "now-playing": NowPlaying | null;
  lyrics: Lyrics;
  "settings-changed": Settings;
  "media-status": MediaStatus;
  "shortcuts-status": ShortcutsStatus;
}

export type Command = keyof Commands;
export type Event = keyof Events;
/** Commands without arguments take none; the rest take their argument object. */
export type ArgsOf<C extends Command> = Commands[C]["args"] extends NoArgs ? [] : [Commands[C]["args"]];
export type ResultOf<C extends Command> = Commands[C]["result"];
export type Unlisten = () => void;

/** The only way the frontend talks to the Rust core. The mock implements the same surface. */
export interface Bridge {
  readonly kind: "tauri" | "mock";
  invoke<C extends Command>(command: C, ...args: ArgsOf<C>): Promise<ResultOf<C>>;
  listen<E extends Event>(event: E, handler: (payload: Events[E]) => void): Promise<Unlisten>;
}
