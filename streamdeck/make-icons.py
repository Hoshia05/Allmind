#!/usr/bin/env python3
"""Stream Deck plugin images (PNG, committed): plugin + category icons from the Allmind icon,
action-list icons (white glyph, transparent) and default key images. Needs Pillow.

    python3 streamdeck/make-icons.py
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'com.hoshia.allmind.sdPlugin', 'imgs')
ROOT = os.path.dirname(HERE)
os.makedirs(OUT, exist_ok=True)
S = 4  # supersampling


def note(d, s, c):  # music note on an s×s canvas
    w = s / 144
    d.line([(64 * w, 26 * w), (100 * w, 18 * w)], fill=c, width=int(8 * w))
    d.line([(100 * w, 18 * w), (100 * w, 72 * w)], fill=c, width=int(8 * w))
    d.line([(64 * w, 26 * w), (64 * w, 82 * w)], fill=c, width=int(8 * w))
    for cx, cy in [(56, 82), (92, 74)]:
        d.ellipse([(cx - 13) * w, (cy - 12) * w, (cx + 13) * w, (cy + 12) * w], fill=c)


def bell(d, s, c):
    w = s / 144
    d.polygon([(72 * w, 22 * w), (52 * w, 30 * w), (46 * w, 56 * w), (46 * w, 70 * w), (36 * w, 82 * w), (108 * w, 82 * w), (98 * w, 70 * w), (98 * w, 56 * w), (92 * w, 30 * w)], fill=c)
    d.ellipse([65 * w, 84 * w, 79 * w, 98 * w], fill=c)


def glyph(fn, size, fg, bg=None, scale=1.0, dy=0):
    big = size * S
    im = Image.new('RGBA', (big, big), bg or (0, 0, 0, 0))
    g = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    fn(ImageDraw.Draw(g), big, fg)
    if scale != 1.0 or dy:
        n = int(big * scale)
        g = g.resize((n, n), Image.LANCZOS)
        layer = Image.new('RGBA', (big, big), (0, 0, 0, 0))
        layer.paste(g, ((big - n) // 2, (big - n) // 2 + int(dy * big)), g)
        g = layer
    im.alpha_composite(g)
    return im.resize((size, size), Image.LANCZOS)


def save(im, name):
    im.save(os.path.join(OUT, name))


src = Image.open(os.path.join(ROOT, 'public', 'icon-512.png')).convert('RGBA')
for n, s in [('plugin', 256), ('plugin@2x', 512)]:
    save(src.resize((s, s), Image.LANCZOS), n + '.png')
# category: the Allmind mark as a white silhouette is too busy at 28 px — a simple hex ring instead
import math
def hexring(d, s, c):
    r = s * 0.40; cx = cy = s / 2
    pts = [(cx + r * math.cos(math.radians(-90 + 60 * k)), cy + r * math.sin(math.radians(-90 + 60 * k))) for k in range(6)]
    d.line(pts + [pts[0]], fill=c, width=max(1, int(s * 0.1)), joint='curve')
    d.ellipse([cx - s * 0.13, cy - s * 0.13, cx + s * 0.13, cy + s * 0.13], fill=c)
for n, s in [('category', 28), ('category@2x', 56)]:
    save(glyph(hexring, s, (255, 255, 255, 255)), n + '.png')
for n, s in [('', 20), ('@2x', 40)]:
    save(glyph(note, s, (255, 255, 255, 255), scale=1.25, dy=0.05), f'action-bgm{n}.png')
    save(glyph(bell, s, (255, 255, 255, 255), scale=1.25, dy=0.0), f'action-sb{n}.png')
BG = (16, 26, 29, 255)
for n, s in [('', 72), ('@2x', 144)]:
    save(glyph(note, s, (47, 216, 200, 255), BG), f'key-bgm{n}.png')
    save(glyph(bell, s, (47, 216, 200, 255), BG), f'key-sb{n}.png')
print('wrote', sorted(os.listdir(OUT)))
