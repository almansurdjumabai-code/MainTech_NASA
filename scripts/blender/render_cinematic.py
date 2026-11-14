"""Кинематографичный ролик посадки на НАСТОЯЩЕМ рельефе LOLA (для питча).

  blender --background --factory-startup --python-exit-code 1 --python scripts/blender/render_cinematic.py -- \
      [--stills 60,115,200] [--frames 240] [--out docs/cinematic/landing.mp4]

Рельеф: LDEM_80S_80M (80 м/пикс), квадрат 64×64 км вокруг точки, вершины на сфере R + h → кривизна точная.
Солнце и Земля: направление на дату из public/data/ephem_subpoints.json (JPL Horizons), Земля с параллаксом.
Пыль: частицы Blender при g = 1.62 м/с² без сопротивления воздуха (на Луне его нет).
Аппараты: artemis_lander.glb, astronaut.glb (с суставами), flag.glb (флаг команды).
"""
import argparse
import json
import math
import sys
from datetime import datetime
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
ap = argparse.ArgumentParser()
ap.add_argument("--lat", type=float, default=-86.0)
ap.add_argument("--lon", type=float, default=2.9)
ap.add_argument("--date", default="2027-01-16T00:00:00Z")  # Солнце +1.6° сбоку, Земля +9.9°, 48%
ap.add_argument("--frames", type=int, default=240)
ap.add_argument("--stills", default="")
ap.add_argument("--out", default="docs/cinematic/landing.mp4")
ap.add_argument("--half-px", type=int, default=400)  # 400 × 80 м = 32 км в каждую сторону
args = ap.parse_args(sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else [])

R = 1737400.0
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"
scene.gravity = (0, 0, -1.62)  # Луна


# ---------- геометрия: система Луны проекта и локальный ENU в точке ----------

def lat_lon_vec(lat, lon):
    a, b = math.radians(lat), math.radians(lon)
    return np.array([math.cos(a) * math.cos(b), math.sin(a), -math.cos(a) * math.sin(b)])


def stereo_xy(lat, lon):
    r = 2 * R * math.tan(math.pi / 4 + math.radians(lat) / 2)
    return r * math.sin(math.radians(lon)), r * math.cos(math.radians(lon))


up = lat_lon_vec(args.lat, args.lon)
east = np.array([up[2], 0.0, -up[0]])
east /= np.linalg.norm(east)
north = np.cross(up, east)


def to_enu(v):
    return np.stack([v @ east, v @ north, v @ up], axis=-1)


# ---------- рельеф LOLA: 20 м вблизи (LDEM_85S_20M), 80 м до горизонта (LDEM_80S_80M) ----------
sx, sy = stereo_xy(args.lat, args.lon)
P0 = None


def dem_grid(path, n_src, center, scale, half_px):
    dem = np.memmap(path, dtype="<i2", mode="r", shape=(n_src, n_src))
    col0, row0 = int(round(center + sx / scale)), int(round(center - sy / scale))
    h = dem[row0 - half_px : row0 + half_px + 1, col0 - half_px : col0 + half_px + 1].astype(np.float64) * 0.5
    cols = np.arange(col0 - half_px, col0 + half_px + 1)
    rows = np.arange(row0 - half_px, row0 + half_px + 1)
    X, Y = np.broadcast_arrays((cols[None, :] - center) * scale, (center - rows[:, None]) * scale)
    rho2 = (X**2 + Y**2) / (4 * R * R)
    kk = 1 / (rho2 + 1)
    U = np.stack([Y / R * kk, (rho2 - 1) * kk, -X / R * kk], axis=-1)
    return h, U * (R + h)[..., None]


def grid_mesh(name, P, hole_half_m=None):
    n = P.shape[0]
    V = to_enu((P - P0).reshape(-1, 3))
    i = np.arange(n - 1)
    a = (i[:, None] * n + i[None, :]).ravel()
    quads = np.stack([a, a + n, a + n + 1, a + 1], axis=-1)
    if hole_half_m:  # вырезаем квадрат под детальным патчем
        c = V[quads].mean(axis=1)
        quads = quads[~((np.abs(c[:, 0]) < hole_half_m) & (np.abs(c[:, 1]) < hole_half_m))]
    mesh = bpy.data.meshes.new(name)
    mesh.vertices.add(n * n)
    mesh.vertices.foreach_set("co", V.astype(np.float32).ravel())
    mesh.loops.add(quads.size)
    mesh.loops.foreach_set("vertex_index", quads.ravel().astype(np.int32))
    mesh.polygons.add(len(quads))
    mesh.polygons.foreach_set("loop_start", (np.arange(len(quads)) * 4).astype(np.int32))
    mesh.polygons.foreach_set("loop_total", np.full(len(quads), 4, np.int32))
    mesh.update()
    mesh.validate()
    mesh.shade_smooth()
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    return obj


h80, P80 = dem_grid(ROOT / "data_raw" / "LDEM_80S_80M.IMG", 7600, 3799.5, 80.0, args.half_px)
fine_path = ROOT / "data_raw" / "LDEM_85S_20M.IMG"
fine = fine_path.exists() and args.lat <= -85.3
if fine:
    h20, P20 = dem_grid(fine_path, 15168, 7583.5, 20.0, 400)  # ±8 км по 20 м
    hc = h20.shape[0] // 2
    h0, P0 = h20[hc, hc], up * (R + h20[hc, hc])
else:
    hc = h80.shape[0] // 2
    h0, P0 = h80[hc, hc], up * (R + h80[hc, hc])
terrain = grid_mesh("LOLA_80m", P80, hole_half_m=7900 if fine else None)
tiles = [terrain]
if fine:
    tiles.append(grid_mesh("LOLA_20m", P20))
print(f"[cine] terrain 80 m {h80.shape[0]}², 20 m patch: {'yes' if fine else 'no'}, site height {h0:.0f} m")
reg = bpy.data.materials.new("Regolith")
reg.use_nodes = True
bs = reg.node_tree.nodes["Principled BSDF"]
bs.inputs["Base Color"].default_value = (0.14, 0.135, 0.128, 1)  # альбедо реголита ~0.12
bs.inputs["Roughness"].default_value = 1.0
for t_obj in tiles:
    t_obj.data.materials.append(reg)
    # сглаживание между точками LOLA (интерполяция, новых форм рельефа не добавляет)
    sub = t_obj.modifiers.new("Smooth", "SUBSURF")
    sub.levels, sub.render_levels = 0, 1
    t_obj.modifiers.new("Collision", "COLLISION")

# ---------- Солнце и Земля на дату (Horizons) ----------
rows_e = json.loads((ROOT / "public" / "data" / "ephem_subpoints.json").read_text(encoding="utf-8"))["rows"]
t = datetime.fromisoformat(args.date.replace("Z", "+00:00")).timestamp() * 1000
ts = np.array([r["t"] for r in rows_e])
j = int(np.clip(np.searchsorted(ts, t), 1, len(ts) - 1))
ra, rb = rows_e[j - 1], rows_e[j]
f = (t - ra["t"]) / (rb["t"] - ra["t"])
lerp = lambda key: ra[key] + (rb[key] - ra[key]) * f
sun = lat_lon_vec(lerp("sunLat"), lerp("sunLon"))
earth_pos = lat_lon_vec(lerp("earthLat"), lerp("earthLon")) * lerp("earthDistKm") * 1000
sun_l = to_enu(sun)
earth_dir = to_enu((earth_pos - P0) / np.linalg.norm(earth_pos - P0))
el = lambda v: math.degrees(math.asin(v[2]))
print(f"[cine] {args.date}: Sun el {el(sun_l):+.2f}°, Earth el {el(earth_dir):+.2f}°")

bpy.ops.object.light_add(type="SUN")
sun_obj = bpy.context.object
sun_obj.data.energy = 11.0
sun_obj.data.angle = math.radians(0.53)  # диск Солнца → мягкий край тени
sun_obj.rotation_euler = Vector(-sun_l).to_track_quat("-Z", "Y").to_euler()

world = bpy.data.worlds.new("Space")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0, 0, 0, 1)
scene.world = world

D_EARTH = 300000.0  # условно 300 км, угловой размер настоящий
earth_r = D_EARTH * math.tan(math.asin(6371e3 / np.linalg.norm(earth_pos - P0)))
bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=earth_r, location=tuple(earth_dir * D_EARTH))
earth = bpy.context.object
earth.name = "Earth"
em = bpy.data.materials.new("Earth")
em.use_nodes = True
tex = em.node_tree.nodes.new("ShaderNodeTexImage")
tex.image = bpy.data.images.load(str(ROOT / "public" / "textures" / "earth_2k.jpg"))
em.node_tree.links.new(tex.outputs["Color"], em.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
earth.data.materials.append(em)
for p in earth.data.polygons:
    p.use_smooth = True


# ---------- аппараты ----------
def import_glb(name):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(ROOT / "public" / "models" / f"{name}.glb"))
    new = [o for o in bpy.data.objects if o not in before]
    return next(o for o in new if o.parent is None), new


lander, _ = import_glb("artemis_lander")
astro, astro_parts = import_glb("astronaut")
flag, _ = import_glb("flag")
astro.location = (6.5, -4.0, 0)
flag.location = (5.0, -7.5, 0)
FPS = 24
scene.render.fps = FPS
F_TOUCH = 120

# спуск: 70 м → 0, торможение к касанию
for fr in range(1, F_TOUCH + 1, 4):
    kk = (fr - 1) / (F_TOUCH - 1)
    lander.location = (0, 0, 70 * (1 - kk) ** 2.2)
    lander.rotation_euler = (0, 0, math.radians(20 * (1 - kk)))
    lander.keyframe_insert("location", frame=fr)
    lander.keyframe_insert("rotation_euler", frame=fr)
lander.location = (0, 0, 0)
lander.keyframe_insert("location", frame=F_TOUCH)

# факел: светящийся конус + оранжевый свет на грунте
bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=0.2, radius2=1.4, depth=6, location=(0, 0, -2.4))
plume = bpy.context.object
plume.parent = lander
pm = bpy.data.materials.new("Plume")
pm.use_nodes = True
nt = pm.node_tree
nt.nodes.clear()
out = nt.nodes.new("ShaderNodeOutputMaterial")
emis = nt.nodes.new("ShaderNodeEmission")
emis.inputs["Color"].default_value = (1.0, 0.62, 0.28, 1)
emis.inputs["Strength"].default_value = 30
tr = nt.nodes.new("ShaderNodeBsdfTransparent")
mix = nt.nodes.new("ShaderNodeMixShader")
mix.inputs[0].default_value = 0.55
nt.links.new(tr.outputs[0], mix.inputs[1])
nt.links.new(emis.outputs[0], mix.inputs[2])
nt.links.new(mix.outputs[0], out.inputs[0])
plume.data.materials.append(pm)
bpy.ops.object.light_add(type="POINT", location=(0, 0, -1.0))
glow = bpy.context.object
glow.parent = lander
glow.data.color = (1.0, 0.6, 0.3)
glow.data.shadow_soft_size = 1.5
for fr, e, vis in ((1, 60000, True), (F_TOUCH - 2, 90000, True), (F_TOUCH + 3, 0, False)):
    glow.data.energy = e
    glow.data.keyframe_insert("energy", frame=fr)
    plume.hide_render = not vis
    plume.keyframe_insert("hide_render", frame=fr)

# пыль: частицы с диска под модулем, баллистика при g = 1.62, гибнут при касании грунта
bpy.ops.mesh.primitive_circle_add(vertices=48, radius=7, fill_type="NGON", location=(0, 0, 0.05))
emitter = bpy.context.object
emitter.name = "DustEmitter"
emitter.hide_render = True
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.35, location=(0, 0, -50))
grain = bpy.context.object
grain.name = "DustGrain"
gm = bpy.data.materials.new("Dust")
gm.use_nodes = True
gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.55, 0.53, 0.5, 1)
grain.data.materials.append(gm)
ps_mod = emitter.modifiers.new("Dust", "PARTICLE_SYSTEM")
ps = ps_mod.particle_system.settings
ps.count = 25000
ps.frame_start, ps.frame_end = F_TOUCH - 55, F_TOUCH + 4
ps.lifetime = 140
ps.normal_factor = 2.5
ps.factor_random = 22.0  # быстрые пологие дуги во все стороны
ps.render_type = "OBJECT"
ps.instance_object = grain
ps.particle_size = 1.0
ps.size_random = 0.7
ps.use_die_on_collision = True if hasattr(ps, "use_die_on_collision") else False
ps.effector_weights.gravity = 1.0
ps.drag_factor = 0.0  # воздуха нет
emitter.particle_systems[0].seed = 7

# астронавт: «лунный галоп» вокруг флага после посадки (ключи по суставам)
joints = {o.name: o for o in astro_parts}
G = 1.62
period = 2 * 0.9 / G
for fr in range(F_TOUCH + 20, args.frames + 1):
    tt = (fr - F_TOUCH - 20) / FPS
    ph = (tt / period) % 1
    air = ph < 0.78
    kk = ph / 0.78 if air else 0
    hop = 0.28 * 4 * kk * (1 - kk) if air else 0
    sw = math.sin(ph * 2 * math.pi)
    ang = 1.2 + tt * 0.11
    astro.location = (5 + math.cos(ang) * 4.5, -6 + math.sin(ang) * 4.5, hop)
    astro.rotation_euler = (0, 0, ang + math.pi)
    astro.keyframe_insert("location", frame=fr)
    astro.keyframe_insert("rotation_euler", frame=fr)
    for name, rot in (("HipL", -0.35 * sw), ("HipR", 0.35 * sw), ("KneeL", 0.25 + max(0, sw) * 0.35), ("KneeR", 0.25 + max(0, -sw) * 0.35),
                      ("ShoulderL", 0.3 * sw), ("ShoulderR", -0.3 * sw), ("Spine", 0.16)):
        o = joints.get(name)
        if o:
            o.rotation_mode = "XYZ"
            o.rotation_euler = (rot, 0, 0)
            o.keyframe_insert("rotation_euler", frame=fr)
def subtree(o):
    out = [o]
    for c in o.children:
        out += subtree(c)
    return out


for o in subtree(astro) + subtree(flag):  # появляются после касания (скрываем каждую часть)
    o.hide_render = True
    o.keyframe_insert("hide_render", frame=1)
    o.hide_render = False
    o.keyframe_insert("hide_render", frame=F_TOUCH + 18)

# ---------- камера: облёт → низкий ракурс; Солнце сбоку, Земля над горизонтом за модулем ----------
bpy.ops.object.empty_add(location=(0, 0, 3))
target = bpy.context.object
bpy.ops.object.camera_add()
cam = bpy.context.object
cam.data.lens = 32
cam.data.clip_end = 1e6
cam.constraints.new("TRACK_TO").target = target
scene.camera = cam
eh = Vector((earth_dir[0], earth_dir[1], 0)).normalized()
side = Vector((-eh.y, eh.x, 0))
keys = [
    (1, -eh * 260 + side * 120 + Vector((0, 0, 110)), Vector((0, 0, 40))),
    (F_TOUCH - 30, -eh * 70 + side * 45 + Vector((0, 0, 14)), Vector((0, 0, 10))),
    (F_TOUCH + 10, -eh * 26 + side * 14 + Vector((0, 0, 2.5)), Vector((0, 0, 3))),
    (args.frames, -eh * 30 + side * 6 + Vector((0, 0, 1.7)), Vector((2, -3, 4))),
]
for fr, pos, tgt in keys:
    cam.location = pos
    target.location = tgt
    cam.keyframe_insert("location", frame=fr)
    target.keyframe_insert("location", frame=fr)

# ---------- рендер ----------
scene.frame_start, scene.frame_end = 1, args.frames
# Cycles на видеокарте (OptiX): чистые края теней на 64 км рельефа; EEVEE даёт «лесенку»
scene.render.engine = "CYCLES"
prefs = bpy.context.preferences.addons["cycles"].preferences
for dev_type in ("OPTIX", "CUDA"):
    try:
        prefs.compute_device_type = dev_type
        prefs.get_devices()
        if any(d.type == dev_type for d in prefs.devices):
            for d in prefs.devices:
                d.use = d.type == dev_type
            scene.cycles.device = "GPU"
            break
    except Exception:
        pass
scene.cycles.samples = 48
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 3
scene.render.resolution_x, scene.render.resolution_y = 1280, 720
scene.view_settings.look = "AgX - Medium High Contrast" if "AgX - Medium High Contrast" in [i.identifier for i in scene.view_settings.bl_rna.properties["look"].enum_items] else scene.view_settings.look
print(f"[cine] engine {scene.render.engine} device {scene.cycles.device}")
out_path = ROOT / args.out
out_path.parent.mkdir(parents=True, exist_ok=True)

if args.stills:
    if hasattr(scene.render.image_settings, "media_type"):
        scene.render.image_settings.media_type = "IMAGE"
    scene.render.image_settings.file_format = "PNG"
    for fr in [int(x) for x in args.stills.split(",")]:
        scene.frame_set(fr)
        scene.render.filepath = str(out_path.parent / f"still_{fr:03d}.png")
        bpy.ops.render.render(write_still=True)
        print(f"[cine] still {fr}")
else:
    if hasattr(scene.render.image_settings, "media_type"):
        scene.render.image_settings.media_type = "VIDEO"
    scene.render.image_settings.file_format = "FFMPEG"
    scene.render.ffmpeg.format = "MPEG4"
    scene.render.ffmpeg.codec = "H264"
    scene.render.ffmpeg.constant_rate_factor = "HIGH"
    scene.render.filepath = str(out_path)
    bpy.ops.render.render(animation=True)
    print(f"[cine] video -> {out_path}")
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / "assets" / "blender" / "cinematic_landing.blend"))
