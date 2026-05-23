#!/usr/bin/env python3
"""Generate simple PNG icons for Chrome extension."""
import struct, zlib, math, os

def make_png(width, height, draw_func, filepath):
    """Create a valid PNG file with RGBA pixels."""
    # PNG signature
    sig = b'\x89PNG\r\n\x1a\n'

    # IHDR: width, height, bit_depth=8, color_type=6 (RGBA)
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    ihdr = _chunk(b'IHDR', ihdr_data)

    # Pixel data
    raw = b''
    for y in range(height):
        raw += b'\x00'  # filter: none
        for x in range(width):
            r, g, b, a = draw_func(x, y, width, height)
            raw += struct.pack('BBBB', r, g, b, a)

    compressed = zlib.compress(raw, 9)
    idat = _chunk(b'IDAT', compressed)
    iend = _chunk(b'IEND', b'')

    with open(filepath, 'wb') as f:
        f.write(sig + ihdr + idat + iend)
    print(f'  ✓ {filepath} ({width}x{height})')

def _chunk(chunk_type, data):
    c = chunk_type + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xFFFFFFFF)

def draw_icon(x, y, w, h):
    """Draw a document-to-markdown conversion icon."""
    # Background: rounded rect
    cx, cy = w * 0.5, h * 0.5
    r, g, b = 107, 140, 255  # #6B8CFF blue
    bg = (59, 73, 180)          # darker blue for outline

    # Convert to normalized coords
    nx, ny = x / w, y / h

    # Document shape (left side)
    in_doc = (0.08 < nx < 0.48) and (0.1 < ny < 0.85)

    # Document outline
    on_doc_edge = (
        (abs(nx - 0.08) < 0.03 and 0.1 < ny < 0.85) or
        (abs(nx - 0.48) < 0.03 and 0.1 < ny < 0.85) or
        (abs(ny - 0.1) < 0.03 and 0.08 < nx < 0.48) or
        (abs(ny - 0.85) < 0.03 and 0.08 < nx < 0.48)
    )

    # Lines inside document
    on_line = False
    for ly in [0.25, 0.38, 0.51, 0.64]:
        if abs(ny - ly) < 0.025 and 0.13 < nx < 0.43:
            on_line = True

    # Arrow (right side)
    arrow_cx = 0.72
    on_arrow = (
        (abs(nx - arrow_cx) < 0.12 and abs(ny - 0.5) < 0.04) or  # horizontal bar
        (abs(ny - 0.5) < 0.2 and abs(nx - 0.82) < 0.04 and ny < 0.5 + (nx - 0.62) * 1.5) or  # arrowhead
        (abs(ny - 0.5) < 0.2 and abs(nx - 0.82) < 0.04 and ny > 0.5 - (nx - 0.62) * 1.5)
    )

    # "MD" text approximation (small dots in upper-right)
    in_md = (0.55 < nx < 0.9) and (0.08 < ny < 0.35)
    on_md = False
    # Rough M shape
    for px, py in [(0.6, 0.3), (0.65, 0.15), (0.7, 0.3), (0.75, 0.15), (0.8, 0.3)]:
        if math.dist((nx, ny), (px, py)) < 0.05:
            on_md = True

    if on_doc_edge or on_line:
        return (r, g, b, 220)
    elif in_doc:
        return (200, 215, 255, 180)
    elif on_arrow:
        return (r, g, b, 240)
    elif on_md:
        return (255, 255, 255, 200)
    else:
        return (0, 0, 0, 0)  # transparent

# Generate all 3 icon sizes
base = r'C:\Users\USER248852\WorkBuddy\2026-05-22-task-3\feishu-doc-converter\icons'
os.makedirs(base, exist_ok=True)

for size in [16, 48, 128]:
    make_png(size, size, draw_icon, os.path.join(base, f'icon{size}.png'))

print('\nAll icons generated!')
