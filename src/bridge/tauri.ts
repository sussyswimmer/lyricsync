import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ArgsOf, Bridge, Command, Event, Events, ResultOf, Unlisten } from "./types";

/** The real bridge: Tauri commands and events, typed by the contract. Argument names are camelCase. */
export function createTauriBridge(): Bridge {
  return {
    kind: "tauri",
    invoke<C extends Command>(command: C, ...args: ArgsOf<C>): Promise<ResultOf<C>> {
      return invoke<ResultOf<C>>(command, args[0]);
    },
    listen<E extends Event>(event: E, handler: (payload: Events[E]) => void): Promise<Unlisten> {
      return listen<Events[E]>(event, (e) => handler(e.payload));
    },
  };
}
