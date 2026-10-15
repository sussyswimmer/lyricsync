import { beforeAll, describe, expect, it } from "vitest";

/*
 * src-tauri/capabilities/default.json grants the webviews exactly what the frontend uses, nothing of
 * core:default (tray, menu, window, app APIs) and no emitting: every page renders `settings-changed` and
 * `now-playing` from the payload, so a page that could emit could forge them for the others. These tests
 * derive the grant from the frontend's @tauri-apps/api imports, so a new import fails here until the
 * capability allows it, and a permission nothing uses fails until it is dropped.
 */

interface Fs {
  readFileSync(path: URL, encoding: "utf8"): string;
  readdirSync(path: URL, options: { recursive: true }): string[];
}

const ROOT = new URL("../", import.meta.url);
let fs: Fs;
const read = (path: string): string => fs.readFileSync(new URL(path, ROOT), "utf8");

beforeAll(async () => {
  // Through a variable, so the strict config (no Node types) doesn't resolve the module.
  const fsModule = "node:fs";
  fs = (await import(/* @vite-ignore */ fsModule)) as Fs;
});

const LISTEN = ["core:event:allow-listen", "core:event:allow-unlisten"];

/**
 * What each import needs from the capability. `invoke` reaches the app's own commands, which are open
 * to the app's pages while build.rs declares no app manifest. `listen` and `once` call
 * `plugin:event|listen`, and the function they resolve to calls `plugin:event|unlisten`.
 */
const NEEDS: Record<string, Record<string, readonly string[]>> = {
  "@tauri-apps/api/core": { invoke: [] },
  "@tauri-apps/api/event": { listen: LISTEN, once: LISTEN, UnlistenFn: [], Event: [] },
};

interface Capability {
  windows: string[];
  permissions: string[];
}

/** Every `@tauri-apps/*` import in src/: the module and the names it imports. */
function tauriImports(): { file: string; module: string; names: string[] }[] {
  const named = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"(@tauri-apps\/[^"]+)"/g;
  const out: { file: string; module: string; names: string[] }[] = [];
  for (const file of fs.readdirSync(new URL("src/", ROOT), { recursive: true })) {
    if (!/\.ts$/.test(file)) continue;
    const text = read(`src/${file}`);
    const found = [...text.matchAll(named)];
    // A default, namespace or dynamic import would slip past the named-import pattern.
    expect(text.split('"@tauri-apps/').length - 1, `${file}: only named imports of @tauri-apps`).toBe(found.length);
    for (const [, names = "", module = ""] of found) {
      out.push({
        file,
        module,
        names: names
          .split(",")
          .map((name) => name.replace(/^\s*type\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? "")
          .filter(Boolean),
      });
    }
  }
  return out;
}

describe("webview capability", () => {
  it("grants exactly what the frontend's Tauri imports need", () => {
    const imports = tauriImports();
    expect(imports.map((i) => i.module).sort()).toEqual(["@tauri-apps/api/core", "@tauri-apps/api/event"]);
    const needed = new Set<string>();
    for (const { file, module, names } of imports) {
      const table = NEEDS[module];
      expect(table, `${file}: ${module} has no entry here`).toBeDefined();
      for (const name of names) {
        const permissions = table?.[name];
        expect(permissions, `${file}: ${name} from ${module} has no entry here`).toBeDefined();
        for (const permission of permissions ?? []) needed.add(permission);
      }
    }
    const capability = JSON.parse(read("src-tauri/capabilities/default.json")) as Capability;
    expect([...capability.permissions].sort()).toEqual([...needed].sort());
  });

  it("keeps the app's commands open to its pages and never calls core directly", () => {
    // An app manifest (tauri_build::AppManifest) would put every command behind a permission too.
    expect(read("src-tauri/build.rs")).not.toContain("AppManifest");
    for (const file of fs.readdirSync(new URL("src/", ROOT), { recursive: true })) {
      if (!/\.ts$/.test(file)) continue;
      expect(read(`src/${file}`), file).not.toMatch(/plugin:|__TAURI_INTERNALS__\s*\.|__TAURI__/);
    }
  });
});
