"""Препроцессинг глобуса Луны из NASA SVS CGI Moon Kit (svs.gsfc.nasa.gov/4720).

Вход (data_raw/):  lroc_color_poles_4k.tif, ldem_16_uint.tif
Выход (public/textures/): moon_color_4k.jpg, moon_normal_4k.jpg

Запуск:  scripts/.venv/Scripts/python scripts/prep_globe.py
"""
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data_raw"
OUT = ROOT / "public" / "textures"
MOON_RADIUS_M = 1_737_400.0
OUT_SIZE = (4096, 2048)


def color():
    src = RAW / "lroc_color_poles_8k.tif"
    if src.exists():  # 8K — в 2 раза детальнее при зуме
        img = tifffile.imread(src)
        if img.dtype != np.uint8:
            img = (img / img.max() * 255).astype(np.uint8)
        Image.fromarray(img[..., :3]).save(OUT / "moon_color_8k.jpg", quality=80)
    # запасной вариант для quality: 'low' — 2K (бюджет public/ ≤ 40 МБ)
    img = tifffile.imread(RAW / "lroc_color_poles_4k.tif")
    if img.dtype != np.uint8:  # на случай 16-бит
        img = (img / img.max() * 255).astype(np.uint8)
    Image.fromarray(img[..., :3]).resize((2048, 1024), Image.LANCZOS).save(OUT / "moon_color_2k.jpg", quality=90)


def normal():
    # uint16 в полуметрах -> метры (смещение не важно, нужны только градиенты)
    h = tifffile.imread(RAW / "ldem_16_uint.tif").astype(np.float64) * 0.5
    rows, cols = h.shape
    lat = np.deg2rad(90.0 - (np.arange(rows) + 0.5) * 180.0 / rows)

    dy = np.pi * MOON_RADIUS_M / rows  # шаг на север, м
    dx = 2 * np.pi * MOON_RADIUS_M * np.maximum(np.cos(lat), 0.01) / cols  # шаг на восток, м

    # восток: по долготе с переходом через 180° (np.roll)
    dh_east = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) / (2 * dx[:, None])
    # север: строка 0 = северный полюс, поэтому "на север" = к меньшему индексу
    up = np.vstack([h[:1], h[:-1]])
    down = np.vstack([h[1:], h[-1:]])
    dh_north = (up - down) / (2 * dy)

    # tangent space: X = восток (+u), Y = север (+v), Z = наружу
    n = np.stack([-dh_east, -dh_north, np.ones_like(h)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    rgb = ((n * 0.5 + 0.5) * 255).round().astype(np.uint8)
    Image.fromarray(rgb).resize((2048, 1024), Image.LANCZOS).save(OUT / "moon_normal_2k.jpg", quality=92)
    # родное разрешение LDEM 16 ppd (5760×2880) — без потерь на уменьшении
    Image.fromarray(rgb).save(OUT / "moon_normal_16ppd.jpg", quality=90)


def height():
    """Карта высот для смещения вершин глобуса: 8 бит, диапазон в meta (м)."""
    h = tifffile.imread(RAW / "ldem_16_uint.tif").astype(np.float64) * 0.5
    lo, hi = np.percentile(h, 0.01), np.percentile(h, 99.99)
    g = np.clip((h - lo) / (hi - lo), 0, 1)
    Image.fromarray((g * 255).round().astype(np.uint8)).resize((2048, 1024), Image.LANCZOS).save(OUT / "moon_height_2k.png", optimize=True)
    import json
    (OUT / "moon_height_2k.json").write_text(json.dumps({"minM": lo, "maxM": hi, "note": "ldem_16_uint, meters relative to 1737.4 km (offset-free)"}))


def slope_color(deg):
    """Колормап уклона, как в шейдере: < 5° зелёный, 5–10° жёлтый, > 10° красный."""
    def ss(e0, e1, x):
        t = np.clip((x - e0) / (e1 - e0), 0, 1)
        return t * t * (3 - 2 * t)
    g, y, r = np.array([0.18, 0.75, 0.35]), np.array([0.98, 0.82, 0.2]), np.array([0.92, 0.22, 0.18])
    k1 = ss(4, 5, deg)[..., None]
    k2 = ss(9, 10, deg)[..., None]
    low = g * (1 - k1) + y * k1
    high = y * (1 - k2) + r * k2
    return np.where((deg < 5)[..., None], low, high)


def slope():
    """Цветная карта уклона глобуса (LOLA LDEM 16 ppd, база ~1.9 км) -> moon_slope_2k.jpg."""
    h = tifffile.imread(RAW / "ldem_16_uint.tif").astype(np.float64) * 0.5
    rows, cols = h.shape
    lat = np.deg2rad(90.0 - (np.arange(rows) + 0.5) * 180.0 / rows)
    dy = np.pi * MOON_RADIUS_M / rows
    dx = 2 * np.pi * MOON_RADIUS_M * np.maximum(np.cos(lat), 0.01) / cols
    gx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) / (2 * dx[:, None])
    gy = (np.vstack([h[:1], h[:-1]]) - np.vstack([h[1:], h[-1:]])) / (2 * dy)
    deg = np.degrees(np.arctan(np.hypot(gx, gy)))
    rgb = (slope_color(deg) * 255).astype(np.uint8)
    # прозрачность задаёт материал слоя, поэтому хватает JPG
    Image.fromarray(rgb).resize((2048, 1024), Image.LANCZOS).save(OUT / "moon_slope_2k.jpg", quality=85)


if __name__ == "__main__":
    import sys

    OUT.mkdir(parents=True, exist_ok=True)
    steps = sys.argv[1:] or ["color", "normal", "slope", "height"]
    for step in steps:
        {"color": color, "normal": normal, "slope": slope, "height": height}[step]()
    for f in sorted(OUT.iterdir()):
        print(f"{f.name}: {f.stat().st_size / 1e6:.1f} MB")
