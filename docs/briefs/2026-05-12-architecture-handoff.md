# Architecture / Settlements Branch — Claude Handoff Brief

You're picking up the **architecture pillar** of Hayba, a worldbuilding platform for AAA game devs / 3D artists / rigorous worldbuilding authors. Hayba is an open-core MIT plugin (UE5) + cloud SaaS, positioned as "the only AI worldbuilding tool grounded in real planetary science."

The platform has several pillars (tectonics, climate, biome, architecture, linguistics, history-sim, etc.). Other Claude instances are already working **tectonics** (live) and **linguistics** (live); you've been handed **architecture**.

## What the architecture pillar does

End-to-end procedural built environment, from individual buildings through cities to road networks, with style consistent within a culture / region / era. Two audience tiers:

- **Game devs** want: place a "Tang-dynasty merchant town" or "medieval Hanseatic harbor city" by clicking a region on the map; get a full layout (roads, districts, building footprints, style guides) that can be tessellated into UE5 actors. Pareto-relevant 80%.
- **Authors / city-sim hobbyists** want: emergent diachronic growth — pick a founding date and let the settlement evolve through centuries (founding → market town → walled city → industrial sprawl), retaining old core street patterns as concentric rings. Pareto-relevant 20%, but the positioning differentiator.

Locked decisions you should treat as constraints:

1. **Tiered depth**: ship the game-dev floor first (snapshot generation: pick culture + era + size → get a city); expose author features behind the same data model (diachronic growth, demolition, war damage layers).
2. **Visual style guides, not raw rules**. Style is captured by a palette of building archetypes (materials, roof shape, footprint typology, story height, ornamentation) + a road grammar (street width hierarchies, intersection types). Users edit by dragging archetypes on a panel; AI fills the rest.
3. **AI is constrained by deterministic generators**. The LLM never produces buildings that violate the style guide's archetype palette; constrained decoding gates the output. The LLM's job is choosing WHICH archetypes go where, not inventing geometry.
4. **Integration with other pillars** (you don't own these, you consume them):
   - **Terrain** (from tectonics + hydrology): settlements respect rivers, slope, soil, defensive geometry. Read elevation + drainage from the tectonic output.
   - **Climate** (from tectonics M5): vernacular architecture follows climate — pitched roofs in snow zones, courtyards in arid, stilts in floodplains.
   - **Linguistics** (from linguistics pillar): place names, street names, signage all sourced via the linguistics MCP tools.

## What's already in place

### Code scaffold
None yet — start `packages/architecture/` as a TypeScript package, ESM, vitest-based. Pattern after `packages/linguistics/`.

### Shared infra (don't reinvent)

- **Deterministic seeds**: use the existing `hayba-seeds` Rust crate via Node IPC or port its SplitMix64 algorithm to TypeScript. Pattern: master seed → scope-derived child seed → per-region sub-seed → per-settlement sub-seed → per-building sub-seed. Same `(master, region_id, "settlement", index, "building", index)` tuple → same building forever. Reference: `packages/hayba-seeds/src/lib.rs`.
- **Schema spine**: Postgres + pgvector hosted on Supabase (free tier). Other pillars use similar tables; follow their conventions.
- **MCP server**: `packages/hayba/src/index.ts` is the Node MCP server entry. Add your tools alongside existing ones, prefix `architecture_*` (e.g. `architecture_generate_settlement`, `architecture_style_palette`, `architecture_road_network`).
- **Determinism contract**: every public API is a pure function of `(master_seed, params)`. No `Date.now()`, no `Math.random()`. Bit-exact across runs on a single machine.

### Reference data to draw from (all CC-licensed)

- **OpenStreetMap historical layers** — real road network samples for grammar induction
- **Atlas of Urban Form** (digital morphology atlas) — settlement typologies by era/region
- **Wikidata urban heritage** — building materials + period palettes by culture
- **VernacularArchitecture.com**'s public dataset on regional building styles

## What to build (open GitHub issues — full text on GH)

Listed in priority order. Each is independent and shippable.

### A1 — Archetype palette + style guide schema
Define the data model: an `ArchetypeBuilding` (footprint shape, story count, material set, roof type, ornamentation tags) and `StyleGuide` (set of archetypes + selection weights). Provide seed palettes for 6 reference cultures (Mediaeval-European, Tang-Chinese, Pre-Columbian-Andean, Sub-Saharan-Hausa, Edo-Japanese, Industrial-Revolution-English). MCP tool `architecture_list_style_guides`.

### A2 — Road network generator
Generate a road graph for a given settlement footprint + terrain. Implement L-system or recursive subdivision producing realistic street hierarchies (arterials → collectors → locals). Respect terrain slope (avoid >15% grade for primary roads). MCP tool `architecture_generate_road_network` returning a polyline graph.

### A3 — Settlement layout generator
Take a region polygon + style guide + target population → place road network + parcel grid + lot assignments → bind archetypes to lots. MCP tool `architecture_generate_settlement`. Emit GeoJSON of buildings + roads.

### A4 — Vernacular constraint engine
Climate × material gating. Pitched roofs in snow zones; courtyards in arid; stilts in floodplains. Reads climate envelope from tectonics M5 output. MCP tool `architecture_check_vernacular_consistency`.

### A5 — Diachronic settlement growth
Take a settlement at founding date + style guide changes over time → evolve concentric ring structure across centuries. Old core street patterns retained; outer rings reflect later style guides. MCP tool `architecture_evolve_settlement`.

### A6 — Building 3D geometry emitter
Take an archetype + lot → output a parameterized geometry description (heights, openings, roof apex) suitable for UE5 PCG / Houdini to instantiate. MCP tool `architecture_emit_building_geometry`.

### A7 — Place-name binding (linguistics integration)
Bind street names + district names + building names via the linguistics pillar's `language_generate_name` tool. Per-settlement consistent naming language. MCP tool `architecture_assign_names`.

### A8 — Demo viewer
Mini browser viewer (analogous to `viz/index.html`) that renders an L4 settlement: roads + parcels + building footprints in plan view. Plate is the area of validation.

## How to coordinate

- Open issues on the `zajalist/hayba` repo with `branch: architecture, area: typescript, enhancement` labels. The other pillars use parallel `branch:` labels.
- Don't push to `feat/mcp-stabilization` (the tectonics branch). Create `feat/architecture-pillar` or similar.
- The tectonics + linguistics instances may surface integration questions; thread them via issue comments rather than direct merges.

## Spec / constraints summary

- **MIT license**, no GPL deps. Style-guide JSON is the user's IP, not yours; treat it as data.
- **Deterministic from seed.** No exceptions. Bit-exact within a single machine.
- **Pure functions** at the MCP boundary. No global state.
- **Tested.** vitest, ≥80% coverage on the deterministic generators.
- **Visual checkpoint mandatory** for any visible output ticket — settlement viewer must render real output before claiming a ticket done.
