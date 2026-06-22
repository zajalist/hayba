"""study_render — UE-side multi-view capture for AI mask generation.

Runs INSIDE the editor (via the MCP `python_run`). For a StaticMesh it renders
N orbit views, each producing:
  - color_v{i}.png    lit render (agent grounding + SAM input)
  - worldpos_v{i}.exr 16-bit float world XYZ per pixel (triangle back-projection)
  - uv_v{i}.exr       16-bit float TexCoord0 per pixel (display-texture bake)
plus once:
  - mesh_lod0.json    {positions, indices} in LOCAL space (== world; mesh spawned at identity)
  - views.json        per-view camera params

Key correctness detail (see project_ai_mask_task0_findings): UE bakes a global
scene *pre-exposure* into SCS_SceneColorHDR that Python overrides cannot remove.
We measure it per view from a constant-1.0 calibration frame and divide it out by
setting a `PreExpInv = 1/k` scalar on the unlit worldpos/uv materials, so the
exported EXRs hold TRUE world/UV values.

Usage (from python_run):
    exec(open(r'.../study_render.py').read())
    print(study_render('/Game/Fishing_Dock/Meshes/SM_Boat_01a', views=8, res=512,
                       out_root=r'D:/UnrealEngine/template/.scratch/study'))
"""
import unreal
import os
import math
import json

PASS_DIR = "/Game/HaybaPasses"


def _ensure_materials():
    at = unreal.AssetToolsHelpers.get_asset_tools()
    EAL = unreal.EditorAssetLibrary
    MEL = unreal.MaterialEditingLibrary

    def make(name, build):
        path = f"{PASS_DIR}/{name}"
        if EAL.does_asset_exist(path):
            return unreal.load_asset(path)
        m = at.create_asset(name, PASS_DIR, unreal.Material, unreal.MaterialFactoryNew())
        m.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
        build(m, MEL)
        MEL.recompile_material(m)
        EAL.save_asset(m.get_path_name())
        return m

    def build_const(m, MEL):
        c = MEL.create_material_expression(m, unreal.MaterialExpressionConstant, -300, 0)
        c.set_editor_property("r", 1.0)
        MEL.connect_material_property(c, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)

    def _scaled(m, MEL, src):
        p = MEL.create_material_expression(m, unreal.MaterialExpressionScalarParameter, -600, 250)
        p.set_editor_property("parameter_name", "PreExpInv")
        p.set_editor_property("default_value", 1.0)
        mul = MEL.create_material_expression(m, unreal.MaterialExpressionMultiply, -300, 0)
        MEL.connect_material_expressions(src, "", mul, "A")
        MEL.connect_material_expressions(p, "", mul, "B")
        MEL.connect_material_property(mul, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)

    def build_wp(m, MEL):
        wp = MEL.create_material_expression(m, unreal.MaterialExpressionWorldPosition, -600, 0)
        _scaled(m, MEL, wp)

    def build_uv(m, MEL):
        uv = MEL.create_material_expression(m, unreal.MaterialExpressionTextureCoordinate, -600, 0)
        _scaled(m, MEL, uv)

    return (
        make("M_HaybaConst", build_const),
        make("M_HaybaWorldPos", build_wp),
        make("M_HaybaUV", build_uv),
    )


def _orbit_views(center, radius, n_ring=6):
    """6 azimuth views (slightly raised) + top + bottom, looking at the center."""
    out = []
    for i in range(n_ring):
        az = 2.0 * math.pi * i / n_ring
        pos = unreal.Vector(center.x + radius * math.cos(az),
                            center.y + radius * math.sin(az),
                            center.z + radius * 0.35)
        out.append(pos)
    out.append(unreal.Vector(center.x, center.y, center.z + radius))   # top
    out.append(unreal.Vector(center.x, center.y, center.z - radius))   # bottom
    return out


def _export_mesh_json(mesh, path):
    positions, indices = [], []
    lod = 0
    n_sec = unreal.ProceduralMeshLibrary.get_static_mesh_section_count(mesh, lod) \
        if hasattr(unreal.ProceduralMeshLibrary, "get_static_mesh_section_count") else 8
    base = 0
    has_uv = False
    for s in range(n_sec):
        try:
            verts, tris, normals, uvs, tangents = \
                unreal.ProceduralMeshLibrary.get_section_from_static_mesh(mesh, lod, s)
        except Exception:
            break
        if not verts:
            continue
        if uvs:
            has_uv = True
        for v in verts:
            positions.append([v.x, v.y, v.z])
        for t in tris:
            indices.append(base + int(t))
        base += len(verts)
    with open(path, "w") as f:
        json.dump({"positions": positions, "indices": indices}, f)
    return len(positions), len(indices) // 3, has_uv


def study_render(asset, views=8, res=512, out_root=None):
    ues = unreal.UnrealEditorSubsystem()
    world = ues.get_editor_world()
    eas = unreal.EditorActorSubsystem()
    RL = unreal.RenderingLibrary
    ML = unreal.MathLibrary

    mesh = unreal.load_object(None, asset)
    if mesh is None:
        return {"ok": False, "error": f"could not load StaticMesh {asset}"}

    safe = asset.replace("/", "_").replace(".", "_").strip("_")
    out_root = out_root or os.path.join(unreal.Paths.project_dir(), ".scratch", "study")
    out_dir = os.path.join(out_root, safe)
    os.makedirs(os.path.join(out_dir, "masks"), exist_ok=True)

    mat_const, mat_wp, mat_uv = _ensure_materials()

    spawned = []
    try:
        cube = eas.spawn_actor_from_class(unreal.StaticMeshActor, unreal.Vector(0, 0, 0))
        cube.set_actor_label("HaybaStudyMesh")
        spawned.append(cube)
        smc = cube.static_mesh_component
        smc.set_static_mesh(mesh)
        b = cube.get_actor_bounds(False)
        center, ext = b[0], b[1]
        radius = max(ext.x, ext.y, ext.z) * 3.0

        nverts, ntris, has_uv = _export_mesh_json(mesh, os.path.join(out_dir, "mesh_lod0.json"))

        rt_c = RL.create_render_target2d(world, res, res, unreal.TextureRenderTargetFormat.RTF_RGBA8)
        rt_f = RL.create_render_target2d(world, res, res, unreal.TextureRenderTargetFormat.RTF_RGBA16F)

        cap = eas.spawn_actor_from_class(unreal.SceneCapture2D, unreal.Vector(0, 0, 0))
        cap.set_actor_label("HaybaStudyCap")
        spawned.append(cap)
        c = cap.capture_component2d
        c.set_editor_property("capture_every_frame", False)
        c.set_editor_property("capture_on_movement", False)
        c.set_editor_property("primitive_render_mode",
                              unreal.SceneCapturePrimitiveRenderMode.PRM_USE_SHOW_ONLY_LIST)
        c.clear_show_only_components()
        c.show_only_actor_components(cube)
        c.set_editor_property("fov_angle", 50.0)
        # Per-pass show flags: the worldpos/uv passes need a clean black
        # background (RGB~=0 sentinel; SceneColorHDR alpha is unreliable), so
        # atmosphere/fog/skylight are disabled for them. The grounding (color)
        # pass keeps lighting + auto-exposure so the agent/SAM see a bright mesh.
        FLAGS_RAW = [
            unreal.EngineShowFlagsSetting(show_flag_name="Atmosphere", enabled=False),
            unreal.EngineShowFlagsSetting(show_flag_name="Fog", enabled=False),
            unreal.EngineShowFlagsSetting(show_flag_name="VolumetricFog", enabled=False),
        ]

        wp_mid = smc.create_dynamic_material_instance(0, mat_wp)
        uv_mid = smc.create_dynamic_material_instance(0, mat_uv)

        view_positions = _orbit_views(center, radius)[:views]
        views_meta = []

        for i, pos in enumerate(view_positions):
            rot = ML.find_look_at_rotation(pos, center)
            cap.set_actor_location_and_rotation(pos, rot, False, False)
            views_meta.append({"view": i, "pos": [pos.x, pos.y, pos.z],
                               "rot": [rot.roll, rot.pitch, rot.yaw], "fov": 50.0})

            # 1) grounding image — lit LDR with lighting + auto-exposure ON so the
            # mesh is bright/legible for the agent + SAM.
            smc.set_material(0, mesh.get_material(0) or unreal.load_object(None, "/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"))
            c.set_editor_property("show_flag_settings", [])
            c.set_editor_property("texture_target", rt_c)
            c.set_editor_property("capture_source", unreal.SceneCaptureSource.SCS_FINAL_COLOR_LDR)
            c.capture_scene(); c.capture_scene()
            RL.export_render_target(world, rt_c, out_dir, f"color_v{i}.png")
            # raw passes need the clean black background
            c.set_editor_property("show_flag_settings", FLAGS_RAW)

            # 2) calibration — measure the scene pre-exposure k on an object pixel
            smc.set_material(0, mat_const)
            c.set_editor_property("texture_target", rt_f)
            c.set_editor_property("capture_source", unreal.SceneCaptureSource.SCS_SCENE_COLOR_HDR)
            c.capture_scene(); c.capture_scene()
            k = 0.0
            for (sx, sy) in [(res // 2, res // 2), (res // 2, res // 3), (res // 3, res // 2),
                             (2 * res // 3, res // 2), (res // 2, 2 * res // 3)]:
                px = RL.read_render_target_raw_pixel(world, rt_f, sx, sy)
                k = max(k, px.r)
            if k <= 1e-4:
                k = 1.0  # object not centred under the probes; assume no scaling
            inv = 1.0 / k

            # 3) worldpos — unlit, /k baked in → EXR holds true world XYZ
            wp_mid.set_scalar_parameter_value("PreExpInv", inv)
            smc.set_material(0, wp_mid)
            c.capture_scene(); c.capture_scene()
            RL.export_render_target(world, rt_f, out_dir, f"worldpos_v{i}.exr")

            # 4) uv — unlit, /k baked in
            if has_uv:
                uv_mid.set_scalar_parameter_value("PreExpInv", inv)
                smc.set_material(0, uv_mid)
                c.capture_scene(); c.capture_scene()
                RL.export_render_target(world, rt_f, out_dir, f"uv_v{i}.exr")

        with open(os.path.join(out_dir, "views.json"), "w") as f:
            json.dump(views_meta, f)

        return {"ok": True, "dir": out_dir.replace("\\", "/"), "views": len(view_positions),
                "has_uv0": has_uv, "verts": nverts, "tris": ntris}
    finally:
        for a in spawned:
            try:
                eas.destroy_actor(a)
            except Exception:
                pass
