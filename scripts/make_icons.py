"""Generate StarBoard's toolbar icons.

Draws at 8x and downsamples with LANCZOS so the star edges stay clean at 16px.

    py -3.12 scripts/make_icons.py
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
SIZES = (16, 32, 48, 128)
SS = 8  # supersample factor

BG_TOP = (22, 27, 34, 255)  # GitHub Dark surface
BG_BOTTOM = (13, 17, 23, 255)
RING = (48, 54, 61, 255)
GOLD = (227, 179, 65, 255)
GOLD_HI = (247, 209, 122, 255)


def star_points(cx: float, cy: float, outer: float, inner: float, points: int = 5):
    """Vertices of a star, first point straight up."""
    verts = []
    for i in range(points * 2):
        radius = outer if i % 2 == 0 else inner
        angle = math.pi / points * i - math.pi / 2
        verts.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    return verts


def vertical_gradient(size: int, top, bottom) -> Image.Image:
    grad = Image.new("RGBA", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        grad.putpixel(
            (0, y),
            tuple(round(top[c] + (bottom[c] - top[c]) * t) for c in range(4)),
        )
    return grad.resize((size, size), Image.Resampling.NEAREST)


def render(size: int) -> Image.Image:
    s = size * SS
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    # Rounded-square plate with a vertical gradient, masked.
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, s - 1, s - 1), radius=s * 0.22, fill=255)
    canvas.paste(vertical_gradient(s, BG_TOP, BG_BOTTOM), (0, 0), mask)

    draw = ImageDraw.Draw(canvas)
    inset = s * 0.03
    draw.rounded_rectangle(
        (inset, inset, s - 1 - inset, s - 1 - inset),
        radius=s * 0.2,
        outline=RING,
        width=max(1, round(s * 0.018)),
    )

    # At 16-32px the bars and the star turn to mush, so the small sizes get a
    # single centred star instead of the full mark.
    detailed = size >= 48

    if detailed:
        bar_w = s * 0.105
        base = s * 0.775
        for i, height in enumerate((0.17, 0.27, 0.37)):
            x = s * 0.235 + i * (bar_w + s * 0.055)
            draw.rounded_rectangle(
                (x, base - s * height, x + bar_w, base),
                radius=bar_w * 0.35,
                fill=(88, 166, 255, 190),
            )
        cx, cy, outer = s * 0.665, s * 0.335, s * 0.30
    else:
        cx, cy, outer = s * 0.5, s * 0.485, s * 0.375

    # Gold star, with a lighter core for depth.
    draw.polygon(star_points(cx, cy, outer, outer * 0.42), fill=GOLD)
    draw.polygon(star_points(cx, cy, outer * 0.62, outer * 0.27), fill=GOLD_HI)

    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT / f"icon{size}.png"
        render(size).save(path, "PNG", optimize=True)
        print(f"wrote {path.relative_to(ROOT)} ({size}x{size})")


if __name__ == "__main__":
    main()
