import { describe, expect, it } from "vitest";
import { readRepo as read } from "./helpers";

/*
 * THIRD_PARTY_NOTICES.txt carries the notices the bundled fonts (OFL 1.1 §2), @tauri-apps/api and the
 * Rust crates require with every copy. scripts/notices.mjs writes it and CI's `--check` keeps it current
 * with the lockfiles; these tests guard what the file must say and that the installers ship it.
 */

interface Pkg {
  name: string;
  version: string;
  license: string;
  dependencies?: Record<string, string>;
}

describe("third-party notices", () => {
  it("credits every bundled font with its copyright line and the OFL text", () => {
    const notices = read("THIRD_PARTY_NOTICES.txt");
    const fonts = Object.keys((JSON.parse(read("package.json")) as Pkg).dependencies ?? {}).filter((name) =>
      name.startsWith("@fontsource/"),
    );
    expect(fonts.length).toBeGreaterThan(0);
    for (const name of fonts) {
      const pkg = JSON.parse(read(`node_modules/${name}/package.json`)) as Pkg;
      expect(pkg.license, name).toBe("OFL-1.1");
      const copyright = read(`node_modules/${name}/LICENSE`).split(/\r?\n/)[0] ?? "";
      expect(notices, name).toContain(copyright.trim());
    }
    expect(notices).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });

  it("covers the JavaScript bundled into the pages and the app's direct Rust dependencies", () => {
    const notices = read("THIRD_PARTY_NOTICES.txt");
    const api = JSON.parse(read("node_modules/@tauri-apps/api/package.json")) as Pkg;
    expect(notices).toContain(`${api.name} ${api.version}`);
    for (const crate of ["tauri", "serde", "reqwest", "image", "tokio"]) {
      expect(notices).toMatch(new RegExp(`^${crate} \\d+\\.\\d+\\.\\d+: `, "m"));
    }
  });

  it("ships next to the app in both installers", () => {
    const config = JSON.parse(read("src-tauri/tauri.conf.json")) as { bundle: { resources?: Record<string, string> } };
    expect(config.bundle.resources).toEqual({ "../THIRD_PARTY_NOTICES.txt": "THIRD_PARTY_NOTICES.txt" });
  });
});
