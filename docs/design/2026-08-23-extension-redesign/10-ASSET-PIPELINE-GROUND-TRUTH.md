# Asset / environment pipeline — ground truth (2026-08-23)

What Hayba can actually do today for asset acquisition, 3D content, and world
building. Facts only, with file:line. Several of these are more serious than
anything in the UI critique.

---

## The three findings that matter most

### 1. External asset import is permanently disabled

`src/tools/asset-sources/shared.ts:399-420` — `importIntoUe()` **always
returns `ok:false`**:

> `HAYBA-ASSET-IMPORT-TYPED-BLOCKED: … Native asset_import must satisfy #415
> (brokered per-file authority, final identity recheck, and post-import
> readback) before connectors may call it`

It enumerates files, identity-rechecks them, and then refuses. So every
PolyHaven / ambientCG / Sketchfab download returns `isError: true`
(`polyhaven-download.ts:118`). Locked in by `connector-import-gate.test.ts`.

**Download-to-disk works. Landing an asset in `/Game` from those three sources
does not.** Only **Fab** works end-to-end, because it routes to native
`fab_download` in C++ and bypasses the TS gate.

### 2. Even ungated, the formats do not line up

Native `asset_import` (`HaybaMCPAssetHandler.cpp:784`) accepts **only**
png/jpeg → texture, wav → sound wave, and **binary** FBX → static mesh.
glTF/GLB/OBJ/USD and "dependency-reading formats" are explicitly rejected;
ASCII FBX and OBJ rejected at `:655`.

What the connectors deliver: PolyHaven models are **glTF**, Sketchfab is
**glTF/GLB archives**, PolyHaven HDRIs are **.hdr/.exr**. **None are
importable** even with the gate lifted. Fixing #415 alone does not restore
this pipeline — the format matrix has to be widened too.

### 3. The flagship workflow references tools that do not exist

`addons/workflows/hayba-new-scene/SKILL.md:10,17` and the shipped agent prompt
`hayba.agents.json:8` (*"You always call `hayba_generate_moodboard` or
`hayba_fetch_references` at the start of a new scene task"*) call three tools —
`hayba_generate_moodboard`, `hayba_fetch_references`, `hayba_compare_clip_score`
— that are **implemented nowhere**. No TS handler, no C++ handler, no
registration. `CHANGELOG.md:66` records them as having once existed.

The same skill also calls `level_get_spatial_index`, which is a **deferred
stub** (`no-stub-wrappers.test.ts:45,101`).

**The documented flagship "new scene" workflow cannot execute as written.**
This is the same disease as the four catalog-only validator rules, one layer
up and considerably worse: it is in the shipped system prompt.

---

## What exists (verified)

**Acquisition.** Four search integrations — PolyHaven, ambientCG, Sketchfab
(token), Fab (Epic login) — plus project Content Browser search. A genuinely
hardened download path: bounded fetch, unique cache dirs, safe leaf names,
zip-slip/symlink-safe extraction (`secure-archive.ts`, 1,008 lines),
enumeration limits (4096 files / 8192 entries / depth 32 / 256 MB file / 2 GB
total), dev-ino-nlink-mtime identity recheck, refusal cleanup with retained-file
accounting, and a registry round-trip (`verifyAndMarkDelta`) that closes the
silent-success hole. **No Quixel/Megascans.**

**`world_generate`** (`tools/world/world-generate.ts`, 287 lines): prompt →
**4 hardcoded biome layers** (canopy .18 / rock .12 / undergrowth .45 /
groundcover .25) → resolve one mesh per layer by `asset_search` **first hit** →
bounds-derived PLUMB profile → mulberry32 seeded uniform-disc scatter →
`grounded` validate-and-fix (≤3 passes, pre-spawn) → ISM actors, instances
chunked at 1000. `dry_run` and gap reporting included.

**PCG**: ~20 tools — graph authoring primitives with pin-label validation,
enum/struct/PCG-selector coercion, auto-layout, `pcg_scatter_mesh`,
`pcg_cook_and_wait` with `freshness{changed,before,after}`, and a PCGEx SQLite
doc registry (nodes/pins/properties + header excerpts).

**Landscape/foliage**: read + property-write only, plus native heightmap
`landscape_import`.

**PLUMB**: closed grammar, deterministic bake, AI annotation, masks, sockets,
productions/grammar expansion, lessons, per-instance verdicts with fix vectors.

**Visual sidecar** (`:7821`): CLIP, SpatialCLIP, OWL-ViT, SAM + world-position
back-projection.

**Materials**: full graph authoring (create/instance/nodes/wires/params/
compile/validate). **Textures: metadata only** — 4 tools, no pixels.

---

## What is absent

**Corrections to earlier docs in this dossier:**
- **`hayba_bake_terrain` does not exist.** `tools/hayba-bake-terrain.ts:1-2` is
  a compile-only stub: *"removed from the active MCP surface."* I listed it as
  a live tool in the earlier critique — that was wrong.
- The **Gaea terrain pipeline is fully orphaned**: `src/gaea/terrain-pipeline.ts`
  holds a complete biome/mood/scale/geological-process intent analyzer
  (8 biome keyword families, mood taxonomy, complexity scoring) plus a layout
  engine and an archetype store fed by ~9 tutorial transcripts — and **nothing
  under `src/tools/` imports it.** A second, larger instance of the
  slivers disease: sophisticated machinery wired to nothing.

**3D generation: zero.** A repo-wide grep for
`meshy|tripo|hunyuan|rodin|sloyd|generate_3d|text_to_3d|image_to_3d` returns
**no code at all** — no client, no stub, no env var, no key storage, no job
polling. Only aspirational roadmap entries (`asset_gen_3d_create` as a P1
proposal). No mesh normalization, retopo, decimation, LOD, collision, UV or
lightmap-UV generation, no Nanite prep.

**Texture/material generation: none.** No AI or procedural synthesis, and
critically **no `material_from_textures`** — an imported ambientCG/PolyHaven
map set would not be assembled into a material automatically.

**World building gaps.** No procedural terrain from prompt. No sculpt, erosion,
hydrology, or weightmap painting from MCP. `world_generate` is flat-z with **no
terrain raycast or conform** — "grounded" is validated against the area actor's
z, not the landscape. Only the `grounded` primitive is bound, despite the file
header claiming "grounded, non-interpenetrating" (`:5`). Disc distribution
only — no paths, clearings, clusters, edges, exclusion zones, rivers or roads.
No materials, lighting, atmosphere, water, or gameplay volumes. No
LOD/HLOD/World-Partition awareness. Zone planning requires a human clicking a
browser dashboard.

**Perception loop.** CLIP is served but **never used for asset selection** —
the retriever's embeddings are text-only (BM25 + optional Ollama). Sidecar
`/validate` is a documented v0.1 placeholder; `scene_validate_physics`'s deep
path emits *"not implemented in this version"*.

**No orchestrator.** Nothing chains prompt → references → terrain → zones →
acquire/generate missing assets → place → materials/lighting → validate →
visually score. And the two stages that would bridge acquisition to placement —
connector import and CLIP asset matching — are exactly the two that are
non-functional.

---

## Reading this against Nwiro

| | Nwiro | Hayba today |
|---|---|---|
| Asset supply | Meshy + Tripo (BYO key) **and** Leartes' own library | Fab only (the other three connectors are gated shut) |
| Mesh matching | **name-string** convention (`SM_Pine_01`) | text embeddings (BM25/Ollama) — better in principle, and CLIP sits unused |
| Scatter | PCG graph, layering + density + **collision avoidance** | seeded disc, 4 fixed layers, `grounded` only, **flat z** |
| Placement validation | none beyond collision avoidance | PLUMB directional verdicts — **our real edge, already built** |
| Terrain | AI heightmap, real elevation data 1:1, image→landscape | import only; the intent pipeline exists but is orphaned |
| Textures/HDRI | tileable PBR + text→HDRI generation | none |
| Interiors | admitted weakness | grammar/productions machinery exists, unwired to a workflow |

The honest summary: **they can put things in a world and we can judge whether
things belong in a world — and neither of us can currently do both.** Their gap
is validation, which we have built. Our gap is supply and terrain, which they
have. Ours is the harder half to build and the easier half to fix.
