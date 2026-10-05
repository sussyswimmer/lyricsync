import type { Bridge } from "./types";

export type { Bridge } from "./types";

/** True inside a Tauri webview, unless `?mock` asks for the mock anyway. */
export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window && !new URLSearchParams(window.location.search).has("mock");
}

/** The Tauri bridge inside the app, the mock in a plain browser or with `?mock`. */
export async function connect(): Promise<Bridge> {
  if (isTauri()) return (await import("./tauri")).createTauriBridge();
  return (await import("./mock")).createMockBridge();
}
