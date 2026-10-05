import type { Lyrics, NowPlaying, Settings } from "../../contract/contract";

type NoArgs = Record<string, never>;

/** Every command in contract v1: the arguments it takes and what it resolves to. */
export interface Commands {
  get_settings: { args: NoArgs; result: Settings };
  update_settings: { args: { patch: Partial<Settings> }; result: Settings };
  get_now_playing: { args: NoArgs; result: NowPlaying | null };
  get_lyrics: { args: { trackKey: string }; result: Lyrics };
  refetch_lyrics: { args: { trackKey: string }; result: void };
  set_track_offset: { args: { trackKey: string; ms: number }; result: Settings };
  open_settings: { args: NoArgs; result: void };
  quit: { args: NoArgs; result: void };
}

/** Every event in contract v1 and its payload. */
export interface Events {
  "now-playing": NowPlaying | null;
  lyrics: Lyrics;
  "settings-changed": Settings;
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
