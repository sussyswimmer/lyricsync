import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION, DEFAULT_SETTINGS } from "../contract/contract";
import { MOCK_TRACKS } from "../src/bridge/mock";
import { displayAccelerator } from "../src/core/accelerator";

/*
 * Regressions from the docs QA pass:
 * - readme-install-coverage: README linked docs/INSTALL.md (not written yet) for the Gatekeeper and
 *   SmartScreen steps, and said `pnpm coverage` covers src/core when the script also covers the bridge
 *   and the overlay's pure modules. (The development notes have since moved to CONTRIBUTING.md.)
 * - handoff-log-missing: docs/HANDOFF.md stopped at C4, so C5–C8 and every request to Codex were missing
 *   from the only channel between the two halves.
 * - docs-drift (2026-10-15 audit): LYRICS.md still said "the contract is v2" at v3, `--overlay-probe` was
 *   documented only in HANDOFF.md, and DESKTOP_LAYER.md, SPEC.md and the work orders had no link check.
 * Plus the facts the docs repeat from code (demo tracks, defaults, flags, commands and events), so they
 * can't drift apart unnoticed.
 */

interface Fs {
  readFileSync(path: URL, encoding: "utf8"): string;
  existsSync(path: URL): boolean;
  readdirSync(path: URL, options?: { recursive?: boolean }): string[];
}

// Through a variable, so the strict config (no Node types) doesn't resolve the module. Loaded before
// the suites are collected, because the list of docs below decides which tests there are.
const fsModule = "node:fs";
const fs = (await import(/* @vite-ignore */ fsModule)) as Fs;

const ROOT = new URL("../", import.meta.url);
const read = (path: string): string => fs.readFileSync(new URL(path, ROOT), "utf8");
const markdown = (dir: string): string[] =>
  fs
    .readdirSync(new URL(dir || "./", ROOT))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `${dir}${f}`);

/** Every Markdown file at the root and in docs/, so a new doc is checked without being listed here. */
const DOCS: readonly string[] = [...markdown(""), ...markdown("docs/")].sort();
/** CLAUDE.md and AGENTS.md are the original work orders and HANDOFF.md is a log: they keep what was true then. */
const HISTORY = new Set(["CLAUDE.md", "AGENTS.md", "docs/HANDOFF.md"]);
/** The docs that describe the code as it is now. */
const CURRENT = DOCS.filter((doc) => !HISTORY.has(doc));

/** Every `--flag` string the Rust core has: what the app reads from its command line. */
function appFlags(): Set<string> {
  const rust = fs.readdirSync(new URL("src-tauri/src/", ROOT), { recursive: true }).filter((f) => f.endsWith(".rs"));
  return new Set(rust.flatMap((f) => [...read(`src-tauri/src/${f}`).matchAll(/"(--[a-z][a-z0-9-]*)"/g)].map((m) => m[1] ?? "")));
}

/** Markdown without fenced code blocks (a `# comment` in a shell block is not a heading). */
function prose(md: string): string {
  return md.replace(/^```[\s\S]*?^```/gm, "");
}

/** GitHub's anchor for a heading: lowercase, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

function anchors(md: string): Set<string> {
  const out = new Set<string>();
  for (const m of prose(md).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(m[1] ?? "");
    let id = base;
    for (let n = 1; out.has(id); n++) id = `${base}-${n}`;
    out.add(id);
  }
  return out;
}

/** Every `[text](target)` link outside code, and every `href`, `src` and `srcset` of inline HTML (the README's images and badges). */
function links(md: string): string[] {
  const text = prose(md).replace(/`[^`\n]*`/g, "");
  const markdown = [...text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? "");
  const html = [...text.matchAll(/\b(?:href|src|srcset)="([^"\s]+)"/g)].map((m) => m[1] ?? "");
  return [...markdown, ...html];
}

describe("slug", () => {
  it("matches GitHub's anchors for the headings the docs link to", () => {
    expect(slug("macOS: Automation")).toBe("macos-automation");
    expect(slug("Loading, missing and unsynced lyrics")).toBe("loading-missing-and-unsynced-lyrics");
    expect(slug("Menu bar / tray menu")).toBe("menu-bar--tray-menu");
  });
});

describe("doc links", () => {
  it("finds the docs", () => {
    expect(DOCS).toEqual(expect.arrayContaining(["README.md", "SPEC.md", "docs/USER_GUIDE.md", "docs/HANDOFF.md", "docs/ACCEPTANCE.md"]));
  });

  for (const doc of DOCS) {
    it(`${doc}: every relative link points at a file (and heading) that exists`, () => {
      const base = new URL(doc, ROOT);
      const broken: string[] = [];
      for (const target of links(read(doc))) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, https:, mailto:
        const [path = "", hash] = target.split("#");
        const file = path ? new URL(path, base) : base;
        if (!fs.existsSync(file)) {
          broken.push(`${target} (no such file)`);
          continue;
        }
        if (hash && /\.md$/i.test(file.pathname) && !anchors(fs.readFileSync(file, "utf8")).has(hash)) {
          broken.push(`${target} (no such heading)`);
        }
      }
      expect(broken).toEqual([]);
    });
  }

  it("README walks through the unsigned-build warnings itself", () => {
    const readme = read("README.md");
    expect(readme).toMatch(/Privacy & Security/);
    expect(readme).toMatch(/Open Anyway/);
    expect(readme).toMatch(/More info\*\*, then \*\*Run anyway/);
  });
});

describe("development notes (docs/DEVELOPMENT.md)", () => {
  it("names everything `pnpm coverage` measures", () => {
    // vite.config.ts's test.coverage.include
    const list = /coverage:\s*\{[\s\S]*?include:\s*\[([^\]]*)\]/.exec(read("vite.config.ts"))?.[1] ?? "";
    const includes = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(includes.length).toBeGreaterThan(0);
    const line = read("docs/DEVELOPMENT.md")
      .split("\n")
      .find((l) => l.startsWith("pnpm coverage"));
    expect(line).toBeDefined();
    const comment = line?.slice(line.indexOf("#")) ?? "";
    for (const glob of includes) {
      const path = glob.replace(/\/\*\*$/, "");
      const name = path.split("/").pop() ?? path;
      expect(comment.includes(path) || comment.includes(name), `${glob} missing from: ${comment}`).toBe(true);
    }
  });

  it("lists the mock's demo tracks as the mock defines them", () => {
    const readme = read("docs/DEVELOPMENT.md");
    const rows = [...readme.matchAll(/^\| (\d+) \| ([^|]+?) \| [^|]+ \|$/gm)].map((m) => [Number(m[1]), (m[2] ?? "").trim()]);
    expect(rows).toEqual(MOCK_TRACKS.map((t, i) => [i, t.title]));
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
    expect(readme).toContain(`The mock plays ${words[MOCK_TRACKS.length] ?? MOCK_TRACKS.length} demo tracks`);
    expect(readme).toContain(`Start on demo track N (0–${MOCK_TRACKS.length - 1})`);
  });
});

// Regression (dev-flag-double-dash): the docs ran `pnpm tauri dev -- --media-test`. tauri dev hands what
// follows the first `--` to cargo and what follows a second one to the app (pnpm passes `--` through
// as is), so cargo got the app's flag and refused to run.
describe("debug flags in the docs", () => {
  it("reach the app: `pnpm tauri dev -- -- <flag>`", () => {
    const flags = appFlags();
    expect([...flags]).toEqual(expect.arrayContaining(["--media-test", "--desktop-layer-test"]));

    const runs: string[] = [];
    const wrong: string[] = [];
    for (const doc of DOCS) {
      for (const m of read(doc).matchAll(/pnpm (?:exec )?tauri dev\b([^`\n#]*)/g)) {
        const args = (m[1] ?? "").trim().split(/\s+/).filter(Boolean);
        const firstFlag = args.findIndex((a) => flags.has(a));
        if (firstFlag < 0) continue;
        const toCargo = args.indexOf("--");
        const toApp = toCargo < 0 ? -1 : args.indexOf("--", toCargo + 1);
        runs.push(`${doc}: ${m[0].trim()}`);
        if (toApp < 0 || firstFlag < toApp) wrong.push(`${doc}: ${m[0].trim()}`);
      }
    }
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(wrong).toEqual([]);
  });

  // Regression (docs-drift): `--overlay-probe`, the check for the covered-overlay fix, was only in HANDOFF.md.
  it("are each explained in a doc other than the handoff log", () => {
    const flags = [...appFlags()];
    expect(flags).toEqual(expect.arrayContaining(["--media-test", "--desktop-layer-test", "--desktop-layer-all", "--overlay-probe", "--diagnose"]));
    const text = CURRENT.map(read).join("\n");
    const missing = flags.filter((flag) => !new RegExp(`(?<![\\w-])${flag}(?![\\w-])`).test(text));
    expect(missing).toEqual([]);
  });

  // Contract v4: the forced look for QA (`--look`, any build) is spelled out where people look for it.
  it("--look is explained in docs/DEVELOPMENT.md with its grammar and how to pass it", () => {
    expect([...appFlags()]).toContain("--look");
    const readme = read("docs/DEVELOPMENT.md");
    expect(readme).toContain("--look=<style>[,<family>[,<curve>]]");
    expect(readme).toContain("pnpm tauri dev -- -- --look=lens");
  });
});

// Regression (docs-drift): LYRICS.md said "The shared contract is v2" a version after v3 landed. A claim
// in the present tense must name the current version; "contract v2 adds …" is history and may stay.
describe("contract version in the docs", () => {
  it("every \"contract is vN\" names CONTRACT_VERSION", () => {
    const claims = CURRENT.flatMap((doc) => [...read(doc).matchAll(/\bcontract is (?:now )?v(\d+)\b/gi)].map((m) => `${doc}: ${m[0]}`));
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.filter((claim) => !claim.endsWith(`v${CONTRACT_VERSION}`))).toEqual([]);
  });
});

// SPEC.md is the contract's reference: it names every command the core registers and every event it
// sends, as Rust declares them.
describe("SPEC.md and the core", () => {
  it("lists every command in generate_handler! and every event constant", () => {
    const handler = /generate_handler!\[([\s\S]*?)\]/.exec(read("src-tauri/src/lib.rs"))?.[1] ?? "";
    // debug_probe is a debug-only helper for `--overlay-probe`, not part of the contract.
    const commands = [...handler.matchAll(/commands::(\w+)/g)].map((m) => m[1] ?? "").filter((name) => name !== "debug_probe");
    const events = [...read("src-tauri/src/contract.rs").matchAll(/pub const \w+_EVENT: &str = "([^"]+)";/g)].map((m) => m[1] ?? "");
    expect(commands.length).toBeGreaterThanOrEqual(11);
    expect(events.length).toBeGreaterThanOrEqual(5);
    const spec = read("SPEC.md");
    expect(commands.filter((name) => !spec.includes(`\`${name}(`))).toEqual([]);
    expect(events.filter((name) => !spec.includes(`\`${name}\``))).toEqual([]);
  });
});

describe("user guide", () => {
  const d = DEFAULT_SETTINGS;
  it("quotes the contract's defaults", () => {
    const guide = read("docs/USER_GUIDE.md");
    expect(guide).toContain(`from 22 to 140 (default ${d.size})`);
    expect(guide).toContain(`How much the words move as they're sung, from 0 to 100 (default ${d.effects})`);
    expect(guide).toContain(`How much the word being sung glows, from 0 to 100 (default ${d.glow})`);
    expect(guide).toContain(`from 20% to 100% (default ${d.opacity}%)`);
    for (const hex of Object.values(d.colors)) expect(guide).toContain(`\`${hex.toUpperCase()}\``);
    expect(guide).toContain("from −2000 to +2000 ms");
  });

  it("has no Height setting since contract v6, and says the lyrics sit in the middle", () => {
    const guide = read("docs/USER_GUIDE.md");
    expect(guide).not.toMatch(/^### Height$/mu);
    expect(guide).not.toMatch(/\bHeight\b/u);
    expect(guide).toContain("The lyrics always sit in the middle of the screen");
  });
});

// Contract v4: Undertone picks the style and the font for each song. The docs say so, describe the
// window and the menu as they are (Picked for this song, Look, Effects ▸), and offer no way to choose.
describe("the look picked per song in the docs", () => {
  it("the guide explains the pick, the card and the Look group, and has no Style, Font or Curve to set", () => {
    const guide = read("docs/USER_GUIDE.md");
    for (const heading of ["## Look", "### Picked for this song", "### The six styles", "### Effects", "### Glow"]) {
      expect(guide).toContain(`\n${heading}\n`);
    }
    for (const gone of ["## Style", "## Font", "## Layout", "### Curve"]) expect(guide).not.toContain(`\n${gone}\n`);
    for (const label of ["Picked for this song", "Finding lyrics…", "No lyrics for this song", "**Calm**", "**Lively**"]) expect(guide).toContain(label);
  });

  it("no doc of the app as it is now offers a Style ▸ menu or a font to pick", () => {
    for (const doc of CURRENT) {
      const text = read(doc);
      expect(text, doc).not.toMatch(/Style ▸/);
      expect(text, doc).not.toMatch(/your choice of font|pick a font|Font group/i);
    }
    expect(read("docs/USER_GUIDE.md")).toContain("**Effects ▸** Calm / Balanced / Lively");
  });
});

// Contract v3: the docs show the default shortcuts exactly as the Settings window writes them
// (Apple's ⌃⌥⇧⌘ order on a Mac), and name the controls the way the window labels them.
describe("shortcuts and the General switches in the docs", () => {
  const d = DEFAULT_SETTINGS.shortcuts;
  const defaults = [d.toggleLyrics, d.nudgeEarlier, d.nudgeLater];

  it("quote every default shortcut in the macOS and Windows notation Settings uses", () => {
    // the README is pictures and links since 2026-10-19; the user guide lists the shortcuts
    for (const doc of ["docs/USER_GUIDE.md"]) {
      const text = read(doc);
      for (const binding of defaults) {
        expect(text, doc).toContain(displayAccelerator(binding, "mac"));
        expect(text, doc).toContain(displayAccelerator(binding, "windows"));
      }
      // the old, non-Apple order
      expect(text, doc).not.toMatch(/⌘⌥⇧/);
      // they are defaults, which Settings can change
      expect(text, doc).toMatch(/Settings › Shortcuts/);
    }
  });

  it("the guide names the window's controls as it labels them", () => {
    const guide = read("docs/USER_GUIDE.md");
    for (const heading of ["## General", "### Lyrics on the desktop", "### Launch at login", "### When", "### Where", "## Shortcuts"]) {
      expect(guide).toContain(`\n${heading}\n`);
    }
    for (const label of ["Keyboard shortcuts", "Reset shortcuts", "Press keys…", "Another app is using this combination.", "Off on the desktop"]) {
      expect(guide).toContain(label);
    }
    // Reset to defaults leaves the two General switches alone
    expect(guide).toContain("**Lyrics on the desktop** and **Launch at login** stay as they are.");
    // the Behavior rows were "Show lyrics" and "Show on" before the lyrics switch existed
    expect(guide).not.toMatch(/Show lyrics: |Show on: /);
  });
});

describe("handoff log", () => {
  interface Entry {
    date: string;
    author: string;
    milestone: string;
    body: string;
  }
  const entries = (): Entry[] =>
    read("docs/HANDOFF.md")
      .split(/^## /m)
      .slice(1)
      .map((chunk) => {
        const [head = "", ...rest] = chunk.split("\n");
        const [date = "", author = "", milestone = ""] = head.split(" · ").map((s) => s.trim());
        return { date, author, milestone, body: rest.join("\n") };
      });

  it("uses the SPEC heading format for every entry", () => {
    for (const e of entries()) {
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.author).not.toBe("");
      expect(e.milestone).not.toBe("");
    }
  });

  it("logs every frontend milestone, each with Done / Needs from Codex / Contract", () => {
    const ours = entries().filter((e) => e.author === "Claude Code");
    for (const task of ["C1", "C4", "C5", "C6", "C7", "C8"]) {
      expect(ours.some((e) => e.milestone.includes(task)), `no entry for ${task}`).toBe(true);
    }
    for (const e of ours) {
      expect(e.body, e.milestone).toMatch(/^Done: /m);
      expect(e.body, e.milestone).toMatch(/^Needs from Codex:/m);
      expect(e.body, e.milestone).toMatch(/^Contract: /m);
    }
  });

  it("carries the requests to Codex", () => {
    const log = read("docs/HANDOFF.md");
    // the ones the real app can't match the mock without
    expect(log).toMatch(/CloseRequested/);
    expect(log).toMatch(/set_track_offset/);
    expect(log).toMatch(/get_lyrics/);
    expect(log).toMatch(/visibilityState/);
  });
});
