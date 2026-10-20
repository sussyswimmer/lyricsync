/**
 * The power tier (SPEC §2.5). Full motion keeps tens of layers moving at display rate while a word is
 * sung, which a GPU composites for almost nothing. Where the compositor draws in software (virtual
 * machines, remote desktops, GPU-blocklisted machines, headless browsers) every one of those frames is
 * CPU time, so there the karaoke takes its reduced-motion form ("lite"); the list's motion stays.
 *
 * Detection must never take motion away from a capable machine: only a missing WebGL context or a
 * renderer name that says it is a software rasterizer means lite. A renderer we can't read, or one a
 * browser masks behind a generic name (WebKit's "Apple GPU", "WebKit WebGL"), means full.
 */

export type Power = "full" | "lite";

/** Software rasterizers by the names their WebGL renderer strings carry. */
const SOFTWARE = /SwiftShader|llvmpipe|softpipe|Software Rasterizer|Basic Render|Mesa OffScreen/iu;

/** Whether a WebGL renderer string names a software rasterizer (null, an unknown or a masked name: no). */
export function isSoftwareRenderer(renderer: string | null): boolean {
  return typeof renderer === "string" && SOFTWARE.test(renderer);
}

/** `?power=full|lite`, or null when the page doesn't force a tier. */
export function forcedPower(search: string): Power | null {
  const value = new URLSearchParams(search).get("power");
  return value === "full" || value === "lite" ? value : null;
}

/** A WebGL context as far as the probe needs one. */
interface ProbeContext {
  readonly RENDERER: number;
  getParameter(name: number): unknown;
  getExtension(name: string): unknown;
}

/**
 * The tier this machine composites at: lite when no WebGL context can be made at all, or when its
 * renderer is a software one. Without a DOM to ask (tests, workers) it is full.
 */
export function probePower(doc: Pick<Document, "createElement"> | undefined = typeof document === "undefined" ? undefined : document): Power {
  let canvas: HTMLCanvasElement;
  try {
    if (!doc || typeof doc.createElement !== "function") return "full";
    canvas = doc.createElement("canvas");
    if (typeof canvas.getContext !== "function") return "full";
  } catch {
    return "full";
  }
  let gl: ProbeContext | null;
  try {
    gl = (canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl")) as ProbeContext | null;
  } catch {
    return "full";
  }
  if (!gl) return "lite";
  try {
    const info = gl.getExtension("WEBGL_debug_renderer_info") as { UNMASKED_RENDERER_WEBGL: number } | null;
    const raw = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return isSoftwareRenderer(typeof raw === "string" ? raw : null) ? "lite" : "full";
  } catch {
    return "full";
  } finally {
    // one context per window, released at once: the overlay never draws WebGL
    try {
      (gl.getExtension("WEBGL_lose_context") as { loseContext(): void } | null)?.loseContext();
    } catch {
      // already gone
    }
  }
}

let probed: Power | null = null;

/** The window's power tier: `?power=` when the page forces one, else the probe's answer, made once. */
export function detectPower(search: string = typeof location === "undefined" ? "" : location.search): Power {
  const forced = forcedPower(search);
  if (forced) return forced;
  probed ??= probePower();
  return probed;
}

/** Forgets the probe's answer (tests). */
export function resetPower(): void {
  probed = null;
}
