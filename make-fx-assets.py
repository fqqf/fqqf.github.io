"""Render the decorative rasters style.css leans on: paper grain and the
torn-edge masks for the gallery cards.

They used to be inline SVG data URIs with feTurbulence filters, which
browsers have to rasterize on the CPU every time a tile is painted; a
flat PNG is decoded once and then lives on the GPU.  Pure Python, no
dependencies.

    python make-fx-assets.py          # writes fx/grain.png, fx/torn-a.png, fx/torn-b.png
"""

from __future__ import annotations

import math
import random
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent / "fx"


def write_png(path: Path, width: int, height: int, rows: list[bytes], color_type: int) -> None:
    """Minimal PNG writer.  color_type 0 = gray, 4 = gray+alpha, 6 = rgba."""
    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    raw = b"".join(b"\x00" + row for row in rows)
    header = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
                     + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def grain(size: int = 256, seed: int = 1) -> None:
    """White speckle with a soft alpha; style.css tiles it at ~10% opacity."""
    rng = random.Random(seed)
    rows = []
    for _ in range(size):
        row = bytearray()
        for _ in range(size):
            # Two uniforms summed: fewer harsh outliers than flat noise.
            alpha = int((rng.random() + rng.random()) * 127.5)
            row += bytes((255, alpha))
        rows.append(bytes(row))
    write_png(OUT / "grain.png", size, size, rows, 4)


def edge_profile(length: int, amplitude: float, rng: random.Random) -> list[float]:
    """A wobbly, hand-torn offset along one side: layered sines plus a
    little pixel grit, so it reads as paper and not as a sine wave."""
    waves = [(rng.uniform(1.5, 3.5), rng.uniform(0, math.tau), 1.0),
             (rng.uniform(5, 9), rng.uniform(0, math.tau), 0.55),
             (rng.uniform(14, 24), rng.uniform(0, math.tau), 0.28),
             (rng.uniform(40, 70), rng.uniform(0, math.tau), 0.12)]
    profile = []
    grit = 0.0
    for i in range(length):
        t = i / length
        value = sum(w * math.sin(t * math.tau * f + p) for f, p, w in waves) / 1.95
        grit = grit * 0.6 + rng.uniform(-1, 1) * 0.4
        profile.append(value * amplitude + grit * amplitude * 0.35)
    return profile


def torn(name: str, seed: int, width: int = 600, height: int = 400,
         margin: float = 11.0, amplitude: float = 7.0) -> None:
    """Opaque sheet with four torn edges.  Alpha mask, black ink."""
    rng = random.Random(seed)
    top = edge_profile(width, amplitude, rng)
    bottom = edge_profile(width, amplitude, rng)
    left = edge_profile(height, amplitude, rng)
    right = edge_profile(height, amplitude, rng)

    rows = []
    for y in range(height):
        row = bytearray()
        x_min = margin + left[y]
        x_max = width - margin + right[y]
        for x in range(width):
            y_min = margin + top[x]
            y_max = height - margin + bottom[x]
            # Signed distance to the nearest edge, for a 1px anti-aliased lip.
            d = min(x - x_min, x_max - x, y - y_min, y_max - y)
            alpha = 0 if d <= -0.5 else 255 if d >= 0.5 else int((d + 0.5) * 255)
            row += bytes((0, alpha))
        rows.append(bytes(row))
    write_png(OUT / f"{name}.png", width, height, rows, 4)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    grain()
    torn("torn-a", seed=7)
    torn("torn-b", seed=23)
    for file in sorted(OUT.glob("*.png")):
        print(f"{file.relative_to(OUT.parent)}  {file.stat().st_size:,} bytes")
