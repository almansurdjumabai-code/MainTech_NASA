"""Препроцессинг рельефа Южного полюса из LOLA LDEM_80S_80M (PDS, NASA GSFC).

Вход:  data_raw/LDEM_80S_80M.IMG (+ .LBL)
       https://imbrium.mit.edu/DATA/LOLA_GDR/POLAR/IMG/  (зеркало PDS Geosciences)
Выход: public/data/polar/
       height_1024.f32, height_512.f32 — высоты, м, float32 LE, строка 0 = верх (+y)
       slope_1024.u8                   — средний уклон (по базе 80 м), градусы × 4
       meta.json
       preview_hillshade.png           — для проверки глазами

Проекция (из .LBL + проверка по Шеклтону/Malapert):
  south polar stereographic, R = 1737.4 км
  x = 2R·tan(π/4 + lat/2)·sin(lon),  y = 2R·tan(π/4 + lat/2)·cos(lon)
  sample = 3799.5 + x/80,  line = 3799.5 − y/80
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data_raw" / "LDEM_80S_80M.IMG"
OUT = ROOT / "public" / "data" / "polar"

N_SRC = 7600
PIX_SRC_M = 80.0
CENTER = 3799.5
HALF_EXTENT_KM = 200.0  # квадрат ±200 км: все зоны Artemis III (≤ ~165 км от полюса)


def load():
    dn = np.fromfile(RAW, dtype="<i2").reshape(N_SRC, N_SRC)
    return dn.astype(np.float32) * 0.5  # м относительно 1737.4 км


def crop(h):
    half_px = int(HALF_EXTENT_KM * 1000 / PIX_SRC_M)  # 2500
    c0 = int(CENTER + 0.5) - half_px  # 1300
    return h[c0 : c0 + 2 * half_px, c0 : c0 + 2 * half_px]


def resize(a, n, resample=Image.BOX):
    return np.asarray(Image.fromarray(a.astype(np.float32), mode="F").resize((n, n), resample), dtype=np.float32)


def slope_deg(h):
    gy, gx = np.gradient(h, PIX_SRC_M)
    return np.degrees(np.arctan(np.hypot(gx, gy))).astype(np.float32)


def hillshade(h, pix_m, az_deg=315, el_deg=30):
    gy, gx = np.gradient(h, pix_m)
    # строки идут вниз (−y), поэтому «север» карты = −gy
    nx, ny, nz = -gx, gy, np.ones_like(h)
    n = np.sqrt(nx**2 + ny**2 + nz**2)
    az, el = np.radians(az_deg), np.radians(el_deg)
    lx, ly, lz = np.sin(az) * np.cos(el), np.cos(az) * np.cos(el), np.sin(el)
    return np.clip((nx * lx + ny * ly + nz * lz) / n, 0, 1)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    h = crop(load())
    print("crop", h.shape, "height", h.min(), h.max())

    meta = {
        "source": "LOLA LDEM_80S_80M (PDS LRO-L-LOLA-3-RDR-V1, NASA GSFC), 80 m/px",
        "projection": "south polar stereographic, sphere R=1737.4 km, center lat -90 lon 0",
        "formula": "x = 2R tan(pi/4 + lat/2) sin(lon); y = 2R tan(pi/4 + lat/2) cos(lon); lon east",
        "layout": "row 0 = +y (top), col 0 = -x (left); pixel centers span [-halfExtent, +halfExtent]",
        "refRadiusKm": 1737.4,
        "halfExtentKm": HALF_EXTENT_KM,
        "heightUnits": "meters relative to refRadius, float32 little-endian",
        "slopeUnits": "degrees * 4, uint8 (mean of 80 m baseline slope within pixel)",
        "levels": {},
    }

    for n in (512,):  # 1024² браузер получает усреднением 2048² (см. PolarData.loadPolarData)
        hn = resize(h, n)
        # int16 в полуметрах: точность 0.5 м, файл вдвое меньше float32
        np.clip(np.round(hn * 2), -32768, 32767).astype("<i2").tofile(OUT / f"height_{n}.i16")
        meta["levels"][str(n)] = {
            "file": f"height_{n}.i16",
            "dtype": "int16",
            "scale": 0.5,
            "size": n,
            "pixelKm": 2 * HALF_EXTENT_KM / n,
            "minHeight": float(hn.min()),
            "maxHeight": float(hn.max()),
        }

    s = resize(slope_deg(h), 1024)
    np.clip(np.round(s * 4), 0, 255).astype(np.uint8).tofile(OUT / "slope_1024.u8")
    meta["slope"] = {"file": "slope_1024.u8", "size": 1024}

    (OUT / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    # высоты 2048² для теней и горизонта: int16 в полуметрах (как в исходном .IMG), 8 МБ
    h2 = resize(h, 2048)
    np.clip(np.round(h2 * 2), -32768, 32767).astype("<i2").tofile(OUT / "height_2048.i16")
    meta["levels"]["2048"] = {"file": "height_2048.i16", "size": 2048, "dtype": "int16", "scale": 0.5,
                              "pixelKm": 2 * HALF_EXTENT_KM / 2048, "minHeight": float(h2.min()), "maxHeight": float(h2.max())}

    # нормали из полного 80 м DEM → 4096² (детали в 5 раз мельче, чем у меша 391 м)
    gy, gx = np.gradient(h, PIX_SRC_M)
    nrm = np.stack([-gx, gy, np.ones_like(h)], axis=-1)  # x карты, y карты (вверх по строкам), наружу
    nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
    rgb = ((nrm * 0.5 + 0.5) * 255).round().astype(np.uint8)
    Image.fromarray(rgb).resize((4096, 4096), Image.LANCZOS).save(OUT / "normal_4096.jpg", quality=88)
    Image.fromarray(rgb).resize((2048, 2048), Image.LANCZOS).save(OUT / "normal_2048.jpg", quality=88)
    meta["normal"] = {"file": "normal_4096.jpg", "fileLow": "normal_2048.jpg", "size": 4096,
                      "axes": "R = +x map, G = +y map, B = up; from 80 m DEM"}
    (OUT / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    hs = hillshade(resize(h, 1024), 2 * HALF_EXTENT_KM * 1000 / 1024)
    (ROOT / "docs" / "screens").mkdir(parents=True, exist_ok=True)
    Image.fromarray((hs * 255).astype(np.uint8)).save(ROOT / "docs" / "screens" / "polar_hillshade.png")

    for f in sorted(OUT.iterdir()):
        print(f"{f.name}: {f.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
