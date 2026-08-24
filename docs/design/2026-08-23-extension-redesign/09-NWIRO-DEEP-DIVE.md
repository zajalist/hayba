# Nwiro / Leartes — deep dive (2026-08-23)

The most strategically important competitor read of the day, because Nwiro
occupies the exact niche Hayba is aiming at: **AI world building in UE**.

## What it is

**Leartes Studios** — a 200+ artist game-art outsourcing studio that also runs
the **Cosmos** asset marketplace. Nwiro is their product, two SKUs:

| | Nwiro AI Pro | Integration Kit |
|---|---|---|
| Price | Free plugin, credits: $9 / $36 / $144 per month | **$49.99 one-time** |
| Backend | Cloud (`api.nwiro.ai`) — model routing, agent planning, billing | **Fully local MCP server on `127.0.0.1:5353/mcp`** |
| AI | 12 models incl. Opus 5, GPT-5.6, Gemini 3.6 | BYO host: Claude Code, Codex, Cursor, Windsurf, Copilot, Ollama, LM Studio |
| Biome generator | ✅ | ❌ (Pro-only, cloud-only) |
| UE | 5.6+ | 5.5+ (5.8 since v1.0.7) |

Launched Pro 2026-02-27, IK 2026-04-17; shipping continuously (Pro v1.1.10 on
2026-08-03). Self-reported 10,000+ users, 4.7/5 on Fab — **vendor-reported
only; Fab blocked automated verification**. Two sponsored 80.lv articles.
Funding: none found. Data processed in Türkiye/Germany, not used for training.

**Tool surface: 209 documented, front page now claims 219 native C++ tools**
across 28–30 categories — Blueprint 18, World/Actors 17, PIE/Runtime 14,
Material 12, Debug 10, Animation 9, IK Rigs/Retargeters 8, Game Framework 8,
Gameplay 7, Spline 7, Sequencer 6, Data 6, GAS 6, Asset 5, Enhanced Input 5,
Environment 5, Level 5, Niagara 4, UMG 4, Motion Matching 4, Physics 4, PCG 4,
Foliage 4, File Ops 4, StateTree 3, Navigation 3, Audio 3, Landscape 3,
Networking 3, World Partition 2.

Beyond the earlier intel, also confirmed: **landscape from real elevation data
at 1:1 scale from a place description**, **image-to-landscape**, **text→HDRI**,
tileable PBR texture generation, ElevenLabs + fal integrations, a File Editor
extension (C++, configs, `.build.cs`), **custom tools via UFUNCTION tags**, and
local-LLM support. Blueprint debugger confirmed (10 tools: breakpoints, watch
expressions, execution tracing, claimed auto-fix).

---

## Finding 1 — their world generation is a name-matcher, not a generator

This is the load-bearing fact. From their own docs:

> Environment Generation "picks meshes **from your own Content Browser**, and
> places them into your level, with layering, density, and collision avoidance
> handled automatically."

> "Pro's Biome Generator **matches your prompts to meshes by name**… Clean
> naming makes the generator work; **generic naming makes it useless**."
> Convention: `SM_<Type>_<Variant>` — `SM_Pine_01`, `SM_ForestRock_Snow_03`.

Pipeline: cloud backend plans biome layers → matches meshes **by name string**
→ compiles a PCG graph → local C++ dispatcher instantiates it.

So: **PCG scatter over a filename index.** Not simulation. Not generative
geometry. No semantic understanding of what an asset *is* — only what it is
*called*. A studio with inconsistent naming gets nothing.

## Finding 2 — no placement validation

Documented placement quality controls: layering, density, collision avoidance.
That is all. **No semantic validation, no quantified verdicts, no pass/fail
reporting, no fix vectors.**

This is precisely PLUMB's territory, and it is empty. Our directional verdict
(signed `value_m` + `FixVector`) has no counterpart anywhere in this product.

## Finding 3 — users report it cannot do interiors

From the UE forum thread, the consistent limitation: **cannot autonomously
produce complete buildings, rooms, or coherent interior layouts.** Outdoor
scatter is the strength; structured space is the weakness. Vendor concedes
"results require iteration and manual refinement."

That failure mode is exactly what a name-matched PCG scatter would produce —
it has no grammar, no room topology, no constraint solving. **Our PLUMB
room-grammar / junction / productions machinery is aimed at that gap**, and
the gap is real and admitted.

---

## The moat read: distribution + corpus, not algorithm

Leartes owns one of the largest UE environment libraries *and* the storefront
selling it. The Biome Generator's output quality is a direct function of the
library it indexes, and they ship a pre-named 224-mesh demo pack "that the
generator recognizes immediately."

So the flywheel is: **Cosmos packs make Nwiro better → Nwiro makes Cosmos
packs more valuable.** That is a genuine moat against a pure-tool competitor —
but it is a *distribution and corpus* moat. The algorithm (name-string match →
PCG graph) is reproducible in a week.

Unverified and worth checking: whether Cosmos assets get preferential
treatment inside the generator.

---

## Threats to us, specifically

1. **"No Python, no Node.js, no bridges"** is their explicit marketing line —
   a direct swipe at exactly our architecture (Node server + TCP + plugin).
   Our answer has to be that the bridge *buys* something (the validator, the
   world model, recipes, token economy, BYOK) — which is only convincing once
   D1.6's one-command install removes the friction the bridge causes.
2. **The $49.99 Integration Kit is a local MCP server** with 209 tools and no
   subscription. That is the closest product to Hayba's shape that exists, and
   it undercuts on install simplicity (native C++, no Node).
3. **Epic extended the MCP bridge into UEFN on 2026-08-21** — the first-party
   surface keeps widening. (New fact; postdates our earlier field study.)

## The unoccupied niche — and we are already sitting on it

The search found **no UE plugin doing geologically or physically simulated
world generation** — tectonics, hydrology-driven erosion, climate. Everyone in
this market is scatter-and-place.

Hayba has a tectonic/erosion/climate simulation stack (split out to
`hayba-explorer`). Nobody in the UE plugin market has anything comparable, and
nobody appears to be building it. **"Simulated worlds, not scattered ones" is
an available position with a real technical barrier** — and it is the one
claim in this space that a name-matcher cannot answer.

That is a strategic option to weigh deliberately, not a decision to make
casually: it would mean reconnecting a stack that was deliberately separated.

## Long-term threat vector

**Tencent HY-World 2.0** emits persistent meshes, 3D Gaussian splats and point
clouds that drop into UE — i.e. *actually generated geometry* rather than
scatter. When that class of model matures, the name-matcher approach is
obsoleted, and so is any pipeline that assumes a pre-existing library.

## Adjacent competitors found

- **Ultimate Engine CoPilot** (Fab) — closest head-to-head: NL → Blueprints,
  animations, materials, Niagara, Sequencer, UMG, **PCG worlds**, behavior
  trees.
- Asset-gen feeding UE rather than driving it: Meshy, Tripo, **3D AI Studio**
  (advertises **remesh/retopo** — the import-hygiene step Nwiro does not).
- Layer AI (2D/environment variation art).

## Open questions worth closing

1. Fab blocks automated fetch — the real review count/text is unverified.
2. Windows-only (docs) vs Windows+macOS (marketing) — vendor contradicts itself.
3. **Import hygiene for Meshy/Tripo output** — LOD, collision primitives,
   retopo, material setup are undocumented; likely absent. If so, that is a
   concrete, ownable gap for us.
4. Per-credit action costs.
5. The YouTube hands-on reviews were not transcribed — the demonstrated
   failure modes on video are the highest-value unexamined source available.
