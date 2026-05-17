#!/usr/bin/env python3
"""Generate extension icons for Chrome and Firefox packages."""

from __future__ import annotations

from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUTS = [
    ROOT / "extension" / "icons",
    ROOT / "firefox-extension" / "icons",
]
SIZES = (16, 32, 48, 128)


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Supplemental/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def draw_background(draw: ImageDraw.ImageDraw, size: int) -> None:
    radius = max(4, size // 4)
    draw.rounded_rectangle(
        (0, 0, size - 1, size - 1),
        radius=radius,
        fill=(24, 72, 184, 255),
    )
    draw.rounded_rectangle(
        (1, 1, size - 2, int(size * 0.55)),
        radius=radius,
        fill=(59, 130, 246, 180),
    )


def draw_mark(draw: ImageDraw.ImageDraw, size: int) -> None:
    stroke = max(1, size // 16)
    lens_radius = max(2, int(size * 0.16))
    cx = int(size * 0.73)
    cy = int(size * 0.72)
    draw.ellipse(
        (cx - lens_radius, cy - lens_radius, cx + lens_radius, cy + lens_radius),
        outline=(255, 255, 255, 235),
        width=stroke,
    )
    draw.line(
        (
            cx + int(lens_radius * 0.55),
            cy + int(lens_radius * 0.55),
            min(size - stroke - 1, cx + lens_radius + int(size * 0.12)),
            min(size - stroke - 1, cy + lens_radius + int(size * 0.12)),
        ),
        fill=(255, 255, 255, 235),
        width=stroke,
    )

    if size >= 32:
        sparkle_x = int(size * 0.8)
        sparkle_y = int(size * 0.22)
        sparkle = max(2, size // 12)
        draw.line(
            (sparkle_x, sparkle_y - sparkle, sparkle_x, sparkle_y + sparkle),
            fill=(251, 191, 36, 255),
            width=stroke,
        )
        draw.line(
            (sparkle_x - sparkle, sparkle_y, sparkle_x + sparkle, sparkle_y),
            fill=(251, 191, 36, 255),
            width=stroke,
        )


def draw_text(draw: ImageDraw.ImageDraw, size: int) -> None:
    font = load_font(max(8, int(size * 0.42)))
    text = "AI"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_width = bbox[2] - bbox[0]
    text_height = bbox[3] - bbox[1]
    x = int(size * 0.36 - text_width / 2)
    y = int(size * 0.5 - text_height / 2) - 1
    draw.text((x, y), text, font=font, fill=(255, 255, 255, 255))


def render_icon(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw_background(draw, size)
    draw_text(draw, size)
    draw_mark(draw, size)
    return image


def generate(output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        render_icon(size).save(output_dir / f"icon{size}.png")


def main(argv: list[str]) -> int:
    outputs = [Path(arg).resolve() for arg in argv] if argv else DEFAULT_OUTPUTS
    for output in outputs:
        generate(output)
        print(f"Generated icons in {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
