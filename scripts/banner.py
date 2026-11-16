"""Writes docs/media/social-preview.svg, the repository's GitHub social preview (1280x640).

The wordmark is set the way Arc draws a lyric line: bent along a gentle arch, with "Under" sung
(highlight color plus glow) and "tone" still to come, over the dusk stand-in wallpaper the mock
bridge paints. Every glyph is an outline, so the SVG needs no font to render.

    pip install fonttools brotli uharfbuzz
    pnpm install                # for the @fontsource files
    python3 scripts/banner.py   # writes docs/media/social-preview.svg

`node scripts/readme-media.mjs social-preview` renders docs/media/social-preview.png from it;
commit both, and upload the PNG under the repository's Settings > General > Social preview.
"""

from __future__ import annotations

import io
import math
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
FONTS = ROOT / "node_modules" / "@fontsource"
OUT = ROOT / "docs" / "media" / "social-preview.svg"

W, H = 1280, 640
SUNG = "#F2A65A"  # the app icon's highlight
LYRIC = "#F1ECE3"  # the app icon's upcoming word
WORDMARK, SPLIT = "Undertone", 5  # glyphs before SPLIT are sung
TAGLINE = "Your desktop, singing along."


def load(path: Path) -> tuple[TTFont, hb.Font]:
    font = TTFont(path)
    font.flavor = None
    data = io.BytesIO()
    font.save(data)
    return font, hb.Font(hb.Face(data.getvalue()))


def shape(hbfont: hb.Font, text: str) -> list[tuple[int, float, float, float]]:
    """(glyph id, x, y, advance) in font units, kerning on."""
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(hbfont, buf, {"kern": True, "liga": True})
    out, pen_x = [], 0.0
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        out.append((info.codepoint, pen_x + pos.x_offset, pos.y_offset, pos.x_advance))
        pen_x += pos.x_advance
    return out


def outline(font: TTFont, gid: int, transform: tuple[float, ...]) -> str:
    name = font.getGlyphOrder()[gid]
    pen = SVGPathPen(font.getGlyphSet(), ntos=lambda v: f"{v:.1f}".rstrip("0").rstrip("."))
    font.getGlyphSet()[name].draw(TransformPen(pen, transform))
    return pen.getCommands()


def ink_width(font: TTFont, glyphs: list[tuple[int, float, float, float]]) -> tuple[float, float]:
    """Left and right edge of the ink, so the text centers by what you see, not by side bearings."""
    order, gs = font.getGlyphOrder(), font.getGlyphSet()
    from fontTools.pens.boundsPen import BoundsPen

    lo, hi = math.inf, -math.inf
    for gid, x, _y, _adv in glyphs:
        pen = BoundsPen(gs)
        gs[order[gid]].draw(pen)
        if pen.bounds:
            lo, hi = min(lo, x + pen.bounds[0]), max(hi, x + pen.bounds[2])
    return lo, hi


def arched(font: TTFont, hbfont: hb.Font, text: str, size: float, apex_y: float, radius: float) -> list[str]:
    """One path per glyph, each turned to follow an arch whose top is at (W/2, apex_y)."""
    scale = size / font["head"].unitsPerEm
    glyphs = shape(hbfont, text)
    lo, hi = ink_width(font, glyphs)
    mid = (lo + hi) / 2
    paths = []
    for gid, x, y, adv in glyphs:
        along = (x + adv / 2 - mid) * scale  # glyph center, measured along the arch
        theta = along / radius
        px, py = W / 2 + radius * math.sin(theta), apex_y + radius * (1 - math.cos(theta))
        c, s = math.cos(theta), math.sin(theta)
        # font units -> centered on the glyph's advance, flipped, scaled, rotated by theta, moved to (px, py)
        ox, oy = -adv / 2 * scale, -y * scale
        a, b, cc, d = scale * c, scale * s, scale * s, -scale * c
        e = px + c * ox - s * oy
        f = py + s * ox + c * oy
        paths.append(outline(font, gid, (a, b, cc, d, e, f)))
    return paths


def straight(font: TTFont, hbfont: hb.Font, text: str, size: float, baseline: float) -> str:
    scale = size / font["head"].unitsPerEm
    glyphs = shape(hbfont, text)
    lo, hi = ink_width(font, glyphs)
    left = W / 2 - (lo + hi) / 2 * scale
    return "".join(outline(font, gid, (scale, 0, 0, -scale, left + x * scale, baseline - y * scale)) for gid, x, y, _ in glyphs)


def main() -> None:
    fraunces, fraunces_hb = load(FONTS / "fraunces" / "files" / "fraunces-latin-700-normal.woff2")
    figtree, figtree_hb = load(FONTS / "figtree" / "files" / "figtree-latin-500-normal.woff2")

    word = arched(fraunces, fraunces_hb, WORDMARK, size=172, apex_y=316, radius=2900)
    sung, upcoming = "".join(word[:SPLIT]), "".join(word[SPLIT:])
    tagline = straight(figtree, figtree_hb, TAGLINE, size=40, baseline=446)

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="title">
  <title id="title">Undertone: your desktop, singing along.</title>
  <!-- Undertone's GitHub social preview, 1280x640. Written by scripts/banner.py; edit that
       and run it again rather than editing this file.
       The wordmark is drawn the way Arc draws a lyric line: bent along a gentle arch, "Under" sung in the
       highlight color with its glow, "tone" still to come, and the soft dark shadow the renderer puts under
       every word. The background is the dusk stand-in wallpaper from src/styles/overlay.css.
       Text: every glyph is an outline, so the file needs no font. "Undertone" is Fraunces Bold at 172 px and
       the tagline is Figtree Medium at 40 px, both shaped with HarfBuzz (kerning on) and centered by their ink.
       Fraunces (copyright 2018 The Fraunces Project Authors) and Figtree (copyright 2022 The Figtree Project
       Authors) are licensed under the SIL Open Font License 1.1 (https://openfontlicense.org), which allows
       embedding their outlines in a document like this one. -->
  <defs>
    <radialGradient id="teal" gradientUnits="userSpaceOnUse" cx="230" cy="77" r="655">
      <stop offset="0" stop-color="#2B4D52"/>
      <stop offset="1" stop-color="#2B4D52" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="plum" gradientUnits="userSpaceOnUse" cx="1126" cy="589" r="661">
      <stop offset="0" stop-color="#5A2E3D"/>
      <stop offset="1" stop-color="#5A2E3D" stop-opacity="0"/>
    </radialGradient>
    <!-- Filter regions cover the whole banner, so no blur is clipped at the default 10 % margin. -->
    <filter id="shadow" filterUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <feGaussianBlur stdDeviation="7"/>
    </filter>
    <filter id="glow" filterUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <feGaussianBlur stdDeviation="16"/>
    </filter>
  </defs>
  <rect width="{W}" height="{H}" fill="#0D1A1F"/>
  <rect width="{W}" height="{H}" fill="url(#teal)"/>
  <rect width="{W}" height="{H}" fill="url(#plum)"/>
  <!-- The soft dark shadow under every word. -->
  <g transform="translate(0 4)" fill="#000" opacity="0.5" filter="url(#shadow)">
    <path d="{sung}{upcoming}"/>
    <path d="{tagline}"/>
  </g>
  <!-- "Under", sung: the highlight's glow, then the word. -->
  <path d="{sung}" fill="{SUNG}" opacity="0.75" filter="url(#glow)"/>
  <path d="{sung}" fill="{SUNG}"/>
  <!-- "tone", still to come. -->
  <path d="{upcoming}" fill="{LYRIC}"/>
  <!-- The tagline, as the next line. -->
  <path d="{tagline}" fill="{LYRIC}" opacity="0.82"/>
</svg>
"""
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(svg, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(svg) // 1024} KB)")


if __name__ == "__main__":
    main()
