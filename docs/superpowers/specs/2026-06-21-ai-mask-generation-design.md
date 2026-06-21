# AI Mask Generation — design

**Date:** 2026-06-21
**Status:** design (approved direction; pending written-spec review)
**Builds on:** the shipped PLUMB/Semantic-Studio system (`feat/mcp-ux-validation-overhaul`) — profiles, masks, the Studio, the Part-D study loop.

## 1. Purpose

Replace hand-placed placeholder masks with **AI-generated semantic masks that hug the real geometry**: the agent looks at a mesh, names its parts along the pack theme ("rowboat → hull, deck well, bow rope, oarlocks, rim"), and a segmentation model projects those parts onto the asset as **UV-texture masks** (smooth, sub-triangle), each with a derived triangle set for the constraint evaluator.

Out of scope (separate follow-up spec): rich inter-asset placement constraints (the "lifering at the bow, on the ground, leaning on the hull" recipes). This spec is the mask-generation pipeline only — masks are the foundation those constraints will reason over.

## 2. Architecture — three actors

- **UE plugin** — the only actor that can see the geometry. Renders the mesh from N orbit views; each view produces a **color** pass and a **UV pass** (per-pixel surface UV). Exports `tri_uvs.json` (triangle → UV centroid).
- **Agent (Claude via MCP)** — the VLM. Reads the color renders, proposes themed part labels per asset, orchestrates the pipeline. No separate VLM is hosted; the agent's own vision does the semantic "understanding."
- **Visual sidecar** (`localhost:7821`, currently down) — Python/FastAPI holding **GroundingDINO + SAM**. Given the renders + prompts, segments each part and **projects** the masks into UV space via a per-pixel lookup, returning texture-backed masks.

Flow: **UE renders → agent proposes parts → sidecar segments + projects → profile gets texture masks → Studio auto-refreshes** (reusing the Part-D poll ticker).

## 3. The projection method (no 3D back-projection math)

UE renders an auxiliary **UV pass** so projection is a per-pixel table lookup, not fragile world-space reconstruction:

1. **Render** (per view): color (`color_v{i}.png`) + UV pass (`uv_v{i}.png`, a material override outputting `TexCoord0` as R=U, G=V). Export `tri_uvs.json` once (LOD0 triangle index → UV0 centroid).
2. **Segment** (sidecar): per color image, GroundingDINO(prompt)→boxes→SAM→a binary mask per part per view.
3. **Project** (sidecar): for each masked pixel `(x,y)`, read `uv_v{i}[x,y]` → `(u,v)` → paint that texel in the part's UV-space mask texture; accumulate across views (multi-view fills occluded/grazing areas). Derive the triangle set: a triangle is "in" iff its UV centroid lands on a painted texel.
4. **Store**: each part → a profile mask `{ id:label, type:'surface', texture:'masks/<label>.png', triangles:[…], color, source:'ai', confidence }`.

This yields masks that follow the real UVs/curves — solving the "too blocky / not representative" problem. Segmentation produces **surface part masks**; volume masks (clearance regions in empty space) remain separately authored.

## 4. Components & interfaces

### 4.1 Visual sidecar — `mcp-tools/visual-sidecar/`
- Python/FastAPI on `:7821`. Models: GroundingDINO + SAM (HF weights, downloaded + cached on first run; lazy-loaded).
- `GET /health` → `{ ok, models_loaded }`; flips `check_ue_status.visual_embeddings_available` true.
- `POST /segment_project` — `{ study_dir, prompts:[{label,color,box_threshold?}] }`. Reads `color_v*`, `uv_v*`, `tri_uvs.json`; per prompt runs Grounded-SAM across views, paints `masks/<label>.png` (UV texture), derives triangles. Returns `{ masks:[{label,texture,triangles,color,confidence,coverage}] }`. Errors return `{ ok:false, error }` (never throws to the caller).
- Startup script + README; model weights cached under a configurable dir.

### 4.2 UE command — `study_render` (new handler, non-destructive)
- Input `{ asset, views?=8, res?=512 }`. Builds a transient `FAdvancedPreviewScene` + the `UStaticMesh`; for N orbit cameras a `USceneCaptureComponent2D` renders the **color** pass, then re-renders with a **UV material override** (`Resources/M_HaybaUVPass`) for the **UV** pass; writes PNGs. Exports `tri_uvs.json` from LOD0 (index buffer + `VertexBuffers.StaticMeshVertexBuffer` UV0, per-triangle centroid). Output dir `ProjectDir/.scratch/study/<assetSafe>/` (assetSafe = path with `/`→`_`).
- Returns `{ ok, dir, views }`. Registered as a UE command (callable via the MCP).

### 4.3 Agent orchestration — `plumb_segment` MCP tool
- `plumb_segment(asset, study_dir, prompts:[{label,color}])` → POSTs to the sidecar `/segment_project`; on success writes each returned mask into the profile store (reusing `addMask`, with the new `texture` field). Returns the masks added.
- The full agent loop (Part-D-driven): `plumb_study_take` → for each asset: `study_render` (UE) → read `color_v*.png` → propose themed prompts → `plumb_segment` → masks land in the profile → Studio auto-refreshes.

### 4.4 Mask data model + Studio rendering
- Extend `Mask` (contracts.ts) with `texture?: string` (path to the UV mask PNG).
- Studio: for a surface mask with `texture`, build a translucent `UMaterialInstanceDynamic` that samples the texture as opacity × the mask color, applied as an **overlay material** on the preview mesh (smooth, UV-mapped). Textureless surface masks keep the current triangle-fill path. The Studio loads the texture PNG via `FImageUtils`/`UTexture2D` from disk.

## 5. Data flow / files (under `ProjectDir/.scratch/study/<assetSafe>/`)
- `color_v0.png … color_v{N-1}.png` — lit renders (agent + segmentation input).
- `uv_v0.png …` — UV pass (projection).
- `tri_uvs.json` — `[{tri:int, uv:[u,v]}]`.
- `views.json` — camera params per view (for debugging / future volume work).
- `masks/<label>.png` — baked per-part UV mask textures (output).

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
- **Model weights / GPU**: GroundingDINO + SAM are ~GBs and want a GPU; first-run download is slow. Mitigation: lazy load, cache dir, clear `/health` reporting; document CPU fallback (slow).
- **UV quality**: assets with overlapping/!injective UVs (or no UV0) degrade the texture bake — handled by the triangle-only fallback (§6).
- **UE UV/triangle-ID material pass**: outputting `TexCoord0` to color via a material override is the load-bearing UE trick; if a mesh's material ignores the override, fall back to a default material. Verify early.
- **Projection seams**: multi-view accumulation can leave gaps at grazing angles; mitigated by N≥8 views + top/bottom and a small UV-space dilation of the painted mask.

## 9. Out of scope (separate specs)
- Rich inter-asset placement constraints (lifering↔ship recipes).
- Volume-mask generation (clearance regions in empty space).
- Re-using segmentation for instance scene-understanding.
