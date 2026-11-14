"""Плиты мест посадки Apollo (NASA 3D Resources, раздел 3D Printing) -> GLB + превью.

  blender --background --factory-startup --python-exit-code 1 --python scripts/blender/prep_site_plate.py -- \
      data_raw/nasa3d/apollo14_site.stl public/models/apollo14_site.glb docs/screens/model_apollo14_site.png

Рельеф на плите — данные NASA (а не наша лепка); масштаб печатной модели условный,
поэтому нормируем ширину до 1 м и подписываем как «3D-print relief».
"""
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

src, dst, png = sys.argv[sys.argv.index("--") + 1 :][:3]
MAX_TRIS = 70000

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.stl_import(filepath=str(Path(src).resolve()))
obj = bpy.context.selected_objects[0]
bpy.context.view_layer.objects.active = obj
tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
lo = Vector([min(v.co[i] for v in obj.data.vertices) for i in range(3)])
hi = Vector([max(v.co[i] for v in obj.data.vertices) for i in range(3)])
print(f"[plate] source tris={tris} size={hi - lo}")

if tris > MAX_TRIS:
    mod = obj.modifiers.new("Decimate", "DECIMATE")
    mod.ratio = MAX_TRIS / tris
    bpy.ops.object.modifier_apply(modifier=mod.name)

# нормируем: ширина 1 м, низ плиты на z = 0, центр в начале координат
size = hi - lo
s = 1.0 / max(size.x, size.y)
obj.location = (-(lo.x + hi.x) / 2 * s, -(lo.y + hi.y) / 2 * s, -lo.z * s)
obj.scale = (s, s, s)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for p in obj.data.polygons:
    p.use_smooth = True
obj.name = Path(dst).stem

m = bpy.data.materials.new("Regolith")
m.use_nodes = True
b = m.node_tree.nodes["Principled BSDF"]
b.inputs["Base Color"].default_value = (0.42, 0.41, 0.39, 1)
b.inputs["Roughness"].default_value = 0.95
obj.data.materials.append(m)
print(f"[plate] result tris={sum(len(p.vertices) - 2 for p in obj.data.polygons)}")

bpy.ops.export_scene.gltf(filepath=str(Path(dst).resolve()), export_format="GLB", export_yup=True, export_apply=True)

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 48
scene.render.resolution_x, scene.render.resolution_y = 1200, 800
w = bpy.data.worlds.new("Space")
w.color = (0, 0, 0)
scene.world = w
bpy.ops.object.light_add(type="SUN", rotation=(math.radians(76), 0, math.radians(-60)))  # низкое Солнце — рельеф читается
bpy.context.object.data.energy = 5
bpy.ops.object.camera_add(location=(0.75, -0.95, 0.75))
cam = bpy.context.object
cam.rotation_euler = (Vector((0, 0, 0.02)) - cam.location).to_track_quat("-Z", "Y").to_euler()
scene.camera = cam
scene.render.filepath = str(Path(png).resolve())
bpy.ops.render.render(write_still=True)
print(f"[plate] -> {dst}")
