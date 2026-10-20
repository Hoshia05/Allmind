#!/usr/bin/env python3
"""Regenerates the Allmind icon set from one drawing: a hexagonal network seen head-on,
a bright core node linked to three nodes on a hex ring (a "mind" made of nodes).

    python3 tools/make-icons.py

Writes public/icon.svg, public/icon-{180,192,512}.png (opaque, for iOS / manifest),
build/icon.png and build/icon.ico (transparent corners, for the exe).
Needs Pillow. The drawing lives in the constants below (32x32 grid) and is mirrored
into icon.svg, so edit it here only.
"""
import math
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BG = (7, 11, 12)         # matches the dashboard's black
TEAL = (47, 216, 200)    # accent colour
LIGHT = (176, 250, 242)
DIM = (30, 110, 106)

C = (16.0, 16.0)
R = 11.5  # hex ring radius
HEX = [(C[0] + R * math.cos(math.radians(-90 + 60 * k)), C[1] + R * math.sin(math.radians(-90 + 60 * k))) for k in range(6)]
LINKED = [HEX[0], HEX[2], HEX[4]]  # nodes joined to the core
RING_W, SPOKE_W = 1.9, 1.5
CORE_R, NODE_R, DIM_R = 3.4, 2.0, 1.2


def render(size, rounded):
    k = 8  # supersample for smooth edges
    s = size * k
    im = Image.new('RGBA', (s, s), BG + (255,) if not rounded else (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    u = s / 32
    P = lambda p: (p[0] * u, p[1] * u)
    if rounded:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=8 * u, fill=BG + (255,))
    pts = [P(p) for p in HEX] + [P(HEX[0])]
    d.line(pts, fill=DIM + (255,), width=round(RING_W * u), joint='curve')
    for a in LINKED:
        d.line([P(C), P(a)], fill=TEAL + (255,), width=round(SPOKE_W * u))
    # ring arcs between the linked nodes, brighter
    d.line([P(HEX[0]), P(HEX[1]), P(HEX[2])], fill=TEAL + (255,), width=round(RING_W * u), joint='curve')
    for p in HEX:
        r = (NODE_R if p in LINKED else DIM_R) * u
        x, y = P(p)
        d.ellipse([x - r, y - r, x + r, y + r], fill=(LIGHT if p in LINKED else TEAL) + (255,))
    x, y = P(C)
    r = CORE_R * u
    d.ellipse([x - r * 1.9, y - r * 1.9, x + r * 1.9, y + r * 1.9], outline=DIM + (255,), width=round(0.8 * u))
    d.ellipse([x - r, y - r, x + r, y + r], fill=LIGHT + (255,))
    return im.resize((size, size), Image.LANCZOS)


def hexc(c):
    return '#%02x%02x%02x' % c


def svg():
    pts = lambda p: ' '.join(f'{x:.2f},{y:.2f}' for x, y in p)
    out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">',
           f'<rect width="32" height="32" rx="8" fill="{hexc(BG)}"/>',
           f'<polygon points="{pts(HEX)}" fill="none" stroke="{hexc(DIM)}" stroke-width="{RING_W}" stroke-linejoin="round"/>',
           f'<polyline points="{pts(HEX[:3])}" fill="none" stroke="{hexc(TEAL)}" stroke-width="{RING_W}" stroke-linejoin="round" stroke-linecap="butt"/>']
    for a in LINKED:
        out.append(f'<line x1="{C[0]}" y1="{C[1]}" x2="{a[0]:.2f}" y2="{a[1]:.2f}" stroke="{hexc(TEAL)}" stroke-width="{SPOKE_W}"/>')
    for p in HEX:
        lk = p in LINKED
        out.append(f'<circle cx="{p[0]:.2f}" cy="{p[1]:.2f}" r="{NODE_R if lk else DIM_R}" fill="{hexc(LIGHT if lk else TEAL)}"/>')
    out.append(f'<circle cx="{C[0]}" cy="{C[1]}" r="{CORE_R * 1.9:.2f}" fill="none" stroke="{hexc(DIM)}" stroke-width="0.8"/>')
    out.append(f'<circle cx="{C[0]}" cy="{C[1]}" r="{CORE_R}" fill="{hexc(LIGHT)}"/>')
    out.append('</svg>\n')
    return ''.join(out)


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
