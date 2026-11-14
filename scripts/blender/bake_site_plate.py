"""Резкая плита места посадки Apollo: детали полной модели NASA запекаются в текстуры лёгкой.

  blender --background --factory-startup --python-exit-code 1 --python scripts/blender/bake_site_plate.py -- \
      data_raw/nasa3d/apollo14_site.stl public/models/apollo14_site.glb docs/screens/model_apollo14_site.png

• high: исходный STL NASA (~139k треугольников) — источник деталей;
• low: та же плита, упрощённая до 25k — то, что уходит в браузер;
• запекание (Cycles GPU) high → low: нормали (мелкие кратеры) и ambient occlusion (затенение рельефа),
  обе карты 2048². Ничего не дорисовываем: всё получено из геометрии NASA.
"""
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

src, dst, png = sys.argv[sys.argv.index("--") + 1 :][:3]
LOW_TRIS = 40000
TEX = 2048
ROOT = Path(dst).resolve().parents[2]
TEX_DIR = ROOT / "assets" / "blender" / "textures"
TEX_DIR.mkdir(parents=True, exist_ok=True)
stem = Path(dst).stem

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
prefs = bpy.context.preferences.addons["cycles"].preferences
for t in ("OPTIX", "CUDA"):
    try:
        prefs.compute_device_type = t
        prefs.get_devices()
        if any(d.type == t for d in prefs.devices):
            for d in prefs.devices:
                d.use = d.type == t
            scene.cycles.device = "GPU"
            break
    except Exception:
        pass

bpy.ops.wm.stl_import(filepath=str(Path(src).resolve()))
high = bpy.context.selected_objects[0]
high.name = "high"
lo = Vector([min(v.co[i] for v in high.data.vertices) for i in range(3)])
hi = Vector([max(v.co[i] for v in high.data.vertices) for i in range(3)])
size = hi - lo
s = 1.0 / max(size.x, size.y)
high.location = (-(lo.x + hi.x) / 2 * s, -(lo.y + hi.y) / 2 * s, -lo.z * s)
high.scale = (s, s, s)
bpy.context.view_layer.objects.active = high
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for p in high.data.polygons:
    p.use_smooth = True

# low: копия, упрощение, UV — проекция сверху (плита почти плоская)
low = high.copy()
low.data = high.data.copy()
low.name = stem
scene.collection.objects.link(low)
tris = sum(len(p.vertices) - 2 for p in low.data.polygons)
mod = low.modifiers.new("Decimate", "DECIMATE")
mod.ratio = LOW_TRIS / tris
bpy.context.view_layer.objects.active = low
bpy.ops.object.modifier_apply(modifier=mod.name)
uv = low.data.uv_layers.new(name="UVMap")
for loop in low.data.loops:
    co = low.data.vertices[loop.vertex_index].co
    uv.data[loop.index].uv = (co.x + 0.5, co.y + 0.5)
print(f"[bake] high {tris} → low {sum(len(p.vertices) - 2 for p in low.data.polygons)} triangles")

# материал low: картинки для запекания
mat = bpy.data.materials.new("Regolith_baked")
mat.use_nodes = True
nt = mat.node_tree
bsdf = nt.nodes["Principled BSDF"]
bsdf.inputs["Roughness"].default_value = 0.95
img_n = bpy.data.images.new(f"{stem}_normal", TEX, TEX, alpha=False)
img_n.colorspace_settings.name = "Non-Color"
img_ao = bpy.data.images.new(f"{stem}_ao", TEX, TEX, alpha=False)
node_n = nt.nodes.new("ShaderNodeTexImage")
node_n.image = img_n
node_ao = nt.nodes.new("ShaderNodeTexImage")
node_ao.image = img_ao
low.data.materials.append(mat)

high.select_set(True)
low.select_set(True)
bpy.context.view_layer.objects.active = low
bake = scene.render.bake
bake.use_selected_to_active = True
bake.cage_extrusion = 0.02
bake.margin = 8
scene.cycles.samples = 64

nt.nodes.active = node_n
bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT")
nt.nodes.active = node_ao
bpy.ops.object.bake(type="AO")
for img in (img_n, img_ao):
    img.filepath_raw = str(TEX_DIR / f"{img.name}.png")
    img.file_format = "PNG"
    img.save()
    img.pack()
print("[bake] normal + AO baked")

# итоговый материал: альбедо реголита × AO, нормали — запечённые
mul = nt.nodes.new("ShaderNodeMix")
mul.data_type = "RGBA"
mul.blend_type = "MULTIPLY"
mul.inputs["Factor"].default_value = 0.6  # AO частично: рельеф читается, но не «грязь»
mul.inputs[6].default_value = (0.62, 0.6, 0.57, 1)
nt.links.new(node_ao.outputs["Color"], mul.inputs[7])
nt.links.new(mul.outputs[2], bsdf.inputs["Base Color"])
nmap = nt.nodes.new("ShaderNodeNormalMap")
nt.links.new(node_n.outputs["Color"], nmap.inputs["Color"])
nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])

bpy.data.objects.remove(high, do_unlink=True)
bpy.ops.object.select_all(action="DESELECT")
low.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(Path(dst).resolve()), export_format="GLB", export_yup=True, use_selection=True, export_image_format="JPEG", export_jpeg_quality=88)
print(f"[bake] -> {dst}")

# превью: низкое Солнце, как при посадке
scene.cycles.samples = 48
scene.render.resolution_x, scene.render.resolution_y = 1200, 800
w = bpy.data.worlds.new("Space")
w.color = (0, 0, 0)
scene.world = w
bpy.ops.object.light_add(type="SUN", rotation=(math.radians(74), 0, math.radians(-60)))
bpy.context.object.data.energy = 6
bpy.ops.object.camera_add(location=(0.8, -1.0, 0.72))
cam = bpy.context.object
cam.rotation_euler = (Vector((0, 0, 0.0)) - cam.location).to_track_quat("-Z", "Y").to_euler()
scene.camera = cam
scene.render.filepath = str(Path(png).resolve())
bpy.ops.render.render(write_still=True)
