# AI Mask Generation — design

**Date:** 2026-06-21
**Status:** design (approved direction; pending written-spec review)
**Builds on:** the shipped PLUMB/Semantic-Studio system (`feat/mcp-ux-validation-overhaul`) — profiles, masks, the Studio, the Part-D study loop.

## 1. Purpose

Replace hand-placed placeholder masks with **AI-generated semantic masks that hug the real geometry**: the agent looks at a mesh, names its parts along the pack theme ("rowboat → hull, deck well, bow rope, oarlocks, rim"), and a segmentation model projects those parts onto the asset as **UV-texture masks** (smooth, sub-triangle), each with a derived triangle set for the constraint evaluator.

Out of scope (separate follow-up spec): rich inter-asset placement constraints (the "lifering at the bow, on the ground, leaning on the hull" recipes). This spec is the mask-generation pipeline only — masks are the foundation those constraints will reason over.

## 2. Architecture — three actors

- **UE plugin** — the only actor that can see the geometry. Renders the mesh from N orbit views; each view produces a **color** pass, a **16-bit UV pass** (per-pixel surface UV), and a **world-position pass** (per-pixel 3D point). All captured **unlit, linear, HDR, post-processing off** so the UV/world values aren't tonemapped. Exports the LOD0 mesh (positions + index buffer) for triangle assignment.
- **Agent (Claude via MCP)** — the VLM *and the grounder*. Reads the color renders, proposes themed part labels per asset, **and a rough box (or point) per part per view**. No GroundingDINO — the agent localizes; SAM masks. The agent's own vision is both the semantic understanding and the localization.
- **Visual sidecar** (`localhost:7821`, currently down) — Python/FastAPI holding **SAM only**. Given the renders + the agent's boxes, SAM produces per-part masks; the sidecar **projects** them — triangles via the world-position pass (3D-correct, disambiguates mirrored UVs), and a display texture via the UV pass — returning triangle-backed (and texture-backed) masks.

Flow: **UE renders → agent proposes parts + boxes → SAM masks → world-position projection → profile gets masks → Studio auto-refreshes** (reusing the Part-D poll ticker).

> **Design revision (post-QA):** dropped GroundingDINO (weak on game-prop vocab; the agent grounds SAM instead — more reliable + one fewer heavy model); triangle assignment is by **world position**, not UV-centroid (mirrored/overlapping UVs would otherwise bleed masks onto symmetric halves); the UV pass is **16-bit** and captured **unlit/linear** (8-bit + tonemapping would quantize/corrupt it). The UV texture is **display-only**; the triangle set is the functional output.

## 3. The projection method (world-position primary, UV texture for display)

Triangle assignment is done in **3D** (correct under any UV layout); the UV pass only bakes the display texture.

1. **Render** (per view, unlit/linear/HDR, post off):
   - `color_v{i}.png` — lit, for the agent + SAM.
   - `worldpos_v{i}.exr` — 16-bit float, RGB = the surface point's world XYZ (cm). Background = a sentinel (alpha 0 / NaN).
   - `uv_v{i}.exr` — 16-bit, RG = `TexCoord0` (display bake only).
   Export `mesh_lod0.json` once — positions + index buffer (for the triangle BVH).
2. **Ground + segment**: the agent returns `{label, box}` (or points) per part per view from the color render; SAM masks that box → a binary mask per part per view.
3. **Project (sidecar):**
   - **Triangles (functional):** for each masked pixel, read `worldpos_v{i}[x,y]` → 3D point P → nearest triangle via a BVH over `mesh_lod0.json`. Accumulate per-part **per-triangle vote counts** across views; a triangle is "in" iff its vote count ≥ a threshold (multi-view majority — rejects single-view false positives and resolves cross-part conflicts by argmax part).
   - **Display texture:** for each masked pixel, read `uv_v{i}[x,y]` → paint the part's 16-bit UV texture; small UV-space dilation to close seams.
4. **Store**: each part → a profile mask `{ id:label, type:'surface', texture:'masks/<label>.png', triangles:[…], color, source:'ai', confidence:coverage }`.

Triangle assignment by world position means **mirrored/overlapping UVs no longer bleed** the mask onto symmetric halves (the boat's lifering stays on its real side). Segmentation produces **surface part masks**; volume masks (clearance regions in empty space) remain separately authored.

## 4. Components & interfaces

### 4.1 Visual sidecar — `mcp-tools/visual-sidecar/`
- Python/FastAPI on `:7821`. Model: **SAM only** (HF weights, downloaded + cached on first run; lazy-loaded). No GroundingDINO.
- `GET /health` → `{ ok, model_loaded }`; flips `check_ue_status.visual_embeddings_available` true.
- `POST /segment_project` — `{ study_dir, parts:[{label,color, views:[{view:int, box:[x0,y0,x1,y1] | points:[[x,y,label]]}]}], vote_threshold? }`. Reads `color_v*`, `worldpos_v*.exr`, `uv_v*.exr`, `mesh_lod0.json`; per part runs SAM on each provided box/point set, projects to triangles via the world-position BVH (per-triangle multi-view voting, cross-part argmax), and paints `masks/<label>.png` (16-bit UV display texture). Returns `{ masks:[{label,texture,triangles,color,coverage}] }`. Errors return `{ ok:false, error }` (never throws).
- Builds the triangle BVH once per `mesh_lod0.json` (cached by file hash).
- Startup script + README; model weights cached under a configurable dir.

### 4.2 UE command — `study_render` (new handler, non-destructive)
- Input `{ asset, views?=8, res?=512 }`. Builds a transient `FAdvancedPreviewScene` + the `UStaticMesh`; for N orbit cameras a `USceneCaptureComponent2D` renders three passes by swapping the component material + capture settings:
  - **color** — normal lit render (`color_v{i}.png`).
  - **world-position** — material override emitting `AbsoluteWorldPosition` to emissive; capture **HDR, unlit, post off** → `worldpos_v{i}.exr` (16-bit float).
  - **UV** — material override emitting `TexCoord0` to emissive; same unlit/linear/HDR settings → `uv_v{i}.exr` (16-bit).
  Capture config: `CaptureSource = SCS_SceneColorHDR`, `ShowFlags` with Lighting/PostProcessing/Tonemapper/EyeAdaptation **off** (so UV/worldpos values pass through un-tonemapped). Materials `Resources/M_HaybaUVPass`, `M_HaybaWorldPosPass` (unlit, emissive-only).
- Exports `mesh_lod0.json` once (LOD0 vertex positions + index buffer) for the sidecar BVH. Output dir `ProjectDir/.scratch/study/<assetSafe>/` (assetSafe = path with `/`→`_`).
- Returns `{ ok, dir, views, has_uv0 }`. Registered as a UE command (callable via the MCP).
- **De-risk first:** the unlit/linear material-override capture is the load-bearing trick — Task 0 of the plan is a standalone spike proving `worldpos_v0.exr` round-trips correct world coordinates before anything else is built.

### 4.3 Agent orchestration — `plumb_segment` MCP tool
- `plumb_segment(asset, study_dir, parts:[{label,color,views:[{view,box|points}]}])` → POSTs to the sidecar `/segment_project`; on success writes each returned mask into the profile store (reusing `addMask`, with the new `texture` field). Returns the masks added.
- The full agent loop (Part-D-driven): `plumb_study_take` → for each asset: `study_render` (UE) → **read `color_v*.png`** → the agent names parts **and gives a box/points per part per view it can see it in** → `plumb_segment` → masks land in the profile → Studio auto-refreshes. (The agent is the grounder; SAM just refines the agent's boxes into precise masks.)

### 4.4 Mask data model + Studio rendering
- Extend `Mask` (contracts.ts) with `texture?: string` (path to the UV mask PNG).
- Studio: for a surface mask with `texture`, build a translucent `UMaterialInstanceDynamic` that samples the texture as opacity × the mask color, applied as an **overlay material** on the preview mesh (smooth, UV-mapped). Textureless surface masks keep the current triangle-fill path. The Studio loads the texture PNG via `FImageUtils`/`UTexture2D` from disk.

## 5. Data flow / files (under `ProjectDir/.scratch/study/<assetSafe>/`)
- `color_v0.png … color_v{N-1}.png` — lit renders (agent grounding + SAM input).
- `worldpos_v0.exr …` — 16-bit world-position pass (triangle projection).
- `uv_v0.exr …` — 16-bit UV pass (display-texture bake).
- `mesh_lod0.json` — LOD0 vertex positions + index buffer (sidecar BVH).
- `views.json` — camera params per view (debugging / future volume work).
- `masks/<label>.png` — baked per-part UV display textures (output).

## 6. Error handling
- Sidecar down → `plumb_segment` returns a clear error; the Studio "Study with AI" still works (it only enqueues). `check_ue_status` surfaces `visual_embeddings_available:false`.
- Mesh has no UV0 → `study_render` reports it; pipeline falls back to triangle-only masks (no texture) so the result is still usable.
- Grounded-SAM finds nothing for a prompt → that part is skipped (logged in the response), not an error.
- Multi-view disagreement → union of coverage; a `coverage` score per mask flags low-confidence parts.

## 7. Testing
- **Sidecar**: unit-test the projection (synthetic uv pass + mask + tri_uvs → expected texture + triangle set) without the heavy models; an integration smoke test gated behind a "models present" check.
- **UE**: `study_render` verified visually — renders + `tri_uvs.json` produced for a real asset; the UV pass image is a valid U/V gradient.
- **TS**: `plumb_segment` writes masks with `texture`; mask model round-trips the field.
- **End-to-end**: on a real Fishing-Dock asset (e.g. `SM_Boat_01a`) — agent proposes parts → masks generated → Studio shows a smooth hull/deck mask hugging the geometry (the acceptance test that replaces the blocky box).

## 8. Risks
- **UE unlit/linear capture (load-bearing, de-risk first)**: getting un-tonemapped 16-bit world-position/UV out of a `SceneCapture` is the make-or-break trick (tonemapping/post would corrupt the values; material override must take on the mesh's real materials). **Task 0 spike** proves `worldpos_v0.exr` round-trips correct world coordinates before the rest is built.
- **SAM box quality**: masks are only as good as the agent's boxes; the agent may mis-box thin/occluded parts. Mitigation: agent can pass multiple points instead of a box, and per-triangle multi-view voting rejects single-view box errors.
- **Model weights / GPU**: SAM is ~GBs and prefers a GPU; first-run download is slow. Mitigation: lazy load, cache dir, clear `/health` reporting; document CPU fallback (slow). (Dropping GroundingDINO halves the model footprint.)
- **Degenerate UVs / no UV0**: only affects the *display* texture now (triangles come from world position); `has_uv0:false` → skip the texture, keep triangle masks.
- **Projection seams / coverage**: grazing-angle gaps mitigated by N≥8 views incl. top/bottom + the per-triangle vote threshold; a low `coverage` score flags parts the agent should re-box.

## 9. Out of scope (separate specs)
- Rich inter-asset placement constraints (lifering↔ship recipes).
- Volume-mask generation (clearance regions in empty space).
- Re-using segmentation for instance scene-understanding.
