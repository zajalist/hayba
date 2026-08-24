# AI for 3D content — research findings (2026-08-23)

Assembled from parallel research streams: text/image-to-3D vendors, texture and
PBR generation, VLM/LLM spatial reasoning, and industry signals. Every headline
claim carried an inline source in the source reports; UNVERIFIED items are
flagged.

---

## 1. The finding that validates our architecture

**SpatialGrammar ablation** (arXiv:2604.27555), same LLM throughout:

| Output format | Collision rate |
|---|---|
| Raw JSON coordinates | **66.7%** |
| Constrained BEV DSL | **13.6%** |
| DSL + deterministic compiler feedback loop | **0%** |

Corroborated independently: **LayoutVLM** (in-boundary 94.9% vs 34.3%
baseline), **Scenethesis** (22.7% → 0.8% collision once physics is in the loop).

This is the PLUMB thesis, arrived at by other people: **a closed output
language plus a deterministic validation loop.** Our design decisions — a
closed primitive set, authoring that fills values rather than writing logic,
signed margins with fix vectors, validate-and-fix before commit — are what the
2026 literature says is the difference between a two-in-three failure rate and
zero.

The practical guidance from that literature maps almost line-for-line onto
choices already made in this repo:

| Research guidance | Our equivalent |
|---|---|
| Constrain the output language so invalid placements are unrepresentable | The 13 closed PLUMB primitives; "authoring fills values, never writes logic" |
| Validate with engine queries/physics **in-loop**, not post-hoc nudging | `validateAndFix` before spawn, ≤3 passes |
| **Do not use a VLM as the placement judge** | Qualitative primitives carry confidence and **cannot hard-gate unless human-locked** |
| Give the model 3D interrogation tools, not only screenshots | `mesh_get_info`, bounds, profiles, spatial index |
| "Screenshots for taste, solvers for truth" | Vision sidecar for grounding; PLUMB for verdicts |
| **Skip chain-of-thought on spatial subtasks** — it *degrades* VSI-Bench ~4 pts | Not yet applied — see actions below |

## 2. VLM spatial reasoning is genuinely bad — plan around it

| Benchmark | Human | Best model |
|---|---|---|
| MMSI-Bench (arXiv:2505.23764) | 97% | GPT-5 reasoning **40%**; best open-source ~30% |
| VSI-Bench (arXiv:2412.14171) | 79% | Gemini-1.5-Pro 45.4%; GPT-5-Chat ~49.1 in 2026 re-evals |
| Spatial-DISE | 76.8% | 42%; 28-model mean **28.4%** vs 25% chance |
| All-Angles Bench | 82% | 52.3%; camera-pose gap **>50 pts** |
| SpaceNum (arXiv:2605.23898) | — | 39.8% vs 30% random |

**SpinBench** (arXiv:2509.25390): mental rotation **at or below chance**;
Gemini 2.5 Pro scores κ=0.94 egocentric but **κ = −0.66 allocentric** — i.e.
*systematically inverted* when reasoning from another viewpoint. **Spatial-DISE
attributes 72.5% of failures to reasoning, not perception** — better
screenshots will not fix this.

Two consequences: an agent must never be *trusted* to place objects by
reasoning alone (constrain + verify), and cognitive-map-style prompting (+10
pts) beats chain-of-thought (−4 pts) on spatial subtasks.

*UNVERIFIED: no third-party spatial numbers exist yet for Gemini 3/3.1 Pro,
GPT-5.2, or Claude Opus 4.5/4.6 — vendor claims only.*

## 3. 3D generation — licensing is the binding constraint

| Provider | Commercial-use posture |
|---|---|
| **TRELLIS.2** | **MIT — clean** |
| **Sloyd** | procedural, "legally safe" — **clean** |
| Hunyuan3D | **excludes EU / UK / South Korea outright**; bars training on outputs |
| Meshy | commercial rights paywalled; **free tier CC BY 4.0 with Meshy owning the IP** |
| Tripo | commercial rights paywalled; **free tier non-commercial only** |
| CSM | **dead** — Google/DeepMind acquisition 2026-01-24 |
| Kaedim | enterprise-only |

**A hard requirement this creates:** an agent must *never* silently run on a
free-tier key. Provider + tier + resulting licence must be recorded per
generated asset and surfaced before the asset can ship. That is an
attribution-ledger feature, not a nicety.

Practitioner failure list is consistent across sources: non-manifold geometry,
internal faces, lumpy topology, monolithic single-mesh output, bad UVs, the
**UE5 cm-vs-m scale trap**, and Nanite's skeletal/translucency exclusions.
2026 entrants: Pixal3D, HY-World 2.0, PartCrafter, Step1X-3D, Direct3D-S2,
Sparc3D 2.0.

## 4. Textures — the unowned step is ours to take

**Nothing emits UE material graphs.** Every generator hands over a texture set;
**UE-side assembly is unowned** — Substrate nodes, sRGB flags, ORM packing,
virtual texturing, instance parameterization. The source report's words: *"that's
the moat for an agent with live editor access."*

That is exactly Track A's `material_from_textures` (A2), and it is worth more
than it looked: it is the step every generator skips and only an in-editor
agent can do.

Also: **Epic has shipped no material-authoring AI.** UE 5.7's AI Assistant is a
Q&A/C++ codegen panel; UE 5.8 added Mesh Terrain but nothing generative for
materials. Hunyuan3D 2.1's PBR branch produces albedo+metallic+roughness only,
capped by a **512×512 multi-view ceiling**. Firefly's indemnity covers
*unmodified authorized-use outputs* — which likely **excludes** textures an
agent derives normals from and composites into a graph.

## 5. Industry signals

- **Epic's UE 5.8 first-party MCP** (~2026-06-17) — HTTP/SSE only, localhost,
  **no auth layer**, extensible via `UToolsetDefinition`. Epic legitimised the
  category and entered it in the same move.
- **UE6**: Early Access end of **2027**, Verse-first, UEFN merged, **Blueprints
  sunsetting**, AI baked into the engine. Anything we build on Blueprint
  authoring has a horizon.
- **UE 5.7** (Nov 2025): PCG and Substrate production-ready.
- **Unity** killed Muse, shipped Unity AI over third-party frontier models —
  the same "orchestrate, don't own the model" posture as Epic. BYOK is the
  industry-consensus shape, which supports our chat panel design.
- **Meshy raised $400M at $1.5B** (2026-07-21); Tencent Hunyuan 3D went global
  2025-11-26. Asset generation is well-funded and will keep improving —
  **build the pipeline, not the model.**
- **Valve narrowed Steam AI disclosure (Jan 2026) to player-consumed content,
  explicitly exempting dev-side tooling.** Favourable: an editor-driving agent
  does not trigger disclosure.
- *UNVERIFIED and flagged by the researchers:* Adobe MAX/Project Neo section,
  Houdini 21.5/H22, NVIDIA Kaolin/ACE 2026, 2026 copyright rulings, several
  widely-quoted adoption stats. Also a dating trap — the "Omniverse physical AI
  OS" release is **GTC 2025**, not 2026. And MetaHuman's "usable in any engine"
  vs "Unreal runtime only" licensing readings **directly contradict each
  other** — read the EULA before that goes in any deck.

---

## What this changes in the plan

1. **Lead with the validation thesis, not the tool count.** We have external,
   citable evidence that constrained-language-plus-solver is the difference
   between 66.7% and 0% collision. Nobody else in this field ships it. This is
   the strongest positioning claim available to us, and it is defensible with
   arXiv references rather than adjectives.
2. **A2 (`material_from_textures`) is promoted** — it is the industry's unowned
   step and only an in-editor agent can perform it.
3. **A5 gains a hard requirement:** a per-asset provenance/licence ledger
   (provider, tier, resulting licence) that blocks shipping a CC-BY-viral or
   non-commercial asset unnoticed. Default to **TRELLIS.2 / Sloyd** for clean
   commercial output.
4. **New: turn off chain-of-thought for spatial subtasks** and prefer
   cognitive-map-style prompting in the agent loop. Cheap, evidence-backed
   (+10 vs −4 pts).
5. **Never let a VLM be the placement judge.** Our design already forbids
   hallucinated semantics from hard-gating; this now has literature behind it.
   Keep the CLIP/OWL-ViT sidecar for *grounding and taste*, never for verdicts.
6. **Blueprints sunset in UE6 (2027).** Weight investment accordingly.

---

# Part 2 — Scene-level generation, layout reasoning, procedural+neural hybrids

Second research stream (~28 sources, Aug 2026). This one contains the day's
strongest external validation and one genuinely unclaimed position.

## 6. Nobody drives Unreal from research

> "No published system drives **Unreal** natively the way SceneCraft drives
> Blender — UE appears in 2026 arXiv only as a **benchmark host**
> (OmniGameArena, arXiv:2606.09826), not an authoring target."

The entire 2026 scene-generation literature composes assets for Blender, or
exports GLB and hopes. **An LLM-driven authoring agent native to UE is
unclaimed in the research record.** Also unclaimed: LLM → Houdini HDA, and
"LLM writes Infinigen constraint-DSL".

## 7. The survey whose thesis is our market gap

**arXiv:2604.23629** — *From Visual Synthesis to Interactive Worlds: Toward
Production-Ready 3D Asset Generation* (Apr 2026). Its finding: generated 3D
fails on **topology, UV parameterization, PBR, skeletal rigging, and
physics-aware layout**, and *"a persistent gap separates the outputs of current
methods from the production-ready standard expected by interactive
applications."*

That is a citable, peer-reviewed statement of exactly the gap Track A targets —
and of why Nwiro's undocumented import hygiene matters.

## 8. Recipes = "library learning", independently invented

**SceneCraft** (ICML 2024): the LLM writes Blender Python, a VLM critiques
renders, and **library learning compiles recurring functions into a reusable
library — self-improving without fine-tuning.**

That is W5's Save-as-Recipe, arrived at independently by researchers. Our
version has an advantage theirs lacks: a captured Recipe carries the **Rules it
must satisfy**, so reuse is verified rather than merely repeated.

## 9. Adopt the field's acceptance metrics

The literature has converged on comparable numbers. PLUMB should emit them:

| Metric | Source |
|---|---|
| **Col-O / Col-S** — mesh-mesh collision, object and scene level | Scenethesis (ICLR 2026) |
| **Inst-O / Inst-S** — post-simulation instability | Scenethesis / Atlas3D |
| **#Obj / #OB / #CN** — object count, out-of-bounds, collided pairs | SceneWeaver |

**The bar to beat — SceneSmith (ICML 2026 Spotlight): <2% inter-object
collisions, 96% stability under physics, 3–6× more objects than prior work,
92% human-rated realism.**

Emitting these turns "our validator is good" into a number comparable with
published work. Nothing else in the UE tooling field reports anything like it.

## 10. Four 2026 techniques worth stealing

1. **NaLA** (ECCV 2026, **code released**) — encodes scene boundaries and asset
   geometry **directly into the LLM** rather than stringifying them, removing
   the text-modality loss that causes collision and containment errors. Beats
   prior agents on quality *and* inference cost. Directly applicable: we
   currently stringify bounds into prompts.
2. **SceneOrchestra** (ECCV 2026) — **kills execute-review-reflect**; a trained
   orchestrator emits a **complete tool-call trajectory up front**. SOTA
   quality at lower runtime — the key paper for a latency-sensitive editor
   agent.
3. **CityGenAgent** (Feb 2026) — **SFT for schema conformance, then RL on
   spatial-alignment reward.** The most transferable recipe for any agent that
   must emit valid engine-side structures.
4. **SceneSmith** (ICML 2026 Spotlight) — **designer / critic / orchestrator**
   VLM triad; text-to-3D for static props, **retrieval for articulated
   furniture**, algorithmic physical properties.

## 11. Terrain — a drop-in answer to our biggest hole

**InfiniteDiffusion** (SIGGRAPH 2026, arXiv:2512.08309) — *training-free*
reformulation of diffusion sampling giving **seamless infinite terrain with
seed-consistency and constant-time random access**: it behaves like procedural
noise while carrying a learned prior. Laplacian encoding stabilises
Earth-scale dynamic range. **"Outpaces orbital velocity by 9× on a consumer
GPU"**, warmup 1.72 s, steady-state 0.66 s. **Reportedly integrated into
Minecraft, replacing the native world generator. Code open, CC BY 4.0.**

We have no procedural terrain generation (`hayba_bake_terrain` is a stub, the
Gaea pipeline is orphaned). This is an open-licence, engine-proven answer.
Also relevant: TerraFusion (joint heightmap+texture), Terrain Diffusion Network
(climate-aware, geological-sketch guided), One Noise to Rule Them All.

## 12. What actually exports to an engine

| Product | Export | UE path |
|---|---|---|
| **HY-World 2.0** (Tencent, open weights) | **meshes, 3DGS, point clouds** — persistent, editable | docs state **directly importable into Blender / UE / Isaac**. Strongest open competitor to Marble |
| **World Labs Marble** | splats **+ collider meshes** for physics | best-in-class quality, but needs a **paid third-party UE plugin** (VIVE Mars Nova / Volinga / Akiya / Postshot), UE 5.2–5.6, no semantics |
| **HunyuanWorld 1.0** | meshes, disentangled objects | CG-pipeline compatible, exports to UE |
| **HOLODECK 2.0** | GLB | **tested in UE 5.6** |
| **Blockade Skybox** | 360°/HDRI, experimental GLB | HDRI source, not a level |
| **Genie 3 / Odyssey / Decart** | interactive video | **no export path** — experiences, not content |

**Infinigen** (Princeton, procedural, Blender) remains the quality and
licensing benchmark: a **constraint DSL + solver** for composition, and since
Jan 2026 it imports authored assets and exports **USD/URDF/MJCF**, stated
usable in Omniverse and Unreal. Its constraint-DSL-plus-solver shape is
PLUMB's shape.

## 13. Revised reading for the plan

- **The exportable frontier is asset-composition-under-constraints and
  LLM-driven-procedural.** Gaussian and video world models are demos for our
  purposes — no semantics, no collision, no editability, no PBR.
- **"The first native LLM authoring agent for Unreal" is available in the
  research record**, and we are closer to it than anyone.
- **Track A gains a terrain answer** (InfiniteDiffusion, open licence) and an
  asset-supply answer with clean licensing (HY-World 2.0 open weights,
  TRELLIS.2 MIT, Sloyd procedural).
- **PLUMB gains a scoreboard**: Col-O/Col-S/Inst-O/Inst-S and #Obj/#OB/#CN,
  measured against SceneSmith's <2% / 96% / 3–6× bar.

---

# Part 3 — Full synthesis additions

From the parent research agent (~180 searches across six streams). Only
material not already covered above.

## 14. UE-specific prior art exists — and its headline is misleading

**AutoUE** (arXiv:2603.07106) — a 5-agent pipeline over 858K assets reporting
**100% PCG node/param/pin success**. Read the ablation, not the headline:
removing the predefined PCG patterns drops node success to **79.6%** and pin
connections to **64%**. The 100% comes from *templating*, not model
competence — and the paper **does not report spatial placement failures at
all**. Also: SimWorld, UnrealLLM, RAISECity.

This matters two ways: it confirms templated/recipe-shaped execution is what
makes UE agents work (our Recipes thesis), and it shows the field's UE numbers
are soft.

## 15. Import hygiene — encode these as hard rules

- **GLB is metres, UE5 is centimetres → ×100 or the asset is coin-sized.**
- **glTF is Y-up, UE5 is Z-up.**
- **Nanite does not support skeletal meshes, translucent materials, or opacity
  masks** — characters and foliage still need hand LODs no matter how clean the
  generation.
- Compression flags: **sRGB off for ORM and normal maps.**

These are exactly the normalization steps A5 must own, and the ones Nwiro's
undocumented pipeline probably does not.

## 16. The headless capture chain nobody has packaged

**RealityScan 2.1** (Nov 2025) shipped a **Remote Command Plugin exposing
RealityScan over gRPC/REST**, a documented batch CLI with Python samples, and
a **Linux CLI build**. 2.2 (Jun 2026) added AMD GPU support. Free under $1M
revenue.

**`splat-transform -K`** voxelises a splat, flood-fills the interior, and
writes a **watertight `.collision.glb`** that drops in as a static-mesh
rigidbody with no cleanup.

The full chain — **RealityScan over gRPC → Postshot/Houdini PDG →
splat-transform** — is headless and callable today, and the researcher's
verdict is blunt: *"nobody has packaged it as an agent tool."* A concrete,
unclaimed integration.

Caveats: treat splats as **set dressing, never gameplay geometry**. Baked
lighting is architectural (SH coefficients), and **Epic shipped no splat
support through 5.8** — it is a UE6 question. Plugin landscape: **XVERSE is
the well-known option and the trap** (1.1k stars, 42 commits, 99 open issues,
no verified 5.6+); **NanoGS (MIT)** has the best architecture; **MLSLabs** the
best published numbers. **Luma AI exited 3D capture entirely** — Genie sunset
2026-01-01; any roundup still listing it is stale.

## 17. Spatial-reasoning failure modes to design against

Beyond the benchmark numbers already recorded:

- **Metric distance dies past ~20 m** (arXiv:2509.06266). **UE5 outdoor world
  scale is entirely past that cliff.**
- **Coordinate-system blindness** — models reason in *image space* and ignore
  the task's declared frame. Expect them to ignore Z-up, centimetres, and
  handedness unless the tool layer enforces it.
- **No long-horizon spatial memory** — VSI-SUPER: **38.3% at 10 min → 0.0%
  beyond 60 min**. Long authoring sessions lose the world model entirely. This
  argues directly for our persisted World model rather than context-carried
  state.
- **MindCube: handing the model a pre-computed map *hurt* by −5.81%** — the
  model must *construct* the intermediate representation, not receive it.
  Important for how we surface Scene Map to the agent.
- **SpatialLM emits a DSL, not coordinates**; **3DGraphLLM** shows scene-graph
  beats raw point cloud as the LLM interface. Both reinforce the
  constrained-language conclusion.
- **The benchmarks are themselves partly broken** — ReVSI re-annotated 381
  VSI-Bench scenes and found artifacts, mislabeled identities, and questions
  unanswerable at real frame budgets. Gaps are directionally right, numerically
  soft.

## 18. Engine and market signals not yet recorded

- **UE 5.8 shipped Mesh Terrain** — overhangs, caves, Boolean tools,
  PCG-integrated. This changes what "terrain" means for us; any terrain plan
  must account for it rather than assume heightfields.
- **UE 5.7 made PCG production-ready** and added a **Procedural Vegetation
  Editor** — our PCG surface is building on now-stable ground.
- **Fab requires a `CreatedWithAI` label at publish**, with automated
  detection and Epic's contractual right to relabel — triggered by one seller
  dumping 41,000+ AI assets. **Sketchfab requires labels since 2025-12-11.**
  Relevant to D1.8 (Fab listing) and to A5's provenance ledger.
- **Valve's Jan 2026 rewrite exempts behind-the-scenes efficiency tools** from
  disclosure. An editor-driving agent is not disclosable under that reading.
- **Both engine vendors became orchestration layers**: Unity killed Muse and
  shipped Unity AI over third-party models; Epic shipped MCP. **Neither is
  betting on owning the model** — which validates BYOK.
- **NVIDIA ceded text-to-3D** (Edify withdrawn as a NIM preview, Jun 2025);
  NuRec GA is AV/robotics, not games. **RTX Neural Texture Compression** is
  independently benchmarked at **>80% VRAM reduction** — a real runtime lever.
- **Polygonflow Dash is not a texture generator** — its AI is asset tagging;
  its material work is blending/tiling-breakup over existing libraries. It is
  a **library + placement competitor**, i.e. closer to Nwiro than to Meshy.
- **PartCrafter** (NeurIPS 2025) — single image → 2–16 **semantically
  segmented** meshes. The missing primitive for kitbashing and per-part
  materials.
- **Material Palette** (CVPR 2024) — extract a region-segmented **palette of
  PBR materials from one real photo**. Fits "photo of a real place → a set of
  UE materials" exactly.
- **Chord / MaTi** — tileability as a **bolt-on post-process** over any
  generator's output. Cheap way to fix the world-scale repetition problem.

## 19. The ten production gaps, ordered by how often they bite

1. **UVs** — auto-unwrap ignores texel-density budgets, UDIM, mirrored shells,
   lightmap channel 1.
2. **Resolution honesty** — "8K" usually means 8K base colour upsampled from
   512² diffusion.
3. **Roughness/metallic sanity** — albedo convinces, MR channels are mush;
   metallic should be near-binary.
4. **Residual baked lighting** — visible only when you relight, caught by no
   automated metric.
5. **Normal/height plausibility** at grazing angles.
6. **World-scale tiling repetition.**
7. **Engine integration — zero tool coverage.**
8. **Cross-asset art direction** — 200 individually-good assets that do not
   belong to one world; reads instantly, detected by no per-asset metric.
9. Performance budget.
10. Legal provenance.

**(7) and (8) are ours to own.** (7) because only an in-editor agent can do it;
(8) because it is exactly what a world model plus constraints is for.

## 20. Four architectural conclusions (the researcher's, endorsed)

1. **Build the validator, not the generator.** Generation is commoditising and
   well-capitalised ($400M into Meshy alone); validated composition is not.
2. **Never let the model emit raw transforms.** Worth 66 points of collision
   rate.
3. **Epic's MCP has exploitable seams today** (experimental, HTTP/SSE only, no
   auth, "not for production pipelines") — but the **UE6 clock** (EA end 2027,
   Verse-first, Blueprints sunsetting) means anything bound tightly to UE5's
   Blueprint/C++ surface has a visible expiry. **Build against intent and
   validation, which survive the transition.**
4. **Licensing is a product decision, not a footnote.**

## Open gaps — not closed, do not assert these

Adobe MAX 2025/2026 and Project Neo; Houdini 21.5/22 and **Houdini Engine for
UE**; NVIDIA Kaolin/ACE 2026; 2026 copyright rulings; Alpha3D pricing; Tripo UV
specifics; independent non-vendor text-to-3D benchmarks (403-blocked); whether
Fab has a first-class splat asset type; Lumen/depth interaction for UE splat
plugins; **the MetaHuman "any engine" vs "Unreal runtime only" licensing
contradiction — read the EULA before this goes in any deck.**
