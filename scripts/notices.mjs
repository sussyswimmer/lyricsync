#!/usr/bin/env node
// Writes THIRD_PARTY_NOTICES.txt: the copyright notices and license texts of everything the
// installers ship. The OFL fonts, @tauri-apps/api and the Rust crates all require their notices to
// travel with every copy; the bundle copies this file next to the app and Settings › Licenses shows it.
//
//   node scripts/notices.mjs           regenerate the file
//   node scripts/notices.mjs --check   exit 1 if the file is out of date (CI)
//
// Rust crates come from `cargo metadata` for each shipped target: only normal (not build or dev)
// dependencies reachable from the app. Reading their license files needs the crates downloaded
// (`cargo fetch --target <triple>` for each target, which `cargo metadata` does by itself).

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "THIRD_PARTY_NOTICES.txt");
/** The targets the release builds: the universal macOS app holds both Mac architectures. */
const TARGETS = ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc"];
/** JavaScript that ends up in the built pages, besides the fonts. Vite adds a few lines of its own. */
const JS_PACKAGES = ["@tauri-apps/api", "vite"];
const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright|unlicense)([-._].*)?$/i;

/** Line endings, trailing spaces and blank-line runs differ between copies of the same text. */
function tidy(text) {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Two texts that differ only in spacing are the same license. */
const sameness = (text) => text.replace(/\s+/g, " ").trim();

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function rule(title) {
  return `${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`;
}

function fonts() {
  const deps = Object.keys(readJson(join(ROOT, "package.json")).dependencies ?? {})
    .filter((name) => name.startsWith("@fontsource/"))
    .sort();
  let body = null;
  const rows = deps.map((name) => {
    const dir = join(ROOT, "node_modules", name);
    const pkg = readJson(join(dir, "package.json"));
    if (pkg.license !== "OFL-1.1") throw new Error(`${name} is ${pkg.license}, not OFL-1.1`);
    const lines = tidy(readFileSync(join(dir, "LICENSE"), "utf8")).split("\n");
    // Fontsource's LICENSE: the font's copyright line, a blank line, then the OFL preamble and text.
    const text = tidy(lines.slice(1).join("\n"));
    body ??= text;
    if (sameness(text) !== sameness(body)) throw new Error(`${name}'s license text differs from the others`);
    return `${pkg.name.replace("@fontsource/", "")} ${pkg.version} (${name})\n  ${lines[0]}`;
  });
  return [
    rule("Fonts: SIL Open Font License 1.1"),
    "Undertone bundles these fonts. Each is licensed under the SIL Open Font License,\nVersion 1.1, copied once below the list.",
    rows.join("\n\n"),
    body ?? "",
  ].join("\n\n");
}

function licenseFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isFile() && LICENSE_FILE.test(entry)) found.push(path);
    else if (stat.isDirectory() && /^licen[cs]es$/i.test(entry)) {
      for (const inner of readdirSync(path).sort()) {
        if (statSync(join(path, inner)).isFile()) found.push(join(path, inner));
      }
    }
  }
  return found;
}

function javascript() {
  const blocks = JS_PACKAGES.map((name) => {
    const dir = join(ROOT, "node_modules", name);
    const pkg = readJson(join(dir, "package.json"));
    const texts = licenseFiles(dir)
      .filter((path) => !path.endsWith(".spdx"))
      .map((path) => `--- ${relative(dir, path)} ---\n\n${tidy(readFileSync(path, "utf8"))}`);
    if (texts.length === 0) throw new Error(`${name} has no license file`);
    return [`${pkg.name} ${pkg.version} (${pkg.license})`, ...texts].join("\n\n");
  });
  return [rule("JavaScript"), ...blocks].join("\n\n");
}

/** Every normal dependency reachable from the app on one target, by package id. */
function shipped(metadata) {
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const seen = new Set();
  const stack = [metadata.resolve.root];
  while (stack.length > 0) {
    const node = nodes.get(stack.pop());
    for (const dep of node?.deps ?? []) {
      if (seen.has(dep.pkg) || !dep.dep_kinds.some((kind) => kind.kind === null)) continue;
      seen.add(dep.pkg);
      stack.push(dep.pkg);
    }
  }
  return seen;
}

function crates() {
  const packages = new Map();
  for (const target of TARGETS) {
    const metadata = JSON.parse(
      execFileSync(
        "cargo",
        ["metadata", "--format-version", "1", "--locked", "--features", "desktop", "--filter-platform", target],
        { cwd: join(ROOT, "src-tauri"), encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
      ),
    );
    const ids = shipped(metadata);
    for (const pkg of metadata.packages) if (ids.has(pkg.id)) packages.set(pkg.id, pkg);
  }
  const list = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

  // One copy of each distinct text, with the crates that carry it.
  const texts = new Map();
  const rows = [];
  for (const pkg of list) {
    const dir = dirname(pkg.manifest_path);
    const files = licenseFiles(dir);
    if (pkg.license_file && !files.some((path) => path === join(dir, pkg.license_file))) {
      const path = join(dir, pkg.license_file);
      if (existsSync(path)) files.push(path);
    }
    const label = `${pkg.name} ${pkg.version}`;
    const refs = [];
    for (const path of files) {
      const text = tidy(readFileSync(path, "utf8"));
      if (text === "") continue;
      const key = sameness(text);
      if (!texts.has(key)) texts.set(key, { text, users: [] });
      const entry = texts.get(key);
      entry.users.push(label);
      refs.push(entry);
    }
    const authors = pkg.authors?.length ? ` by ${pkg.authors.join(", ")}` : "";
    rows.push({ label: `${label}: ${pkg.license ?? "see license file"}${authors}`, license: pkg.license ?? "", refs });
  }
  const numbered = [...texts.values()];
  numbered.forEach((entry, i) => (entry.number = i + 1));
  const line = (row) => {
    if (row.refs.length > 0) return `${row.label}\n  texts: ${[...new Set(row.refs.map((r) => `[${r.number}]`))].join(" ")}`;
    // A crate published without its license file: point at another crate's copy of the same terms.
    const terms = row.license
      .split(/\s+(?:OR|AND|WITH)\s+|[()/]/)
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => {
        const copy = STANDARD[id] && numbered.find((entry) => STANDARD[id].every((re) => re.test(entry.text)));
        return copy ? `${id} as in [${copy.number}]` : id;
      });
    return `${row.label}\n  no license file in the package; standard terms: ${terms.join(", ")}`;
  };
  return [
    rule("Rust crates"),
    `Undertone's desktop app is built from these ${list.length} Rust crates. Each line names the\ncrate, its license and its authors, then the license texts it carries, numbered below.`,
    rows.map(line).join("\n"),
    ...numbered.map((entry) => `--- [${entry.number}] used by ${entry.users.join(", ")} ---\n\n${entry.text}`),
  ].join("\n\n");
}

/** How to recognize a copy of each standard license among the texts other crates carry. */
const STANDARD = {
  MIT: [/Permission is hereby granted, free of charge/],
  "Apache-2.0": [/Apache License\s+Version 2\.0/, /TERMS AND CONDITIONS/],
  Zlib: [/This software is provided ['‘]as-is['’]/],
  "BSD-3-Clause": [/Redistribution and use in source and binary forms/, /Neither the name/],
  "MPL-2.0": [/Mozilla Public License Version 2\.0/],
};

function render() {
  return `${[
    "Undertone: third-party notices",
    "Generated by scripts/notices.mjs from the project's dependencies. Do not edit by hand.",
    fonts(),
    javascript(),
    crates(),
  ].join("\n\n")}\n`;
}

const text = render();
if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== text) {
    console.error("THIRD_PARTY_NOTICES.txt is out of date: run `node scripts/notices.mjs` and commit it.");
    process.exit(1);
  }
  console.log("THIRD_PARTY_NOTICES.txt is up to date.");
} else {
  writeFileSync(OUT, text);
  console.log(`Wrote ${relative(ROOT, OUT)} (${(text.length / 1024).toFixed(0)} KB).`);
}
