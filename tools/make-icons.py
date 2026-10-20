#!/usr/bin/env python3
"""Regenerates the Allmind icon set from one drawing (a flying wing seen from above).

    python3 tools/make-icons.py

Writes public/icon.svg, public/icon-{180,192,512}.png (opaque, for iOS / manifest),
build/icon.png and build/icon.ico (transparent corners, for the exe).
Needs Pillow. The drawing lives in WING / SPINE below (32x32 grid) and is
mirrored into icon.svg, so edit it here only.
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BG = (23, 23, 31)       # matches the dashboard's dark background
PINK = (255, 92, 138)   # accent colour
LIGHT = (255, 196, 214)

# 32x32 grid, symmetrical around x=16
WING = [(16, 3.5), (29.5, 22), (22, 19.8), (16, 26.5), (10, 19.8), (2.5, 22)]
SPINE = [(16, 8.5), (18.2, 18), (16, 23), (13.8, 18)]


def render(size, rounded):
    k = 8  # supersample for smooth edges
    s = size * k
    im = Image.new('RGBA', (s, s), BG + (255,) if not rounded else (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    u = s / 32
    if rounded:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=8 * u, fill=BG + (255,))
    d.polygon([(x * u, y * u) for x, y in WING], fill=PINK + (255,))
    d.polygon([(x * u, y * u) for x, y in SPINE], fill=LIGHT + (255,))
    return im.resize((size, size), Image.LANCZOS)


def svg():
    pts = lambda p: ' '.join(f'{x:g},{y:g}' for x, y in p)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
        '<rect width="32" height="32" rx="8" fill="#16161d"/>'
        f'<polygon points="{pts(WING)}" fill="#ff5c8a"/>'
        f'<polygon points="{pts(SPINE)}" fill="#ffc4d6"/>'
        '</svg>\n'
    )


def main():
    open(os.path.join(ROOT, 'public', 'icon.svg'), 'w').write(svg())
    for n in (180, 192, 512):
        render(n, rounded=False).convert('RGB').save(os.path.join(ROOT, 'public', f'icon-{n}.png'))
    big = render(256, rounded=True)
    big.save(os.path.join(ROOT, 'build', 'icon.png'))
    sizes = [16, 24, 32, 48, 64, 128, 256]
    big.save(os.path.join(ROOT, 'build', 'icon.ico'), sizes=[(n, n) for n in sizes],
             append_images=[render(n, rounded=True) for n in sizes[:-1]])


if __name__ == '__main__':
    main()
