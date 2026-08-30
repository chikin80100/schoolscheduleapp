#!/usr/bin/env python3
"""PWA アイコンを生成する（依存パッケージなし）。

    python3 tools/generate-icons.py

public/icons/ に icon-192.png / icon-512.png / maskable-512.png /
apple-touch-icon.png を書き出す。時間割のグリッドを模した図柄。
"""

import struct
import zlib
from pathlib import Path

BG = (16, 20, 24)
GRID = (42, 50, 60)
ACCENT = (76, 157, 248)
LIGHT = (232, 237, 243)

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"


def write_png(path, pixels, size):
    raw = b"".join(b"\x00" + bytes(v for px in row for v in px) for row in pixels)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def render(size, padding_ratio):
    """時間割グリッド風のアイコンを描く。padding_ratio が大きいほど図柄が小さくなる。"""
    pixels = [[BG for _ in range(size)] for _ in range(size)]

    pad = int(size * padding_ratio)
    inner = size - pad * 2
    cols, rows = 3, 4
    gap = max(1, inner // 26)
    cell_w = (inner - gap * (cols - 1)) // cols
    cell_h = (inner - gap * (rows - 1)) // rows
    radius = max(1, cell_w // 6)

    for row in range(rows):
        for col in range(cols):
            # 1行目は見出し（アクセント）、残りはコマ。一部だけ明るくして時間割らしくする。
            if row == 0:
                color = ACCENT
            elif (row + col) % 3 == 0:
                color = LIGHT
            elif (row * cols + col) % 4 == 1:
                color = ACCENT
            else:
                color = GRID

            x0 = pad + col * (cell_w + gap)
            y0 = pad + row * (cell_h + gap)
            for y in range(y0, y0 + cell_h):
                for x in range(x0, x0 + cell_w):
                    # 角丸のためコーナー円の外側を塗らない。
                    dx = min(x - x0, x0 + cell_w - 1 - x)
                    dy = min(y - y0, y0 + cell_h - 1 - y)
                    if dx < radius and dy < radius:
                        if (radius - dx) ** 2 + (radius - dy) ** 2 > radius * radius:
                            continue
                    pixels[y][x] = color
    return pixels


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size, padding in [
        ("icon-192.png", 192, 0.16),
        ("icon-512.png", 512, 0.16),
        ("apple-touch-icon.png", 180, 0.14),
        # maskable は外周 20% が切り取られる想定で、図柄を内側に寄せる。
        ("maskable-512.png", 512, 0.28),
    ]:
        write_png(OUT / name, render(size, padding), size)
        print("wrote", OUT / name)


if __name__ == "__main__":
    main()
