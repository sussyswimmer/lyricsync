"""Rasterize Undertone's tray glyph (original artwork) into PNGs with no third-party modules.

Design space is an 18x18 pt grid (the macOS menu bar draws status icons 18 pt tall):
the current lyric bent into an arch the way Arc mode draws it, as three word dashes (two sung,
solid; one upcoming, faded), between the previous and next lines as short faded bars.

Redraws src-tauri/icons/tray-template.png and tray.png: python3 scripts/draw_tray.py src-tauri/icons
"""
import math
import struct
import sys
import zlib

CX, CY, R = 9.0, 17.25, 9.25            # arch: top at y=8.0, ends at x=2.5/15.5, y=10.7
HALF = 0.8                                 # 1.6 pt strokes
LEFT = math.atan2(10.7 - CY, 2.5 - CX)
RIGHT = math.atan2(10.7 - CY, 15.5 - CX)
GAP = (0.9 + 2 * HALF) / R                 # 0.9 pt of visible space between words
FADED = 0.42


def words(shares):
    """Splits the arch into word dashes whose arc lengths follow `shares`."""
    usable = RIGHT - LEFT - GAP * (len(shares) - 1)
    total = sum(shares)
    out, a = [], LEFT
    for share in shares:
        b = a + usable * share / total
        out.append((a, b))
        a = b + GAP
    return out


# Sung, sung, upcoming: the active line as Arc mode draws it.
WORDS = list(zip(words([1.0, 1.25, 1.1]), [1.0, 1.0, FADED]))
# The previous line above and the next line below, small and dim.
BARS = [((6.5, 4.4), (11.5, 4.4)), ((5.5, 14.6), (12.5, 14.6))]


def arc_sdf(x, y, a0, a1):
    angle = math.atan2(y - CY, x - CX)
    if a0 <= angle <= a1:
        return abs(math.hypot(x - CX, y - CY) - R) - HALF
    ends = [(CX + R * math.cos(a), CY + R * math.sin(a)) for a in (a0, a1)]
    return min(math.hypot(x - ex, y - ey) for ex, ey in ends) - HALF


def bar_sdf(x, y, bar):
    (x0, y0), (x1, _) = bar
    px = min(max(x, x0), x1)
    return math.hypot(x - px, y - y0) - HALF


def glyph_alpha(x, y):
    """Opacity of the glyph at a design-space point."""
    alpha = 0.0
    for (a0, a1), opacity in WORDS:
        if arc_sdf(x, y, a0, a1) <= 0:
            alpha = max(alpha, opacity)
    for bar in BARS:
        if bar_sdf(x, y, bar) <= 0:
            alpha = max(alpha, FADED)
    return alpha


def tile_sdf(x, y, size, radius):
    qx = abs(x - size / 2) - (size / 2 - radius)
    qy = abs(y - size / 2) - (size / 2 - radius)
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - radius


def render(size, pixel, samples=12):
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(samples):
                for sx in range(samples):
                    r, g, b, a = pixel(px + (sx + 0.5) / samples, py + (sy + 0.5) / samples)
                    acc[0] += r * a
                    acc[1] += g * a
                    acc[2] += b * a
                    acc[3] += a
            n = samples * samples
            alpha = acc[3] / n
            if alpha > 0:
                rgb = [round(c / acc[3]) for c in acc[:3]]
            else:
                rgb = [0, 0, 0]
            row += bytes(rgb + [round(alpha * 255)])
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def template(size):
    """macOS template: black plus alpha; the system tints it for light and dark menu bars."""
    scale = 18.0 / size

    def pixel(x, y):
        return (0, 0, 0, glyph_alpha(x * scale, y * scale))

    return render(size, pixel)


def color(size):
    """Windows has no template tinting, so the glyph sits on an amber tile that reads on light
    and dark taskbars alike."""
    radius = size * 0.22
    top, bottom = (0xF6, 0xB5, 0x6C), (0xEC, 0x93, 0x45)
    ink = (0x2A, 0x1E, 0x16)
    inset = 1.0  # the glyph fills 16 of the tile's 18 units
    scale = (18.0 + 2 * inset) / size

    def pixel(x, y):
        if tile_sdf(x, y, size, radius) > 0:
            return (0, 0, 0, 0.0)
        t = y / size
        tile = [a + (b - a) * t for a, b in zip(top, bottom)]
        g = glyph_alpha(x * scale - inset, y * scale - inset)
        return (*[c + (i - c) * g for c, i in zip(tile, ink)], 1.0)

    return render(size, pixel)


if __name__ == "__main__":
    out = sys.argv[1]
    write_png(f"{out}/tray-template.png", 36, template(36))
    write_png(f"{out}/tray.png", 32, color(32))
