import { DEFAULT_SETTINGS, type Settings } from "../contract/contract";
import { parseLrc, type Line } from "../src/core/lrc";
import { resolveLook, type Frame, type Look } from "../src/overlay/look";
import type { Cue } from "../src/overlay/modes/types";
import paperLanterns from "./fixtures/paper-lanterns.lrc?raw";

/*
 * Helpers shared by the suites; not a test file itself.
 */

interface Fs {
  readFileSync(path: URL, encoding: "utf8"): string;
  existsSync(path: URL): boolean;
  readdirSync(path: URL, options?: { recursive?: boolean }): string[];
}

// A non-literal specifier, because the strict type check runs without node's types.
const fsModule = "node:fs";
export const fs = (await import(/* @vite-ignore */ fsModule)) as Fs;

export const ROOT = new URL("../", import.meta.url);

/**
 * A repo file's text, by its path from the repo root. Stylesheets are read this way because vitest
 * hands CSS imports (even ?raw) to its CSS pipeline, which yields "" in node.
 */
export const readRepo = (path: string): string => fs.readFileSync(new URL(path, ROOT), "utf8");

/** A stylesheet from the repo without its comments. */
export const stylesheet = (path: string): string => readRepo(path).replace(/\/\*[\s\S]*?\*\//g, "");

export const settings = (over: Partial<Settings> = {}): Settings => ({ ...structuredClone(DEFAULT_SETTINGS), ...over });

/** The look for `over` on a 1280×720 stage at 1× with motion on, unless `frame` says otherwise. */
export const look = (over: Partial<Settings> = {}, frame: Partial<Frame> = {}): Look =>
  resolveLook(settings(over), null, { width: 1280, height: 720, dpr: 1, motion: true, unsynced: false, ...frame });

/** Paper Lanterns' lyric lines (gaps dropped), as the stage hands them to a mode. */
export const LINES: Line[] = parseLrc(paperLanterns, 24_000).filter((l) => l.words.length > 0);

export const cue = (line: number, t: number, running = true, waiting = false): Cue => ({ line, t, running, waiting });
