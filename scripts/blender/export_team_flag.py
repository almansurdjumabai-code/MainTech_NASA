"""Флаг MainTech из командного интро (blender/intro.blend) -> public/models/flag.glb (+ превью).

  blender --background data_raw/team/intro.blend --python-exit-code 1 --python scripts/blender/export_team_flag.py

Оставляем только FlagRoot с потомками (стойка, перекладина, ткань) и его анимацию установки.
"""
import math
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
keep = set()
flag = bpy.data.objects["FlagRoot"]
stack = [flag]
while stack:
    o = stack.pop()
    keep.add(o.name)
    stack.extend(o.children)
for o in list(bpy.data.objects):
    if o.name not in keep and o.type != "LIGHT":
        bpy.data.objects.remove(o, do_unlink=True)

# флаг на уровне грунта в начале координат
flag.location.x = flag.location.y = 0
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
zmin = min((o.matrix_world @ Vector(c)).z for o in meshes for c in o.bound_box)
flag.location.z -= zmin
tris = sum(len(p.vertices) - 2 for o in meshes for p in o.data.polygons)
height = max((o.matrix_world @ Vector(c)).z for o in meshes for c in o.bound_box)
print(f"[flag] objects={sorted(keep)} tris={tris} height={height:.2f}")

out = ROOT / "public" / "models" / "flag.glb"
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=str(out), export_format="GLB", export_yup=True, export_animations=True, export_apply=False)

scene = bpy.context.scene
scene.frame_set(scene.frame_end)
scene.render.engine = "CYCLES"
if hasattr(scene.render.image_settings, "media_type"):  # Blender 5: сначала тип медиа
    scene.render.image_settings.media_type = "IMAGE"
scene.render.image_settings.file_format = "PNG"
scene.cycles.samples = 32
scene.render.resolution_x, scene.render.resolution_y = 900, 700
bpy.ops.object.camera_add(location=(height * 1.6, -height * 1.9, height * 0.7))
cam = bpy.context.object
cam.rotation_euler = (Vector((0, 0, height * 0.6)) - cam.location).to_track_quat("-Z", "Y").to_euler()
scene.camera = cam
if not any(o.type == "LIGHT" for o in bpy.data.objects):
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(70), 0, math.radians(-40)))
scene.render.filepath = str(ROOT / "docs" / "screens" / "model_flag.png")
bpy.ops.render.render(write_still=True)
print(f"[flag] -> {out}")
