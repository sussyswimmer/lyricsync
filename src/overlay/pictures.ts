/**
 * The word pictures Effects mode shows beside sung words (core/wordpics.ts says which words call which).
 * Tiny transparent WebP stickers in `pictures/`, made once for Undertone with Higgsfield and bundled, so
 * they work offline and cost nothing per song.
 */
import type { PictureId } from "../core/wordpics";

const files = import.meta.glob<string>("./pictures/*.webp", { eager: true, query: "?url", import: "default" });

const URLS = new Map<string, string>();
for (const [path, url] of Object.entries(files)) {
  const id = /([\w-]+)\.webp$/u.exec(path)?.[1];
  if (id) URLS.set(id, url);
}

/** The bundled picture's URL; null for an id without a file. */
export function pictureUrl(id: PictureId): string | null {
  return URLS.get(id) ?? null;
}

const warmed = new Set<string>();

/**
 * Fetches and decodes pictures ahead (a song's, as its lyrics are drawn), so none is decoded on the
 * frame it pops in.
 */
export function warmPictures(ids: Iterable<PictureId>): void {
  if (typeof Image !== "function") return;
  for (const id of ids) {
    const url = pictureUrl(id);
    if (!url || warmed.has(url)) continue;
    warmed.add(url);
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    if (typeof img.decode === "function") img.decode().catch(() => warmed.delete(url));
  }
}
