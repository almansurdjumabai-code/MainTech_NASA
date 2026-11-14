"""Патчи высокой детальности (LOLA LDEM_85S_20M, 20 м/пикс) вокруг точек посадки южнее 85°S.

Вход:  data_raw/LDEM_85S_20M.IMG (+ .LBL: 15168², int16 × 0.5 м, центр 7583.5, та же проекция, что у 80S)
       public/data/sites.json (канонический каталог Участника 2)
Выход: public/data/polar/patches/<id>.i16 (768², int16 полуметры) + patches.json

Патч ±9 км: камера в виде с поверхности видит рельеф с шагом ~23 м вместо 195–391 м.
"""
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
N, C, S = 15168, 7583.5, 20.0
R = 1737400.0
HALF_KM = 9.0
SIZE = 768
OUT = ROOT / "public" / "data" / "polar" / "patches"


def stereo(lat, lon):
    r = 2 * R * math.tan(math.pi / 4 + math.radians(lat) / 2)
    return r * math.sin(math.radians(lon)), r * math.cos(math.radians(lon))


def main():
    dem = np.memmap(ROOT / "data_raw" / "LDEM_85S_20M.IMG", dtype="<i2", mode="r", shape=(N, N))
    # проверка осей по известным точкам (как для 80S): Malapert — пик, Шеклтон — дно
    for name, lat, lon, test in (("Malapert", -86.0, 2.9, lambda h: h > 4500), ("Shackleton", -89.67, 129.8, lambda h: h < -2000)):
        x, y = stereo(lat, lon)
        h = dem[int(round(C - y / S)), int(round(C + x / S))] * 0.5
        print(f"[patch] axis check {name}: {h:.0f} m")
        assert test(h), f"axis check failed at {name}"

    sites = json.loads((ROOT / "public" / "data" / "sites.json").read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    index = {}
    half_px = int(HALF_KM * 1000 / S)
    for s in sites:
        x, y = stereo(s["lat"], s["lon"])
        col, row = int(round(C + x / S)), int(round(C - y / S))
        if not (half_px <= col < N - half_px and half_px <= row < N - half_px):
            continue
        crop = dem[row - half_px : row + half_px, col - half_px : col + half_px].astype(np.float32) * 0.5
        h = np.asarray(Image.fromarray(crop, mode="F").resize((SIZE, SIZE), Image.BOX), dtype=np.float32)
        np.clip(np.round(h * 2), -32768, 32767).astype("<i2").tofile(OUT / f"{s['id']}.i16")
        # центр патча — центр вырезанных пикселей (в км карты)
        cx = ((col - half_px + col + half_px - 1) / 2 - C) * S / 1000
        cy = (C - (row - half_px + row + half_px - 1) / 2) * S / 1000
        index[s["id"]] = {"file": f"patches/{s['id']}.i16", "size": SIZE, "dtype": "int16", "scale": 0.5,
                          "centerKm": [round(cx, 6), round(cy, 6)], "halfExtentKm": half_px * S / 1000,
                          "minHeight": float(h.min()), "maxHeight": float(h.max())}
        print(f"[patch] {s['id']}: {h.min():.0f}..{h.max():.0f} m")
    (ROOT / "public" / "data" / "polar" / "patches.json").write_text(
        json.dumps({"source": "LOLA LDEM_85S_20M (PDS LRO-L-LOLA-3-RDR-V1), 20 m/px", "patches": index}, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
