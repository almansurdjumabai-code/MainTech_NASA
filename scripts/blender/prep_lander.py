"""Подготовка внешней модели (NASA 3D Resources / image-to-3D) для three.js.

  blender --background --factory-startup --python-exit-code 1 \
      --python scripts/blender/prep_lander.py -- in.glb out.glb [--height 7.0] [--center] [--max-tris 15000] [--preview out.png]

• масштаб в метрах: --height — итоговая высота модели (если не задана — масштаб как в файле)
• origin: по центру XY и на уровне самых нижних вершин (подошвы опор), с --center — в центре габарита
• decimate, если треугольников больше --max-tris
• экспорт glTF: export_yup=True, трансформации применены
"""
import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

ap = argparse.ArgumentParser()
ap.add_argument("src")
ap.add_argument("dst")
ap.add_argument("--height", type=float)
ap.add_argument("--center", action="store_true")
ap.add_argument("--max-tris", type=int, default=15000)
ap.add_argument("--preview")
args = ap.parse_args(sys.argv[sys.argv.index("--") + 1 :])

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(Path(args.src).resolve()))
meshes = [o for o in bpy.data.objects if o.type == "MESH"]


def bounds():
    pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def tri_count():
    return sum(len(p.vertices) - 2 for o in meshes for p in o.data.polygons)


# корень-пустышка, к которому привязаны все верхние объекты
bpy.ops.object.empty_add(location=(0, 0, 0))
root = bpy.context.object
root.name = Path(args.dst).stem
for o in list(bpy.data.objects):
    if o is not root and o.parent is None:
        o.parent = root

lo, hi = bounds()
size = hi - lo
print(f"[prep] source: tris={tri_count()} size={size.x:.2f}×{size.y:.2f}×{size.z:.2f} (Blender units)")

scale = args.height / size.z if args.height else 1.0
root.scale = (scale, scale, scale)
bpy.context.view_layer.update()
lo, hi = bounds()
center = (lo + hi) / 2
root.location -= Vector((center.x, center.y, center.z if args.center else lo.z))
bpy.context.view_layer.update()

# применяем трансформации ко всей иерархии
bpy.ops.object.select_all(action="SELECT")
bpy.context.view_layer.objects.active = root
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

tris = tri_count()
if tris > args.max_tris:
    ratio = args.max_tris / tris * 0.97
    for o in meshes:
        mod = o.modifiers.new("Decimate", "DECIMATE")
        mod.ratio = ratio
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier=mod.name)
    print(f"[prep] decimated {tris} -> {tri_count()}")

lo, hi = bounds()
print(f"[prep] result: tris={tri_count()} size={(hi - lo).x:.2f}×{(hi - lo).y:.2f}×{(hi - lo).z:.2f} m, zmin={lo.z:.3f}")
Path(args.dst).parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(Path(args.dst).resolve()), export_format="GLB", export_yup=True, export_apply=True)

if args.preview:
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.render.resolution_x, scene.render.resolution_y = 1200, 800
    w = bpy.data.worlds.new("Space")
    w.color = (0, 0, 0)
    scene.world = w
    h = (hi - lo).z
    if not args.center:
        bpy.ops.mesh.primitive_plane_add(size=h * 12, location=(0, 0, 0))
        m = bpy.data.materials.new("Regolith")
        m.use_nodes = True
        m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.17, 0.17, 0.16, 1)
        bpy.context.object.data.materials.append(m)
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(75), 0, math.radians(-55)))
    bpy.context.object.data.energy = 5
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(60), 0, math.radians(140)))
    bpy.context.object.data.energy = 0.5
    d = max((hi - lo).length, 1.0)
    target = Vector((0, 0, (lo.z + hi.z) / 2))
    bpy.ops.object.camera_add(location=target + Vector((1.15 * d, -1.0 * d, 0.45 * d)))
    cam = bpy.context.object
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    scene.render.filepath = str(Path(args.preview).resolve())
    bpy.ops.render.render(write_still=True)
    print(f"[prep] preview -> {args.preview}")
