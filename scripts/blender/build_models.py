"""Процедурные 3D-модели аппаратов по референсам (концепт-арт NASA) -> GLB + превью Cycles.

Запуск (headless, ~1–3 мин):
  "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" --background --factory-startup \
      --python-exit-code 1 --python scripts/blender/build_models.py -- [model ...]
  model: artemis_lander | astronaut | sls   (по умолчанию — все)

Выход: public/models/<model>.glb, docs/screens/model_<model>.png, assets/blender/<model>.blend
Единицы — метры, Z вверх в Blender (glTF экспортируется с +Y вверх), origin на уровне опор.
Вращаемые части: объекты-пивоты SolarPanels и Antenna.
Это модели аппаратов, а не рельеф: процедурная геометрия здесь допустима (на питче — «artist's concept»).
"""
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
import textures  # noqa: E402  — процедурные текстуры-картинки (уходят в GLB)

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / "public" / "models"
SCREENS = ROOT / "docs" / "screens"
BLENDS = ROOT / "assets" / "blender"
MAX_TRIS = 15000


# ---------- помощники ----------

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


_mats = {}


def mat(name, color, metallic=0.0, roughness=0.5):
    if name in _mats and _mats[name].name in bpy.data.materials:
        return _mats[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1.0)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = roughness
    _mats[name] = m
    return m


def finish(o, m, parent=None, smooth=False, name=None):
    if name:
        o.name = name
    o.data.materials.append(m)
    if smooth:
        for p in o.data.polygons:
            p.use_smooth = True
    if parent is not None:
        o.parent = parent
        o.matrix_parent_inverse = parent.matrix_world.inverted()  # сохраняем мировую позицию
    return o


def empty(name, loc=(0, 0, 0), parent=None):
    bpy.ops.object.empty_add(location=loc)
    o = bpy.context.object
    o.name = name
    if parent is not None:
        o.parent = parent
        o.matrix_parent_inverse = parent.matrix_world.inverted()
    return o


def cyl(r, depth, loc, m, parent=None, verts=16, r2=None, rot=(0, 0, 0), name=None):
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=loc, rotation=rot)
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r2, depth=depth, location=loc, rotation=rot)
    return finish(bpy.context.object, m, parent, smooth=verts > 8, name=name)


def sphere(r, loc, m, parent=None, scale=(1, 1, 1), seg=16, rings=10, name=None):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=rings, radius=r, location=loc)
    o = bpy.context.object
    o.scale = scale
    return finish(o, m, parent, smooth=True, name=name)


def box(size, loc, m, parent=None, rot=(0, 0, 0), name=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object
    o.scale = size
    return finish(o, m, parent, name=name)


def strut(a, b, r, m, parent=None, verts=6):
    a, b = Vector(a), Vector(b)
    d = b - a
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=d.length, location=(a + b) / 2)
    o = bpy.context.object
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d.normalized())
    return finish(o, m, parent)


def polar(r, deg, z):
    a = math.radians(deg)
    return (r * math.cos(a), r * math.sin(a), z)


# ---------- материалы ----------

def emissive(name, color, strength=8.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1.0)
    b.inputs["Emission Color"].default_value = (*color, 1.0)
    b.inputs["Emission Strength"].default_value = strength
    return m


def palette():
    foil = textures.gold_foil()
    return {
        "gold": foil,
        "gold_rough": foil,
        "alu": mat("Aluminium", (0.78, 0.79, 0.8), 1.0, 0.38),
        "dark": mat("DarkMetal", (0.07, 0.07, 0.08), 0.8, 0.45),
        "white": textures.white_panels(),
        "grey": mat("GreyPanel", (0.45, 0.47, 0.5), 0.2, 0.55),
        "cells": mat("SolarCells", (0.03, 0.07, 0.22), 0.4, 0.25),
        "glass": mat("Window", (0.02, 0.025, 0.03), 0.0, 0.08),
        "visor": mat("GoldVisor", (1.0, 0.7, 0.25), 1.0, 0.08),
        "fabric": mat("SuitFabric", (0.88, 0.88, 0.86), 0.0, 0.85),
        "orange": textures.orange_foam(),
        "nav_red": emissive("NavRed", (1.0, 0.08, 0.05)),
        "nav_green": emissive("NavGreen", (0.1, 1.0, 0.25)),
        "lamp": emissive("FloodLamp", (1.0, 0.95, 0.85), 4.0),
        "black": mat("Black", (0.02, 0.02, 0.02), 0.0, 0.6),
    }


# ---------- модели ----------

def build_clps_lander(P):
    """Малый посадочный модуль CLPS, ~4 м."""
    root = empty("Lander")
    cyl(0.9, 1.2, (0, 0, 1.65), P["gold"], root, verts=8, name="Body")
    cyl(0.97, 0.08, (0, 0, 2.29), P["white"], root, verts=8)
    cyl(0.97, 0.06, (0, 0, 1.03), P["white"], root, verts=8)
    cyl(0.36, 0.5, (0, 0, 0.75), P["dark"], root, r2=0.16)
    for k in range(4):
        sphere(0.28, polar(0.95, 45 + 90 * k, 1.35), P["white"], root, seg=12, rings=8)
    for k in range(4):
        deg = 90 * k
        foot = polar(1.75, deg, 0.05)
        strut(polar(0.78, deg, 1.05), foot, 0.06, P["alu"], root)
        strut(polar(0.86, deg, 1.95), foot, 0.04, P["alu"], root)
        for s in (-25, 25):
            strut(polar(0.85, deg + s, 1.1), foot, 0.03, P["alu"], root)
        cyl(0.24, 0.08, (foot[0], foot[1], 0.04), P["alu"], root, verts=12)
    panels = empty("SolarPanels", (0, 0, 2.33), root)
    cyl(0.05, 0.9, (0, 0, 2.78), P["alu"], panels, verts=8)
    for s in (-1, 1):
        box((1.5, 0.04, 1.1), (s * 0.85, 0, 3.15), P["cells"], panels)
        strut((0, 0, 3.15), (s * 0.12, 0, 3.15), 0.035, P["alu"], panels)
        for z in (2.6, 3.7):
            box((1.52, 0.06, 0.04), (s * 0.85, 0, z), P["alu"], panels)
    ant = empty("Antenna", (0.62, -0.42, 2.33), root)
    cyl(0.035, 0.5, (0.62, -0.42, 2.58), P["alu"], ant, verts=6)
    cyl(0.32, 0.12, (0.62, -0.42, 2.9), P["white"], ant, r2=0.05, rot=(math.radians(215), 0, 0))
    return root, dict(cam=(7.5, -6.5, 3.2), target=(0, 0, 1.7), size=40)


def build_artemis_lander(P):
    """Пилотируемый посадочный модуль по концепту NASA (Artemis HLS concept), ~10.5 м."""
    root = empty("Lander")
    # посадочная ступень: цилиндр с панелями
    cyl(2.3, 4.2, (0, 0, 3.0), P["white"], root, verts=32, name="DescentStage")
    for z in (1.3, 2.5, 3.7, 4.9):  # стыки панелей
        cyl(2.315, 0.04, (0, 0, z), P["grey"], root, verts=32)
    box((0.06, 1.7, 3.6), (0, -2.28, 3.0), P["alu"], root, rot=(0, 0, math.radians(90)))  # боковая панель
    box((1.6, 0.08, 3.4), polar(2.25, -90, 3.0), P["grey"], root)
    cyl(0.75, 0.9, (0, 0, 0.75), P["dark"], root, r2=0.4)  # двигатель
    # лестница
    for k in range(9):
        box((0.6, 0.05, 0.04), (0, -2.42, 0.45 + k * 0.45), P["alu"], root)
    for s in (-0.3, 0.3):
        strut((s, -2.42, 0.2), (s, -2.42, 4.4), 0.025, P["alu"], root)
    # палуба-кольцо
    cyl(2.95, 0.16, (0, 0, 5.2), P["dark"], root, verts=32)
    cyl(2.5, 0.1, (0, 0, 5.34), P["grey"], root, verts=32)
    # золотые баки
    for k in range(4):
        sphere(0.82, polar(1.35, 45 + 90 * k, 6.15), P["gold_rough"], root, seg=14, rings=10)
    # ферма к кабине
    for k in range(6):
        a = 60 * k
        strut(polar(2.4, a, 5.3), polar(0.9, a + 30, 6.9), 0.05, P["dark"], root)
    # кабина: горизонтальный цилиндр + сферический торец + стыковочный узел
    cyl(1.15, 2.7, (0, 0, 7.55), P["white"], root, verts=24, rot=(0, math.radians(90), 0), name="Cabin")
    sphere(1.15, (1.35, 0, 7.55), P["white"], root, scale=(0.55, 1, 1), seg=24, rings=12)
    cyl(0.75, 0.35, (-1.5, 0, 7.55), P["grey"], root, verts=24, rot=(0, math.radians(90), 0))
    cyl(0.55, 0.12, (-1.72, 0, 7.55), P["dark"], root, verts=24, rot=(0, math.radians(90), 0))
    for k in range(4):  # иллюминаторы на торце
        box((0.05, 0.28, 0.2), (1.92, -0.45 + k * 0.3, 7.8), P["glass"], root, rot=(0, math.radians(-25), 0))
    # восьмиугольная солнечная панель на мачте — вращается к Солнцу
    panels = empty("SolarPanels", (0, 0, 8.7), root)
    cyl(0.06, 1.5, (0, 0, 9.45), P["alu"], panels, verts=8)
    cyl(1.4, 0.05, (0, 0.12, 10.6), P["cells"], panels, verts=8, rot=(math.radians(90), 0, 0))
    cyl(1.45, 0.06, (0, 0.15, 10.6), P["alu"], panels, verts=8, rot=(math.radians(90), 0, 0))
    for k in range(8):  # рёбра панели
        a = math.radians(22.5 + 45 * k)
        strut((0, 0.08, 10.6), (1.38 * math.cos(a), 0.08, 10.6 + 1.38 * math.sin(a)), 0.02, P["alu"], panels)
    # опоры: ферменные ноги с подошвами
    for k in range(4):
        deg = 45 + 90 * k
        foot = polar(3.9, deg, 0.08)
        strut(polar(2.25, deg, 2.8), foot, 0.09, P["alu"], root)
        strut(polar(2.25, deg, 1.2), foot, 0.07, P["alu"], root)
        for s in (-22, 22):
            strut(polar(2.3, deg + s, 1.9), polar(3.3, deg, 0.6), 0.045, P["alu"], root)
        cyl(0.5, 0.12, (foot[0], foot[1], 0.06), P["alu"], root, verts=16)
    # блоки двигателей ориентации (RCS) на палубе: точки для выбросов газа в three.js
    for k in range(4):
        deg = 90 * k
        x, y, _ = polar(2.75, deg, 0)
        blk = empty(f"RCS_{k + 1}", (x, y, 5.05), root)
        box((0.3, 0.3, 0.25), (x, y, 5.05), P["grey"], blk)
        for d in (-1, 1):
            cyl(0.06, 0.18, (x + d * 0.18 * math.cos(math.radians(deg + 90)), y + d * 0.18 * math.sin(math.radians(deg + 90)), 5.05), P["dark"], blk, verts=8,
                r2=0.03, rot=(0, math.radians(90), math.radians(deg + 90)))
    # навигационные огни: красный/зелёный по бортам, белые прожекторы под палубой
    for name, deg, m in (("NavLight_Red", 90, P["nav_red"]), ("NavLight_Green", 270, P["nav_green"])):
        sphere(0.07, polar(2.98, deg, 5.3), m, root, seg=10, rings=6, name=name)
    for k in range(3):
        sphere(0.09, polar(2.36, 30 + 120 * k, 4.95), P["lamp"], root, seg=10, rings=6, name=f"FloodLamp_{k + 1}")
    # мачта антенны
    ant = empty("Antenna", polar(2.6, 200, 5.3), root)
    base = polar(2.6, 200, 5.3)
    strut(base, (base[0], base[1], 7.4), 0.04, P["alu"], ant)
    cyl(0.4, 0.15, (base[0], base[1], 7.5), P["white"], ant, r2=0.06, rot=(math.radians(200), 0, 0))
    return root, dict(cam=(22, -19, 7.5), target=(0, 0, 5.8), size=90)


def capsule(r, length, top, m, parent, verts=16, name=None):
    """Цилиндр со сферическими торцами от точки top вниз на length (сегмент конечности)."""
    x, y, z = top
    cyl(r, length, (x, y, z - length / 2), m, parent, verts=verts, name=name)
    sphere(r, (x, y, z), m, parent, seg=verts, rings=8)
    sphere(r, (x, y, z - length), m, parent, seg=verts, rings=8)


def build_astronaut(P):
    """Астронавт с суставами (пивоты-пустышки) для процедурной анимации в three.js. 1.86 м.

    Иерархия: Astronaut > Pelvis > Spine > Neck (шлем), ShoulderL/R > ElbowL/R;
              Pelvis > HipL/R > KneeL/R. Лицом к −Y (в glTF — к +Z).
    """
    f = textures.suit_fabric()
    joint = mat("SuitJoint", (0.55, 0.57, 0.6), 0.1, 0.7)
    glove = mat("Gloves", (0.32, 0.36, 0.42), 0.1, 0.6)
    boot = mat("Boots", (0.62, 0.63, 0.64), 0.1, 0.7)
    sole = mat("Soles", (0.08, 0.08, 0.09), 0.0, 0.9)
    red = mat("CommanderStripe", (0.75, 0.08, 0.06), 0.0, 0.6)
    root = empty("Astronaut")
    def bellows(x, y, z, r, parent, n=3):
        # гофры шарнира скафандра
        for i in range(n):
            cyl(r, 0.018, (x, y, z + (i - (n - 1) / 2) * 0.03), joint, parent, verts=14)

    pelvis = empty("Pelvis", (0, 0, 0.95), root)
    sphere(0.19, (0, 0, 0.97), f, pelvis, scale=(1.05, 0.78, 0.7), seg=20, rings=12)
    cyl(0.17, 0.06, (0, 0, 1.06), joint, pelvis, verts=20)  # пояс-подшипник

    spine = empty("Spine", (0, 0, 1.05), pelvis)
    sphere(0.27, (0, 0, 1.3), f, spine, scale=(1.0, 0.68, 0.95), seg=32, rings=18, name="Torso")
    # шланги жизнеобеспечения: ранец → блок на груди
    for sx in (-0.12, 0.12):
        strut((sx, 0.2, 1.45), (sx * 1.3, -0.12, 1.42), 0.022, P["grey"], spine, verts=10)
        strut((sx * 1.3, -0.12, 1.42), (sx * 0.6, -0.2, 1.33), 0.022, P["grey"], spine, verts=10)
    box((0.22, 0.08, 0.15), (0, -0.2, 1.32), P["grey"], spine)  # блок управления на груди
    for i, c in enumerate((P["dark"], red, P["alu"])):
        box((0.04, 0.02, 0.025), (-0.06 + i * 0.06, -0.245, 1.35), c, spine)
    box((0.5, 0.26, 0.66), (0, 0.29, 1.32), P["white"], spine, name="PLSS")
    box((0.42, 0.04, 0.5), (0, 0.43, 1.32), P["grey"], spine)
    cyl(0.03, 0.4, (0.16, 0.44, 1.32), P["alu"], spine, verts=8)

    neck = empty("Neck", (0, 0, 1.55), spine)
    cyl(0.13, 0.06, (0, 0, 1.56), joint, neck, verts=20)
    sphere(0.175, (0, 0, 1.72), P["white"], neck, seg=24, rings=14, name="Helmet")
    # визор выступает перед шлемом целиком (без пересечения поверхностей → без мерцания)
    sphere(0.165, (0, -0.06, 1.715), P["visor"], neck, scale=(0.92, 0.78, 0.8), seg=24, rings=14, name="Visor")
    for sx in (-0.12, 0.12):  # фонари на шлеме
        box((0.05, 0.05, 0.035), (sx, -0.02, 1.86), P["dark"], neck)
        box((0.035, 0.01, 0.022), (sx, -0.046, 1.86), mat("Lamp", (1.0, 0.95, 0.8), 0.0, 0.2), neck)

    for side, sx in (("L", 1), ("R", -1)):
        sh = empty(f"Shoulder{side}", (sx * 0.29, 0, 1.44), spine)
        sphere(0.115, (sx * 0.29, 0, 1.44), f, sh, seg=16, rings=10)
        capsule(0.075, 0.24, (sx * 0.31, 0, 1.38), f, sh, verts=14)
        if side == "L":
            cyl(0.08, 0.05, (sx * 0.31, 0, 1.3), red, sh)  # красная полоса командира
        el = empty(f"Elbow{side}", (sx * 0.31, 0, 1.13), sh)
        bellows(sx * 0.31, 0, 1.13, 0.072, el)
        capsule(0.065, 0.22, (sx * 0.31, 0, 1.1), f, el, verts=14)
        cyl(0.07, 0.04, (sx * 0.31, 0, 0.9), P["alu"], el, verts=20)  # кольцо перчатки
        sphere(0.075, (sx * 0.31, -0.01, 0.84), glove, el, scale=(0.85, 1.0, 1.25), seg=12, rings=8)

        hip = empty(f"Hip{side}", (sx * 0.11, 0, 0.92), pelvis)
        capsule(0.1, 0.38, (sx * 0.11, 0, 0.9), f, hip, verts=14)
        kn = empty(f"Knee{side}", (sx * 0.11, 0, 0.5), hip)
        bellows(sx * 0.11, 0, 0.5, 0.097, kn)
        capsule(0.085, 0.32, (sx * 0.11, 0, 0.47), f, kn, verts=14)
        # округлый ботинок: голенище + носок + подошва
        cyl(0.095, 0.14, (sx * 0.11, 0, 0.12), boot, kn, verts=20)
        sphere(0.095, (sx * 0.11, -0.09, 0.07), boot, kn, scale=(0.95, 1.35, 0.65), seg=18, rings=10)
        box((0.17, 0.31, 0.035), (sx * 0.11, -0.05, 0.0175), sole, kn)
    return root, dict(cam=(2.8, -3.6, 1.7), target=(0, 0, 1.0), size=12)


def build_sls(P):
    """SLS Block 1B (по иллюстрации NASA), ~111 м. Без логотипов."""
    root = empty("SLS")
    o, w = P["orange"], P["white"]
    cyl(4.2, 65, (0, 0, 35.5), o, root, verts=32, name="CoreStage")
    for z in (8, 30, 52, 67.5):
        cyl(4.23, 0.4, (0, 0, z), P["grey"], root, verts=32)
    cyl(4.2, 12, (0, 0, 74), w, root, verts=32, name="UpperStage")
    cyl(4.22, 0.5, (0, 0, 80), P["grey"], root, verts=32)
    cyl(4.2, 11, (0, 0, 85.5), w, root, verts=32, name="Fairing")
    cyl(4.2, 16, (0, 0, 99), w, root, verts=32, r2=0.9)
    sphere(0.9, (0, 0, 107), w, root, seg=16, rings=8)
    for s in (-1, 1):
        x = s * 6.6
        cyl(1.85, 52, (x, 0, 31), w, root, verts=20, name=f"Booster{'L' if s < 0 else 'R'}")
        cyl(1.85, 8, (x, 0, 61), w, root, verts=20, r2=0.25)
        cyl(2.4, 4, (x, 0, 3), w, root, verts=20, r2=1.85)
        cyl(1.2, 2.5, (x, 0, 1.25), P["dark"], root, verts=16, r2=0.7)
        for z in (14, 26, 38, 50):
            cyl(1.88, 0.35, (x, 0, z), P["black"], root, verts=20)
        strut((x - s * 1.8, 0, 50), (s * 4.1, 0, 50), 0.35, P["grey"], root)
        strut((x - s * 1.8, 0, 8), (s * 4.1, 0, 8), 0.35, P["grey"], root)
    for k in range(4):  # 4 × RS-25
        x, y = (1.7 if k % 2 else -1.7), (1.7 if k < 2 else -1.7)
        cyl(1.25, 3.4, (x, y, 1.7), P["dark"], root, verts=16, r2=0.55)
    return root, dict(cam=(95, -150, 55), target=(0, 0, 52), size=400, portrait=True)


# clps_lander теперь строит scripts/blender/build_clps_lander.py (модель с ригом из тестового проекта);
# build_clps_lander здесь оставлен как упрощённый запасной вариант.
BUILDERS = {
    "artemis_lander": build_artemis_lander,
    "astronaut": build_astronaut,
    "sls": build_sls,
}


# ---------- экспорт и превью ----------

def stats():
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    dg = bpy.context.evaluated_depsgraph_get()  # с учётом фасок
    tris = sum(len(p.vertices) - 2 for o in meshes for p in o.evaluated_get(dg).data.polygons)
    zs = [(o.matrix_world @ Vector(v.co)).z for o in meshes for v in o.data.vertices]
    return tris, min(zs), max(zs)


def render_preview(name, view):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    portrait = view.get("portrait")
    scene.render.resolution_x, scene.render.resolution_y = (700, 1100) if portrait else (1200, 800)
    world = bpy.data.worlds.new("Space")
    world.color = (0, 0, 0)
    scene.world = world
    bpy.ops.mesh.primitive_plane_add(size=view["size"], location=(0, 0, 0))
    finish(bpy.context.object, mat("Regolith", (0.17, 0.17, 0.16), 0.0, 0.95))
    # низкое Солнце, как на полюсе (~12° над горизонтом для читаемости превью)
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(78), 0, math.radians(-55)))
    bpy.context.object.data.energy = 5
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(60), 0, math.radians(140)))
    bpy.context.object.data.energy = 0.4  # слабый «пепельный» контровой
    bpy.ops.object.camera_add(location=view["cam"])
    cam = bpy.context.object
    cam.data.lens = 50
    cam.rotation_euler = (Vector(view["target"]) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    scene.render.filepath = str(SCREENS / f"model_{name}.png")
    bpy.ops.render.render(write_still=True)


def build(name):
    reset()
    _mats.clear()
    root, view = BUILDERS[name](palette())
    # применяем поворот/масштаб у мешей, чтобы в glTF были чистые трансформы
    bpy.ops.object.select_all(action="DESELECT")
    for o in bpy.data.objects:
        if o.type == "MESH":
            o.select_set(True)
            bpy.context.view_layer.objects.active = o
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    textures.uv_unwrap(meshes)
    textures.bevel_all(meshes, width=0.012 if name == "astronaut" else 0.03 if name != "sls" else 0.15, segments=2 if name == "astronaut" else 1)
    tris, zmin, zmax = stats()
    print(f"[models] {name}: triangles={tris} z=[{zmin:.2f}, {zmax:.2f}] m")
    assert tris <= MAX_TRIS * 1.6, f"{name}: {tris} triangles > budget"
    assert abs(zmin) < 0.05, f"{name}: origin is not at the soles (zmin={zmin:.2f})"

    MODELS.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(MODELS / f"{name}.glb"), export_format="GLB", export_yup=True, export_apply=True)
    BLENDS.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLENDS / f"{name}.blend"))
    SCREENS.mkdir(parents=True, exist_ok=True)
    render_preview(name, view)
    print(f"[models] {name}: ok")


if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    for n in args or list(BUILDERS):
        build(n)
