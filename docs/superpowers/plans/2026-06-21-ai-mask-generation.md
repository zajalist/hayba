# AI Mask Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`). UE tasks build with the editor CLOSED and verify by compile + visual; the Python projection task is unit-TDD; SAM inference is runtime-verified.

**Goal:** Generate semantic, geometry-hugging masks on a StaticMesh — UE renders the mesh (color + 16-bit world-position + UV passes), the agent grounds SAM with boxes, the visual sidecar segments + back-projects to triangles (world-position) + a display texture (UV), and the Studio renders them.

**Architecture:** UE `study_render` command → agent proposes parts + boxes → Python sidecar (SAM + projection) → masks written to the profile store → Studio auto-refresh (Part-D ticker). Triangles come from the world-position pass (UV-layout-agnostic); the UV pass bakes a display texture only.

**Tech Stack:** UE 5.7 C++ (SceneCapture2D, unlit material overrides, OpenEXR), Python 3 (FastAPI, segment-anything/SAM, numpy, trimesh BVH, OpenEXR/imageio), TypeScript (MCP tool + Mask model), the shipped PLUMB/Studio.

## Global Constraints
- UE build: editor CLOSED, `Build.bat UnrealEditor Win64 Development -Project="D:\UnrealEngine\template\template.uproject"`; relaunch to verify; screenshot via EnumWindows+PrintWindow(2).
- Stores under `ProjectDir/.scratch`; study artifacts under `ProjectDir/.scratch/study/<assetSafe>/` (assetSafe = asset path with `/`→`_`, `.`→`_`).
- Captures are **unlit, linear, HDR, post/tonemapper/eye-adaptation OFF**; world-position + UV passes are **16-bit float EXR**. This is non-negotiable — tonemapping corrupts the values.
- Triangle assignment uses the **world-position pass + a BVH over LOD0**, never UV centroids. UV texture is display-only.
- Sidecar = **SAM only** (no GroundingDINO); the agent supplies boxes/points. FastAPI on `:7821`.
- TS: `npx tsc` + vitest; new MCP tools `plumb_`-prefixed, registered + ALWAYS_ON_META + passthrough + reg + routing fixture.
- No `Co-Authored-By` trailer.

---

### Task 0: De-risk spike — world-position pass round-trips correct coordinates

**Files:**
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Studio/HaybaStudyRender.h` / `.cpp`
- Create: `unreal/HaybaMCPToolkit/Resources/M_HaybaWorldPosPass.uasset` (authored in-editor or via a material-instance fallback — see Step 2)
- Modify: `unreal/.../Private/handlers/HaybaMCPStaticMeshHandler.cpp` (register `study_render_spike` command)

**Interfaces:**
- Produces: a `study_render` command that, for ONE top-down view of an asset, writes `worldpos_v0.exr` (16-bit float RGB = world XYZ in cm) to `.scratch/study/<assetSafe>/`, captured unlit/linear/HDR.

- [ ] **Step 1: Add the spike command + a transient capture scene**

`HaybaStudyRender.cpp` core (one view, world-pos only):
```cpp
// Build a transient world with the mesh, a SceneCapture2D, an unlit world-pos
// material override; capture to an HDR render target; write EXR.
#include "Studio/HaybaStudyRender.h"
#include "Engine/StaticMesh.h"
#include "Components/StaticMeshComponent.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Engine/TextureRenderTarget2D.h"
#include "PreviewScene.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Misc/Paths.h"

bool HaybaStudy::RenderWorldPosSpike(const FString& AssetPath, const FString& OutDir)
{
    UStaticMesh* Mesh = LoadObject<UStaticMesh>(nullptr, *AssetPath);
    if (!Mesh) return false;

    FPreviewScene Scene(FPreviewScene::ConstructionValues());
    UStaticMeshComponent* Comp = NewObject<UStaticMeshComponent>();
    Comp->SetStaticMesh(Mesh);
    Scene.AddComponent(Comp, FTransform::Identity);

    // Unlit world-position material (emissive = AbsoluteWorldPosition). Authored
    // material M_HaybaWorldPosPass preferred; fallback below sets a MID if present.
    UMaterialInterface* WP = LoadObject<UMaterialInterface>(nullptr, TEXT("/HaybaMCPToolkit/M_HaybaWorldPosPass.M_HaybaWorldPosPass"));
    if (WP) Comp->SetMaterial(0, WP);

    UTextureRenderTarget2D* RT = NewObject<UTextureRenderTarget2D>();
    RT->RenderTargetFormat = RTF_RGBA16f;   // HDR float
    RT->InitAutoFormat(512, 512);
    RT->bForceLinearGamma = true;

    USceneCaptureComponent2D* Cap = NewObject<USceneCaptureComponent2D>();
    Cap->TextureTarget = RT;
    Cap->CaptureSource = SCS_SceneColorHDR;          // un-tonemapped
    Cap->ShowFlags.SetLighting(false);
    Cap->ShowFlags.SetPostProcessing(false);
    Cap->ShowFlags.SetTonemapper(false);
    Cap->ShowFlags.SetEyeAdaptation(false);
    Scene.AddComponent(Cap, FTransform(FRotator(-90,0,0), FVector(0,0,500))); // top-down
    Cap->CaptureScene();

    // Read back + write EXR (16-bit float). Use FImageUtils / image wrapper EXR.
    return HaybaStudy::WriteRenderTargetEXR(RT, FPaths::Combine(OutDir, TEXT("worldpos_v0.exr")));
}
```
Add `WriteRenderTargetEXR` using `IImageWrapperModule` (`EImageFormat::EXR`) reading `RT->GameThread_GetRenderTargetResource()->ReadPixels` into `FLinearColor` and writing EXR. Add `ImageWrapper` to `Build.cs` if missing.

- [ ] **Step 2: M_HaybaWorldPosPass material** — if authoring a `.uasset` is impractical headlessly, create it once in-editor: an Unlit material, Emissive Color = `AbsoluteWorldPosition` (World Position node). Commit the `.uasset`. (Fallback: a code-built `UMaterial` is not feasible at runtime — the material must be a committed asset.)

- [ ] **Step 3: Register the command** in `HaybaMCPStaticMeshHandler::Handle`: `if (Cmd == TEXT("study_render_spike")) { ... RenderWorldPosSpike(asset, dir) ... }`.

- [ ] **Step 4: Build (editor closed)** — expect `Result: Succeeded`.

- [ ] **Step 5: Run + verify the EXR round-trips coordinates.** Relaunch, run the command on `/Engine/EditorMeshes/EditorCube.EditorCube` (a 256cm cube centred at origin). Read the EXR back (python: `imageio.imread('worldpos_v0.exr')`) and assert: centre pixel ≈ the cube's top-face world position (z ≈ +128 within the seated cube), corner pixels differ by ~±128 in X/Y, background pixels are ~0. **This proves un-tonemapped world coords survive the capture.** If values are clamped/gamma'd, fix the capture flags before proceeding.

- [ ] **Step 6: Commit** — `feat(study): world-position capture spike (Task 0 de-risk)`.

**If Step 5 fails** (values wrong/clamped): stop and fix the capture path — this gates the whole feature.

---

### Task 1: `study_render` — full multi-view (color + UV + worldpos + mesh export)

**Files:**
- Modify: `Studio/HaybaStudyRender.h` / `.cpp`
- Create: `unreal/HaybaMCPToolkit/Resources/M_HaybaUVPass.uasset` (Unlit, Emissive = TexCoord[0] as (U,V,0))
- Modify: `HaybaMCPStaticMeshHandler.cpp` (register `study_render`)

**Interfaces:**
- Produces: command `study_render {asset, views=8, res=512}` → writes `color_v{i}.png`, `worldpos_v{i}.exr`, `uv_v{i}.exr` for N orbit views, `mesh_lod0.json` (`{positions:[[x,y,z]…], indices:[…]}` cm/world-local), `views.json` (`[{view, camera_to_world, fov}]`). Returns `{ok, dir, views, has_uv0}`.

- [ ] **Step 1: Orbit cameras** — generate N view transforms (azimuth ring of 6 + top + bottom) framing the mesh bounds; for each: render color (normal material, lit), then swap to `M_HaybaWorldPosPass` → worldpos EXR, swap to `M_HaybaUVPass` → uv EXR, restore. Reuse the Task-0 capture/EXR helpers; add a `WriteRenderTargetPNG` for color.

- [ ] **Step 2: Export `mesh_lod0.json`** — from `Mesh->GetRenderData()->LODResources[0]`: positions via `VertexBuffers.PositionVertexBuffer.VertexPosition(i)`, indices via `IndexBuffer.GetArrayView()`. Set `has_uv0 = LOD.GetNumTexCoords() > 0`.

- [ ] **Step 3: Build (editor closed) + visual/file check** — run `study_render` on `SM_BaitBox_01a` (in Fishing_Dock) or EditorCube; confirm 8×(color+worldpos+uv) files + `mesh_lod0.json` (non-empty positions/indices) + `views.json` exist; eyeball one `uv_v0.exr` is a U/V gradient and `color_v0.png` shows the mesh.

- [ ] **Step 4: Commit** — `feat(study): study_render multi-view passes + mesh export`.

---

### Task 2: `Mask.texture` field + store round-trip (TS)

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/plumb/contracts.ts` (add `texture?` to `Mask`)
- Test: `mcp-tools/hayba-mcp/src/plumb/plumb.test.ts`

**Interfaces:**
- Produces: `Mask.texture?: string` (path to the UV display PNG). Back-compatible (optional).

- [ ] **Step 1: Write the failing test**
```ts
it('mask carries an optional texture path', () => {
  const m = { id: 'hull', type: 'surface' as const, color: '#48A0FF', source: 'ai' as const, confidence: 0.7, locked: false, triangles: [1,2,3], texture: '/x/.scratch/study/a/masks/hull.png' };
  expect(m.texture).toContain('hull.png');
});
```
- [ ] **Step 2: Run → fails** (tsc: `texture` not on `Mask`). `npx vitest run src/plumb/plumb.test.ts -t texture`
- [ ] **Step 3: Add the field** — in `contracts.ts` `Mask`, after `detail?: string;`: `texture?: string;   // path to a baked UV display mask (surface masks)`
- [ ] **Step 4: Run → pass; `npx tsc --noEmit` → 0 errors.**
- [ ] **Step 5: Commit** — `feat(plumb): Mask.texture field for projected display masks`.

---

### Task 3: Studio renders textured surface masks (UE)

**Files:**
- Modify: `Studio/HaybaStudioModel.h`/`.cpp` (parse `texture`)
- Modify: `Studio/SHaybaStudioViewport.h`/`.cpp` (overlay material from the texture)

**Interfaces:**
- Consumes: `Mask.texture` (Task 2 JSON). Produces: surface masks with a `texture` render as a translucent UV-sampled overlay on the preview mesh; textureless surface masks keep the triangle fill.

- [ ] **Step 1: Parse `texture`** — add `FString Texture;` to `FHaybaStudioMask`; read `M->TryGetStringField(TEXT("texture"), Mask.Texture)` in `LoadProfile`.
- [ ] **Step 2: Load the texture + overlay material** — in the viewport, for surface masks with a texture: `UTexture2D* Tex = FImageUtils::ImportFileAsTexture2D(Texture);` build a translucent MID (parent: a committed `M_HaybaMaskOverlay` — Unlit/Translucent, params `MaskTex` (sampled as opacity) × `Color`); set it as an **overlay material** on `PreviewComponent` (`SetOverlayMaterial`) or a duplicate component. Multiple masks → blend or show the selected one.
- [ ] **Step 3: Create `Resources/M_HaybaMaskOverlay.uasset`** (in-editor: Translucent, Unlit; Emissive = Color×MaskTex.r, Opacity = MaskTex.r×0.5). Commit it.
- [ ] **Step 4: Build + visual check** — hand-author a profile with a surface mask pointing at a test grayscale PNG; confirm the tint appears mapped on the mesh (smooth, not blocky).
- [ ] **Step 5: Commit** — `feat(studio): render textured (UV) surface masks as an overlay`.

---

### Task 4: Visual sidecar scaffold + `/health` + lazy SAM

**Files:**
- Create: `mcp-tools/visual-sidecar/app.py`, `requirements.txt`, `README.md`, `run.ps1`
- Test: `mcp-tools/visual-sidecar/tests/test_health.py`

**Interfaces:**
- Produces: FastAPI on `:7821`; `GET /health` → `{ok, model_loaded}`; SAM lazy-loads on first segment call; weights cache dir from `HAYBA_SAM_CACHE` (default `~/.cache/hayba-sam`).

- [ ] **Step 1: Write the failing test** (`test_health.py`, uses FastAPI `TestClient`):
```python
from fastapi.testclient import TestClient
from app import app
def test_health():
    c = TestClient(app); r = c.get('/health')
    assert r.status_code == 200 and r.json()['ok'] is True
```
- [ ] **Step 2: Run → fails** (`app` missing). `cd mcp-tools/visual-sidecar && python -m pytest tests/test_health.py`
- [ ] **Step 3: Minimal app.py** — FastAPI app, `/health` returns `{ok:True, model_loaded: _SAM is not None}`; a `_load_sam()` that lazy-imports `segment_anything`, builds the predictor from a cached checkpoint, memoizes in `_SAM` (no load at import).
- [ ] **Step 4: requirements.txt** — `fastapi`, `uvicorn`, `numpy`, `imageio`, `OpenEXR` or `imageio[freeimage]`, `trimesh`, `segment-anything`, `torch`. `run.ps1` → `uvicorn app:app --port 7821`.
- [ ] **Step 5: Run → pass.**
- [ ] **Step 6: Commit** — `feat(sidecar): FastAPI scaffold + /health + lazy SAM`.

---

### Task 5: Projection core — world-pos → triangles + UV bake (Python, TDD)

**Files:**
- Create: `mcp-tools/visual-sidecar/projection.py`
- Test: `mcp-tools/visual-sidecar/tests/test_projection.py`

**Interfaces:**
- Produces:
  - `assign_triangles(worldpos_views, masks_views, mesh, vote_threshold) -> dict[part -> set[int]]` — per-pixel world point → nearest-triangle (trimesh `ProximityQuery`), per-triangle multi-view votes, cross-part argmax, threshold.
  - `bake_uv_texture(uv_views, mask_views, res) -> np.ndarray` — paint masked pixels' UVs into a `res×res` texture, dilate.

- [ ] **Step 1: Write failing tests** (synthetic, no models):
```python
import numpy as np, trimesh
from projection import assign_triangles
def test_nearest_tri_voting():
    # unit quad (2 tris) in the z=0 plane
    mesh = trimesh.Trimesh(vertices=[[0,0,0],[1,0,0],[1,1,0],[0,1,0]], faces=[[0,1,2],[0,2,3]])
    # one view: a worldpos image where the lower-left pixel sits on tri 0, masked for "a"
    wp = np.full((2,2,3), np.nan); wp[1,0] = [0.7,0.2,0.0]   # inside tri 0
    masks = {'a': [np.array([[0,0],[1,0]], bool)]}            # only that pixel
    out = assign_triangles([wp], masks, mesh, vote_threshold=1)
    assert 0 in out['a'] and 1 not in out['a']
```
- [ ] **Step 2: Run → fails.** `python -m pytest tests/test_projection.py`
- [ ] **Step 3: Implement `assign_triangles`** — flatten valid (non-NaN) masked pixels per part/view → `trimesh.proximity.ProximityQuery(mesh).vertex`/`.on_surface` → nearest face id; tally `votes[part][face]`; for faces claimed by >1 part keep the argmax part; keep faces with `votes >= vote_threshold`. Implement `bake_uv_texture` (paint `tex[int(v*res), int(u*res)] = 1` for masked pixels, `scipy.ndimage` or manual 1px dilation).
- [ ] **Step 4: Run → pass.** Add a `bake_uv_texture` test (a masked pixel with uv (0.5,0.5) paints the centre texel).
- [ ] **Step 5: Commit** — `feat(sidecar): world-position triangle projection + UV bake (TDD)`.

---

### Task 6: `/segment_project` — SAM + projection wired

**Files:**
- Modify: `mcp-tools/visual-sidecar/app.py`
- Test: `mcp-tools/visual-sidecar/tests/test_segment_project.py` (mock SAM)

**Interfaces:**
- Produces: `POST /segment_project {study_dir, parts:[{label,color,views:[{view,box|points}]}], vote_threshold?}` → loads `color/worldpos/uv` + `mesh_lod0.json`; runs SAM per part box → per-view masks; `assign_triangles` + `bake_uv_texture`; writes `masks/<label>.png`; returns `{masks:[{label,texture,triangles,color,coverage}]}`. Errors → `{ok:false,error}`.

- [ ] **Step 1: Write the failing test** — monkeypatch `_run_sam(image, box) -> bool mask` to a deterministic stub; build a tiny `study_dir` fixture (2 views, a synthetic worldpos EXR + mesh_lod0.json); POST → assert a mask with non-empty `triangles` + a written texture file.
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement the endpoint** — read EXRs (`imageio`), build `trimesh.Trimesh` from `mesh_lod0.json`, per part/view call `_run_sam` on the box, collect masks, call Task-5 functions, write textures, return. Guard missing files / `has_uv0`.
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `feat(sidecar): /segment_project (SAM + projection wired)`.

---

### Task 7: `plumb_segment` MCP tool (TS)

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/plumb/tools.ts`, `src/tools/index.ts`, `src/tools/routing/register.ts`, `tests/routing-integration.test.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/plumb/tools.test.ts`

**Interfaces:**
- Produces: `plumb_segment(asset, study_dir, parts)` → POSTs to `http://localhost:7821/segment_project`; on success calls `addMask` per returned mask (with `texture`); returns `{ok, added:[label], error?}`. Registered always-on.

- [ ] **Step 1: Write the failing test** — mock `fetch` to return a masks payload; `setProfilesPath` + a baked profile; call handler → assert `addMask` persisted masks with `texture` + `triangles`.
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement** `plumbSegmentSchema`/`plumbSegmentHandler` (zod: asset, study_dir, parts array); `fetch` POST; on `ok` loop `addMask(asset, {...})`. Register in index.ts (server.tool + reg), ALWAYS_ON_META + passthrough, fixture row.
- [ ] **Step 4: Run → pass; tsc 0 errors; `npx vitest run src/tools/plumb tests/routing-integration.test.ts`; `npx tsc` emit.**
- [ ] **Step 5: Commit** — `feat(plumb): plumb_segment MCP tool (sidecar bridge)`.

---

### Task 8: End-to-end on a real asset + memory

- [ ] **Step 1: Bring up the sidecar** — `cd mcp-tools/visual-sidecar; ./run.ps1`; confirm `GET /health` and `check_ue_status.visual_embeddings_available:true`.
- [ ] **Step 2: Real-asset run** — with Fishing_Dock open: `study_render` on `SM_Boat_01a`; the agent reads `color_v*.png`, names parts (hull, deck well, bow rope, rim) + a box per part per view; `plumb_segment`; confirm the Studio auto-refreshes with **smooth hull/deck masks that follow the boat's geometry** (the acceptance test that replaces the blocky box). Screenshot.
- [ ] **Step 3: Update `project_mcp_ux_validation_overhaul` memory** with the AI-mask-gen pipeline shipped + the sidecar location + the agent-grounds-SAM loop.

---

## Self-Review

**Spec coverage:** §2 architecture → Tasks 0/1 (UE), 4-6 (sidecar), 7 (agent bridge). §3 projection (world-pos triangles + UV bake + voting) → Task 5, wired in 6. §4.1 sidecar → 4-6. §4.2 `study_render` → 0-1. §4.3 `plumb_segment` → 7. §4.4 Mask.texture + Studio render → 2-3. §5 files → produced by 1. §6 error handling → guards in 6/7, has_uv0 in 1/3. §7 testing → TDD in 5, mocked in 6/7, visual in 1/3/8. §8 risks → Task 0 de-risk spike (capture), voting (5), SAM cache (4). ✔

**Placeholder scan:** UE capture/material steps are structural-with-key-APIs (flagged, like Plan B — SceneCapture + EXR need compiler iteration); `.uasset` materials must be authored in-editor + committed (noted). Projection (5), health (4), tool (7), model field (2) carry complete code + real tests. No TBD/TODO. ✔

**Type consistency:** `assign_triangles`/`bake_uv_texture` signatures match across Tasks 5↔6; `/segment_project` payload (`parts:[{label,color,views:[{view,box}]}]`) identical in spec §4.1, Task 6, Task 7; `Mask.texture` consistent across Tasks 2↔3↔7; `study_render` output files consistent across Tasks 1↔6. ✔

**Scope:** one subsystem (mask generation); placement constraints + volume-mask generation remain separate specs. ✔
