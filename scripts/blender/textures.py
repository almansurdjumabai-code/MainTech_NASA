"""Процедурные текстуры-картинки для моделей (экспортируются в glTF, в отличие от нод-шума Blender).

Подход как в тестовом проекте «3d models test»: numpy-шум → bpy image → Image Texture.
"""
import bpy
import numpy as np

_rng = np.random.default_rng(11)


def _upsample(a, size):
    h, w = a.shape
    y = np.linspace(0, h - 1, size)
    x = np.linspace(0, w - 1, size)
    y0, x0 = np.floor(y).astype(int), np.floor(x).astype(int)
    y1, x1 = np.minimum(y0 + 1, h - 1), np.minimum(x0 + 1, w - 1)
    fy, fx = (y - y0)[:, None], (x - x0)[None, :]
    return (a[y0][:, x0] * (1 - fx) + a[y0][:, x1] * fx) * (1 - fy) + (a[y1][:, x0] * (1 - fx) + a[y1][:, x1] * fx) * fy


def fbm(size=512, octaves=5, base=4):
    out = np.zeros((size, size))
    amp = 1.0
    for o in range(octaves):
        n = base * 2**o
        out += _upsample(_rng.random((n + 1, n + 1)), size) * amp
        amp *= 0.5
    out -= out.min()
    return out / out.max()


def to_image(name, rgb, non_color=False):
    size = rgb.shape[0]
    img = bpy.data.images.new(name, size, size, alpha=False)
    px = np.concatenate([np.flipud(rgb), np.ones((size, size, 1))], axis=-1).astype(np.float32)
    img.pixels.foreach_set(px.ravel())
    img.pack()
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    return img


def normal_from_height(h, strength=4.0):
    gy, gx = np.gradient(h)
    n = np.stack([-gx * strength, -gy * strength, np.ones_like(h)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def textured_material(name, color_rgb, height, *, metallic=0.0, roughness=0.5, normal_strength=4.0, rough_var=0.0):
    """Материал с картой цвета и нормалей из одной карты высот (обе — картинки, уходят в GLB)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    col = nt.nodes.new("ShaderNodeTexImage")
    col.image = to_image(f"{name}_color", color_rgb)
    nt.links.new(col.outputs["Color"], b.inputs["Base Color"])
    nrm_img = nt.nodes.new("ShaderNodeTexImage")
    nrm_img.image = to_image(f"{name}_normal", normal_from_height(height, normal_strength), non_color=True)
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(nrm_img.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = roughness
    return m


def gold_foil(size=512):
    """Мятая многослойная изоляция (MLI): резкие складки + неровный цвет."""
    h = fbm(size, 6, 6)
    crease = np.abs(np.sin(h * 18.0))  # острые складки
    hh = 0.6 * h + 0.4 * crease
    tint = 0.75 + 0.35 * (fbm(size, 3, 3) - 0.5)
    rgb = np.stack([1.0 * tint, 0.64 * tint, 0.2 * tint], axis=-1).clip(0, 1)
    return textured_material("GoldFoilMLI", rgb, hh, metallic=1.0, roughness=0.3, normal_strength=9.0)


def white_panels(size=512, cells=8):
    """Белая обшивка: тонкие стыки панелей, заклёпки, лёгкая грязь."""
    u = np.linspace(0, cells, size, endpoint=False)
    gu = np.abs((u % 1) - 0.5)
    seam = np.minimum.outer(gu, gu)  # минимум расстояний до стыка по u/v
    lines = (np.minimum(gu[:, None], gu[None, :]) > 0.485).astype(float)
    dirt = fbm(size, 4, 4)
    base = 0.82 - 0.08 * dirt - 0.25 * lines
    rgb = np.stack([base, base * 1.005, base * 1.02], axis=-1).clip(0, 1)
    height = 1.0 - lines * 0.8 + 0.05 * dirt
    return textured_material("WhitePanels", rgb, height, roughness=0.55, normal_strength=3.0)


def orange_foam(size=512):
    """Напыляемая теплоизоляция центральной ступени SLS: оранжевая, пятнистая, с потёками."""
    n = fbm(size, 6, 5)
    streak = _upsample(_rng.random((5, 64)), size)  # вертикальные потёки
    base = 0.8 + 0.25 * (n - 0.5) - 0.12 * streak
    rgb = np.stack([0.86 * base, 0.45 * base, 0.14 * base], axis=-1).clip(0, 1)
    return textured_material("SprayOnFoamTex", rgb, n, roughness=0.8, normal_strength=5.0)


def suit_fabric(size=512):
    """Ткань скафандра: мелкое плетение + складки."""
    u = np.linspace(0, 180 * np.pi, size)  # мелкое плетение, не «стёганое»
    weave = 0.5 + 0.25 * np.sin(u)[:, None] * np.sin(u)[None, :]
    folds = fbm(size, 4, 3)
    base = 0.86 + 0.06 * (weave - 0.5) - 0.06 * folds
    rgb = np.stack([base, base, base * 0.98], axis=-1).clip(0, 1)
    return textured_material("SuitFabricTex", rgb, 0.15 * weave + 0.85 * folds, roughness=0.85, normal_strength=2.5)


def uv_unwrap(objects):
    for o in objects:
        if o.type != "MESH":
            continue
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.02)
        bpy.ops.object.mode_set(mode="OBJECT")


def bevel_all(objects, width=0.015, segments=2):
    """Фаски на рёбрах: блики на гранях делают low-poly «дорогим»."""
    for o in objects:
        if o.type == "MESH" and len(o.data.polygons) < 400:
            mod = o.modifiers.new("Bevel", "BEVEL")
            mod.width = width
            mod.segments = segments
            mod.limit_method = "ANGLE"
