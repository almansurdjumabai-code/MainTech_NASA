"""2D-запаска (этап 7): снимок Южного полюса с тенями от рельефа на 4 даты.

Тот же алгоритм, что в шейдере: луч к Солнцу в 3D над сферой R + h (кривизна учтена),
угловой размер Солнца 0.53° даёт мягкий край. Солнце — из public/data/ephem_subpoints.json (JPL Horizons).

Вход:  public/data/polar/height_512.f32 + meta.json, public/data/ephem_subpoints.json
Выход: public/fallback/polar_YYYY-MM-DD.jpg + fallback.json
"""
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
POLAR = ROOT / "public" / "data" / "polar"
OUT = ROOT / "public" / "fallback"
R = 1737.4
DATES = ["2027-03-12T12:00:00Z", "2027-03-24T12:00:00Z", "2027-06-21T00:00:00Z", "2027-12-21T00:00:00Z"]
SUN_R = math.radians(0.2665)


def sun_vector(iso, rows):
    t = datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000
    ts = np.array([r["t"] for r in rows])
    i = int(np.clip(np.searchsorted(ts, t), 1, len(ts) - 1))
    a, b = rows[i - 1], rows[i]
    k = (t - a["t"]) / (b["t"] - a["t"])
    lat = math.radians(a["sunLat"] + (b["sunLat"] - a["sunLat"]) * k)
    dlon = ((b["sunLon"] - a["sunLon"] + 540) % 360) - 180
    lon = math.radians(a["sunLon"] + dlon * k)
    # система Луны проекта: +X — lon 0, +Y — север, восток к −Z
    return np.array([math.cos(lat) * math.cos(lon), math.sin(lat), -math.cos(lat) * math.sin(lon)])


def main():
    meta = json.loads((POLAR / "meta.json").read_text(encoding="utf-8"))
    n = 512
    half = meta["halfExtentKm"]
    pix = 2 * half / n
    h = np.fromfile(POLAR / "height_512.f32", "<f4").reshape(n, n) / 1000.0  # км, строка 0 = +y
    hmax = h.max()
    rows = json.loads((ROOT / "public" / "data" / "ephem_subpoints.json").read_text(encoding="utf-8"))["rows"]

    xs = -half + (np.arange(n) + 0.5) * pix
    X, Y = np.meshgrid(xs, -xs)  # Y: строка 0 = +half

    def dir_from_map(x, y):
        rho2 = (x * x + y * y) / (4 * R * R)
        k = 1 / (rho2 + 1)
        return np.stack([y / R * k, (rho2 - 1) * k, -x / R * k], axis=-1)

    def height_at(x, y):  # билинейно, км
        c = np.clip((x + half) / pix - 0.5, 0, n - 1.001)
        r = np.clip((half - y) / pix - 0.5, 0, n - 1.001)
        c0, r0 = c.astype(int), r.astype(int)
        fc, fr = c - c0, r - r0
        return (h[r0, c0] * (1 - fc) + h[r0, c0 + 1] * fc) * (1 - fr) + (h[r0 + 1, c0] * (1 - fc) + h[r0 + 1, c0 + 1] * fc) * fr

    U = dir_from_map(X, Y)
    P = U * (R + h + 0.002)[..., None]

    # нормали в локальной системе (км) для освещения
    gy, gx = np.gradient(h, pix)
    N = np.stack([-gx, gy, np.ones_like(h)], axis=-1)  # x-карта, y-карта, вверх
    N /= np.linalg.norm(N, axis=-1, keepdims=True)

    OUT.mkdir(parents=True, exist_ok=True)
    out = {"source": "LOLA LDEM_80S_80M + JPL Horizons", "halfExtentKm": half, "projection": meta["projection"], "frames": []}
    for iso in DATES:
        s = sun_vector(iso, rows)
        max_occ = np.full((n, n), -1.0)
        alive = np.ones((n, n), bool)
        t = 0.25
        for _ in range(220):
            Q = P + s * t
            rq = np.linalg.norm(Q, axis=-1)
            k = 2 * R / (1 - Q[..., 1] / rq)
            mx, my = -Q[..., 2] / rq * k, Q[..., 0] / rq * k
            inside = (np.abs(mx) <= half) & (np.abs(my) <= half) & (rq <= R + hmax + 0.01)
            alive &= inside
            if not alive.any():
                break
            occ = (R + height_at(mx, my) - rq) / t
            max_occ = np.where(alive, np.maximum(max_occ, occ), max_occ)
            t = t * 1.03 + 0.06
        vis = np.clip(0.5 - max_occ / (2 * SUN_R), 0, 1)
        # направление Солнца в локальной системе карты: x = −s.z, y = s.x, вверх = −s.y (у полюса)
        sl = np.array([-s[2], s[0], -s[1]])
        sl /= np.linalg.norm(sl)
        mu0 = np.clip(N @ sl, 0, None)
        img = np.clip((0.16 * mu0 * 6.5 * vis) ** (1 / 2.2), 0, 1)
        name = f"polar_{iso[:10]}.jpg"
        Image.fromarray((img * 255).astype(np.uint8)).resize((1024, 1024), Image.BICUBIC).save(OUT / name, quality=88)
        lat = math.degrees(math.asin(s[1]))
        out["frames"].append({"date": iso, "file": name, "subSolarLat": round(lat, 3)})
        print(f"{name}: sub-solar lat {lat:+.2f}°, lit {vis.mean() * 100:.1f}% of tile")
    (OUT / "fallback.json").write_text(json.dumps(out, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
