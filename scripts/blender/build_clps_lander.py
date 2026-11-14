"""Процедурный лунный посадочный модуль (стиль CLPS) для Blender 5.2.

Запуск:
  blender --background --factory-startup --python-exit-code 1 --python scripts/build_lander.py

Выход: assets/lander.glb, assets/lander.blend, assets/lander_preview.png

Иерархия (Blender Z-up, метры; origin = уровень подошв опор):
  Lander
    Body, Deck, Tanks, Radiators...
    Engine (сопло) + Nozzle_Main (empty на срезе сопла — точка факела)
    RCS_1..4 (empty на соплах ориентации)
    LegMount_1..4 (повёрнуты по азимуту) > LegHinge_1..4 (складывание вокруг локальной Y)
    SolarMast (поворот вокруг Z) > SolarPanel (подъём вокруг локальной X)
    AntennaMast (поворот вокруг Z) > Antenna (наклон вокруг локальной X)
"""

import math
import os

import bmesh
import bpy
import numpy as np
import addon_utils

addon_utils.enable("io_scene_gltf2", default_set=False, persistent=False)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "public", "models")
os.makedirs(OUT, exist_ok=True)
GLB = os.path.join(OUT, "clps_lander.glb")
BLEND = os.path.join(ROOT, "assets", "blender", "clps_lander.blend")
PNG = os.path.join(ROOT, "docs", "screens", "model_clps_lander.png")

# --- очистка ---------------------------------------------------------------
for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.lights, bpy.data.cameras):
    for item in list(coll):
        coll.remove(item)

scene = bpy.context.scene
scene.unit_settings.system = "METRIC"
col = bpy.data.collections.new("Lander")
scene.collection.children.link(col)
stage = bpy.data.collections.new("Stage")  # только для превью, не экспортируется
scene.collection.children.link(stage)

rng = np.random.default_rng(7)


# --- текстуры ---------------------------------------------------------------

def bilinear(a, size):
    """Плавное увеличение шумовой сетки до size x size."""
    h, w = a.shape
    y = np.linspace(0, h - 1, size)
    x = np.linspace(0, w - 1, size)
    y0 = np.floor(y).astype(int)
    x0 = np.floor(x).astype(int)
    y1 = np.minimum(y0 + 1, h - 1)
    x1 = np.minimum(x0 + 1, w - 1)
    fy = (y - y0)[:, None]
    fx = (x - x0)[None, :]
    top = a[y0][:, x0] * (1 - fx) + a[y0][:, x1] * fx
    bot = a[y1][:, x0] * (1 - fx) + a[y1][:, x1] * fx
    return top * (1 - fy) + bot * fy


def to_image(name, rgb, non_color):
    h, w, _ = rgb.shape
    img = bpy.data.images.new(name, w, h, alpha=False)
    img.colorspace_settings.name = "Non-Color" if non_color else "sRGB"
    rgba = np.concatenate([rgb, np.ones((h, w, 1))], axis=2).astype(np.float32)
    img.pixels.foreach_set(rgba.ravel())
    img.pack()
    return img


def foil_normal(size=512):
    # «Мятая» термоплёнка: гребни |шум − 0.5| на нескольких масштабах
    h = np.zeros((size, size))
    for cells, amp in ((12, 1.0), (24, 0.6), (48, 0.35), (96, 0.18)):
        h += amp * np.abs(bilinear(rng.random((cells, cells)), size) - 0.5)
    gy, gx = np.gradient(h)
    k = size / 18.0
    n = np.stack([-gx * k, -gy * k, np.ones_like(h)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return to_image("foil_normal", n * 0.5 + 0.5, True)


def solar_cells(w=512, h=320):
    # тёмно-синие ячейки с серебристой сеткой
    img = np.zeros((h, w, 3))
    img[:] = (0.035, 0.06, 0.16)
    shade = 0.85 + 0.15 * bilinear(rng.random((8, 13)), max(w, h))[:h, :w]
    img *= shade[..., None]
    img[::32, :, :] = (0.55, 0.57, 0.6)
    img[:, ::32, :] = (0.55, 0.57, 0.6)
    img[1::32, :, :] = (0.55, 0.57, 0.6)
    img[:, 1::32, :] = (0.55, 0.57, 0.6)
    return to_image("solar_cells", img, False)


def principled(name, color, rough, metal, base_img=None, normal_img=None, normal_strength=1.0, emission=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if base_img is not None:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = base_img
        nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
    if normal_img is not None:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = normal_img
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.inputs["Strength"].default_value = normal_strength
        nt.links.new(t.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = 2.0
    return mat


FOIL_N = foil_normal()
MAT_GOLD = principled("Foil_Gold", (1.0, 0.70, 0.26), 0.32, 1.0, normal_img=FOIL_N, normal_strength=0.35)
MAT_SILVER = principled("Foil_Silver", (0.85, 0.86, 0.88), 0.34, 1.0, normal_img=FOIL_N, normal_strength=0.3)
MAT_WHITE = principled("Radiator_White", (0.88, 0.89, 0.9), 0.5, 0.0)
MAT_DARK = principled("Metal_Dark", (0.07, 0.07, 0.08), 0.45, 0.6)
MAT_METAL = principled("Metal_Bare", (0.62, 0.63, 0.65), 0.3, 0.9)
MAT_BELL = principled("Engine_Bell", (0.22, 0.2, 0.19), 0.4, 0.8)
MAT_SOLAR = principled("Solar_Cells", (1, 1, 1), 0.22, 0.35, base_img=solar_cells())
MAT_BLACK = principled("Composite_Black", (0.02, 0.02, 0.025), 0.55, 0.1)


# --- геометрия ----------------------------------------------------------------

def obj(name, mesh, parent, loc=(0, 0, 0), rot=(0, 0, 0)):
    o = bpy.data.objects.new(name, mesh)
    o.location = loc
    o.rotation_euler = rot
    col.objects.link(o)
    if parent is not None:
        o.parent = parent
    return o


def empty(name, parent, loc=(0, 0, 0), rot=(0, 0, 0), size=0.3):
    o = obj(name, None, parent, loc, rot)
    o.empty_display_type = "PLAIN_AXES"
    o.empty_display_size = size
    return o


def finish(bm, name, mat, smooth):
    mesh = bpy.data.meshes.new(name + "_mesh")
    bm.to_mesh(mesh)
    bm.free()
    for p in mesh.polygons:
        # торцы плоские — иначе цилиндры выглядят раздутыми
        p.use_smooth = smooth and abs(p.normal.z) < 0.999
    mesh.materials.append(mat)
    return mesh


def prism(name, r, z0, z1, segs, mat, parent, smooth=False, loc=(0, 0, 0), rot=(0, 0, 0), r_top=None):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs, radius1=r,
                          radius2=r if r_top is None else r_top, depth=max(0.005, z1 - z0))
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, (z0 + z1) / 2))
    # цилиндрические UV — для normal map фольги
    uv = bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        us = [(math.atan2(l.vert.co.y, l.vert.co.x) + math.pi) / (2 * math.pi) for l in f.loops]
        if max(us) - min(us) > 0.5:
            us = [u + 1 if u < 0.5 else u for u in us]
        for l, u in zip(f.loops, us):
            l[uv].uv = (u * 1.4, l.vert.co.z * 0.45 + (l.vert.co.x + l.vert.co.y) * 0.12)
    return obj(name, finish(bm, name, mat, smooth), parent, loc, rot)


def cuboid(name, size, loc, mat, parent, rot=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, verts=bm.verts, vec=size)
    uv = bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        n = f.normal
        for l in f.loops:
            c = l.vert.co
            l[uv].uv = (c.x + c.y, c.z) if abs(n.z) < 0.5 else (c.x, c.y)
    return obj(name, finish(bm, name, mat, False), parent, loc, rot)


def strut(name, a, b, r, mat, parent, segs=10):
    """Труба от точки a до точки b (в координатах родителя)."""
    a = np.array(a, float)
    b = np.array(b, float)
    d = b - a
    length = float(np.linalg.norm(d))
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs, radius1=r, radius2=r, depth=length)
    mesh = finish(bm, name, mat, True)
    o = obj(name, mesh, parent, tuple((a + b) / 2))
    # повернуть ось Z цилиндра вдоль d
    from mathutils import Vector
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(Vector(tuple(d / length)))
    return o


def revolve(name, profile, mat, parent, segs=32, loc=(0, 0, 0), rot=(0, 0, 0), smooth=True):
    """Тело вращения по профилю [(z, r)], открытое (для сопла и тарелки антенны)."""
    bm = bmesh.new()
    rings = []
    for z, r in profile:
        rings.append([bm.verts.new((math.cos(2 * math.pi * i / segs) * r, math.sin(2 * math.pi * i / segs) * r, z))
                      for i in range(segs)])
    for ra, rb in zip(rings, rings[1:]):
        for i in range(segs):
            bm.faces.new((ra[i], ra[(i + 1) % segs], rb[(i + 1) % segs], rb[i]))
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    mesh = finish(bm, name, mat, smooth)
    o = obj(name, mesh, parent, loc, rot)
    # двусторонность нужна: сопло видно и изнутри
    mat.use_backface_culling = False
    return o


lander = empty("Lander", None, size=1.0)

# Корпус: восьмигранник в золотой фольге
BODY_R = 1.05
prism("Body", BODY_R, 1.05, 2.25, 8, MAT_GOLD, lander, rot=(0, 0, math.pi / 8))
prism("DeckLower", BODY_R + 0.08, 0.97, 1.05, 8, MAT_METAL, lander, rot=(0, 0, math.pi / 8))
prism("Deck", BODY_R + 0.1, 2.25, 2.33, 8, MAT_METAL, lander, rot=(0, 0, math.pi / 8))
# топливные баки под палубой (видны между опорами)
for i, a in enumerate((0.0, math.pi)):
    prism(f"Tank_{i}", 0.42, 0.62, 1.0, 20, MAT_SILVER, lander, smooth=True,
          loc=(math.cos(a) * 0.48, math.sin(a) * 0.48, 0))
# радиаторы и приборные блоки
cuboid("Radiator_A", (0.05, 1.1, 0.95), (BODY_R + 0.02, 0, 1.65), MAT_WHITE, lander)
cuboid("Radiator_B", (0.05, 1.1, 0.95), (-BODY_R - 0.02, 0, 1.65), MAT_WHITE, lander)
cuboid("Payload_1", (0.55, 0.45, 0.32), (-0.35, 0.3, 2.49), MAT_SILVER, lander)
cuboid("Payload_2", (0.4, 0.4, 0.5), (0.4, -0.35, 2.58), MAT_BLACK, lander)
cuboid("Camera_Box", (0.18, 0.18, 0.14), (0.0, -BODY_R - 0.05, 2.15), MAT_DARK, lander)

# Двигатель: сопло расширяется книзу
engine = empty("Engine", lander, (0, 0, 0.97))
revolve("EngineBell", [(0.0, 0.17), (-0.12, 0.2), (-0.32, 0.29), (-0.55, 0.42)], MAT_BELL, engine, segs=36)
prism("EngineThroat", 0.14, -0.05, 0.08, 16, MAT_DARK, engine, smooth=True)
empty("Nozzle_Main", engine, (0, 0, -0.56), size=0.2)

# Двигатели ориентации (RCS) по углам палубы
for i in range(4):
    a = math.pi / 4 + i * math.pi / 2
    x, y = math.cos(a) * (BODY_R + 0.12), math.sin(a) * (BODY_R + 0.12)
    cuboid(f"RCS_Block_{i + 1}", (0.14, 0.14, 0.12), (x, y, 2.2), MAT_DARK, lander, rot=(0, 0, a))
    prism(f"RCS_Nozzle_{i + 1}", 0.035, 0, 0.09, 10, MAT_METAL, lander, smooth=True,
          loc=(x + math.cos(a) * 0.08, y + math.sin(a) * 0.08, 2.2),
          rot=(0, math.pi / 2, a), r_top=0.02)
    empty(f"RCS_{i + 1}", lander, (x + math.cos(a) * 0.17, y + math.sin(a) * 0.17, 2.2), rot=(0, 0, a), size=0.1)

# Опоры: LegMount повёрнут по азимуту, LegHinge складывается вокруг локальной Y
HINGE = (BODY_R - 0.05, 0.0, 1.55)
for i in range(4):
    a = math.pi / 4 + i * math.pi / 2
    mount = empty(f"LegMount_{i + 1}", lander, (0, 0, 0), rot=(0, 0, a), size=0.2)
    hinge = empty(f"LegHinge_{i + 1}", mount, HINGE, size=0.15)
    foot = (1.05, 0.0, -1.48)  # относительно шарнира: подошва на z≈0 при раскрытой опоре
    strut(f"LegMain_{i + 1}", (0, 0, 0), foot, 0.055, MAT_METAL, hinge)
    # амортизатор: чуть толще у шарнира
    strut(f"LegDamper_{i + 1}", (0.0, 0, 0), (0.45, 0, -0.63), 0.085, MAT_DARK, hinge)
    # подкосы к нижней части корпуса
    for side in (-1, 1):
        strut(f"LegBrace_{i + 1}_{'ab'[side > 0]}", (-0.05, side * 0.38, -0.5), (0.72, 0, -1.01), 0.03, MAT_METAL, hinge)
    pad = prism(f"Footpad_{i + 1}", 0.26, -0.05, 0.03, 18, MAT_METAL, hinge, smooth=True,
                loc=(foot[0], 0, foot[2] - 0.03), r_top=0.2)

# Солнечная панель: мачта (рысканье) + панель (подъём). В полёте лежит на палубе.
mast = empty("SolarMast", lander, (-0.55, -0.45, 2.33), size=0.2)
strut("SolarPost", (0, 0, 0), (0, 0, 0.35), 0.035, MAT_METAL, mast)
panel = empty("SolarPanel", mast, (0, 0, 0.35), size=0.2)
cuboid("SolarCells", (1.7, 0.03, 1.05), (0, 0, 0.55), MAT_SOLAR, panel)
cuboid("SolarFrame", (1.76, 0.02, 1.11), (0, 0.012, 0.55), MAT_METAL, panel)  # рамка сзади: ячейки смотрят в −Y

# Антенна направленной связи с Землёй
amast = empty("AntennaMast", lander, (0.55, 0.45, 2.33), size=0.2)
strut("AntennaPost", (0, 0, 0), (0, 0, 0.55), 0.03, MAT_METAL, amast)
antenna = empty("Antenna", amast, (0, 0, 0.55), size=0.2)
dish = [(0.0 + 0.32 * (t / 6) ** 2, 0.34 * t / 6 + 0.01) for t in range(7)]
revolve("AntennaDish", dish, MAT_WHITE, antenna, segs=28, rot=(-math.pi / 2, 0, 0), loc=(0, 0.05, 0))  # вогнутой стороной к +Y
strut("AntennaFeed", (0, 0.05, 0), (0, 0.33, 0), 0.012, MAT_METAL, antenna)

# --- превью ----------------------------------------------------------------------
gm = bpy.data.meshes.new("Regolith_mesh")
bm = bmesh.new()
bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=40)
bm.to_mesh(gm)
bm.free()
ground = bpy.data.objects.new("Regolith", gm)
stage.objects.link(ground)
ground.data.materials.append(principled("Regolith", (0.32, 0.31, 0.3), 0.95, 0.0))

world = bpy.data.worlds.new("Space")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.0, 0.0, 0.0, 1.0)

# Низкое Солнце Южного полюса: ~6° над горизонтом для читаемого превью
sun_d = bpy.data.lights.new("Sun", "SUN")
sun_d.energy = 6.0
sun_d.angle = math.radians(0.53)
sun = bpy.data.objects.new("Sun", sun_d)
sun.rotation_euler = (math.radians(82), 0, math.radians(-25))
stage.objects.link(sun)
fill_d = bpy.data.lights.new("Earthshine", "SUN")
fill_d.energy = 0.25
fill = bpy.data.objects.new("Earthshine", fill_d)
fill.rotation_euler = (math.radians(60), 0, math.radians(150))
stage.objects.link(fill)

cam_d = bpy.data.cameras.new("PreviewCam")
cam_d.lens = 50
cam = bpy.data.objects.new("PreviewCam", cam_d)
cam.location = (7.2, -8.0, 3.4)
stage.objects.link(cam)
look = bpy.data.objects.new("CamTarget", None)
look.location = (0, 0, 1.45)
stage.objects.link(look)
tr = cam.constraints.new("TRACK_TO")
tr.target = look
tr.track_axis = "TRACK_NEGATIVE_Z"
tr.up_axis = "UP_Y"
scene.camera = cam

for engine_name in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
    try:
        scene.render.engine = engine_name
        break
    except TypeError:
        continue
try:
    scene.view_settings.view_transform = "AgX"
except Exception:
    pass
scene.render.resolution_x = 1280
scene.render.resolution_y = 960
scene.render.filepath = PNG
scene.render.image_settings.file_format = "PNG"
if hasattr(scene, "eevee") and hasattr(scene.eevee, "taa_render_samples"):
    scene.eevee.taa_render_samples = 48

bpy.context.view_layer.update()
bpy.ops.wm.save_as_mainfile(filepath=BLEND)
bpy.ops.render.render(write_still=True)
print("RENDERED", PNG)

# --- экспорт только модуля ---------------------------------------------------------
for o in bpy.data.objects:
    o.select_set(o.name in col.objects)
bpy.context.view_layer.objects.active = lander
bpy.ops.export_scene.gltf(
    filepath=GLB,
    export_format="GLB",
    use_selection=True,
    export_apply=False,
    export_yup=True,
    export_animations=False,
)
tris = 0
for o in col.objects:
    if o.type == "MESH":
        o.data.calc_loop_triangles()
        tris += len(o.data.loop_triangles)
print("EXPORTED", GLB, "triangles:", tris)
