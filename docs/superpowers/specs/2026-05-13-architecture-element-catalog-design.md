# Architecture Pillar — Element Catalog + AI Binding Pipeline

**Date**: 2026-05-13
**Status**: Draft — awaiting spec-review gate
**Pillar**: Architecture (`@hayba/architecture`)
**Branch**: `feat/architecture-pillar`
**Builds on**: A1 (#101) — Typology / StyleSheet / StyleGuide schema (shipped)
**Relates to**: A6 (#106) — *replaces* A6's whole-building geometry framing with atomic-element generation (see Scope clarification below)

## Goal

Build a deterministic **parametric element catalog** that generates atomic 3D architectural pieces — columns, cornices, arches, finials, friezes — from culturally-grounded SVG profiles plus numeric parameters. Pair it with an **AI binding pipeline** where a language model emits the SVG + numbers for each `(style sheet × element)` pair, a validator firewalls non-deterministic AI output into bit-reproducible `ElementBinding` JSON, and an in-browser kernel renders glTF meshes. Whole-building 3D assembly is out of scope; downstream tools (UE5 PCG, Houdini, the user's own scene) consume the catalog.

## Why this shape

The contemporary AI-3D landscape (per the 2026 research the user shared) consistently shows that direct text-to-mesh diffusion produces topologically broken, baked-lighting, poorly-UV'd output unsuitable for AAA pipelines. The state-of-the-art alternative — Houdini Vitruvius, UE5 PCG, FutureCAD — is "AI emits *parameters or programs*; deterministic engine executes geometry." This spec is that pattern, specialized to architecture and intentionally narrowed to atomic elements (the part where cultural identity actually lives — Gothic columns, Tang dougong brackets, Hausa tubali pinnacles read instantly as their culture, while the boxy walls between them are mostly interchangeable).

Narrowing to atomic elements means:

- The engine is small and provable (~7 geometric primitives + transforms).
- Each element type has a hand-authored generator function — totally testable.
- AI's surface is "emit SVG + numbers" — a native LLM skill needing zero fine-tuning.
- The deliverable plugs into any DCC tool the user already has; we don't try to be the assembly system.

## Scope

**In scope:**
- 10 atomic element types (column, cornice, arch, doorframe, windowframe, lintel, finial, frieze panel, pediment relief, niche/corbel).
- Per-element TypeScript generator functions composing the kernel primitives.
- 7 kernel primitives (extrude, revolve, sweep, loft, boolean, instance, transform) plus SVG profile parsing and glTF emission.
- AI binding pipeline: prompt → SVG + numbers → validator → committed `ElementBinding` JSON.
- 7 new MCP tools.
- Editor surfaces in the existing atlas: Elements tab, binding inspector, binding section on style-sheet detail pages.
- BYOK provider config (env-var keys; user pastes via settings panel).
- Reference image upload (prompt anchoring only — not blended into output meshes).

**Out of scope (deferred / handled elsewhere):**
- Whole-building 3D assembly — that's the consumer's job (UE5 PCG, Houdini, custom scene).
- In-browser SVG editor — round-trip via file download/upload to Inkscape or similar.
- Visual node-graph editor — element graphs are TypeScript code in v0.
- Region selection on a planet surface — blocked on tectonics.
- Timeline / diachronic phase editing — blocked on A5 (#105).
- Structural members beyond lintel (joists, rafters, posts) — v1.
- Surface repeatables (bricks, tiles, shingles) — v1, lives with UE5 PCG integration (A6 successor).
- Stair treads, balustrades, ridge tiles, battlements — v1.
- Local LLM provider (Ollama / llama.cpp) — v1.
- Cross-machine bit-exact GLB output — v0 asserts within-machine bit-exactness only.

## § 1 — Schema additions

Three new artifacts join the existing Typology / StyleSheet / StyleGuide:

```ts
// What the engine generates — an atomic 3D piece.
export interface Element {
  id: string;                              // 'column' | 'cornice' | 'finial' | 'arch' | ...
  category: 'connector' | 'ornament';
  graph: ElementGraphRef;                  // points to a hand-authored generator function in kernel/elements/<id>.ts
  profileSlots: readonly ProfileSlot[];    // named SVG-input plug-points (AI or human fills these)
  paramSchema: readonly ParamSlot[];       // named numeric/enum params with declared ranges
}

export interface ProfileSlot {
  name: string;                            // 'shaft' | 'base' | 'capital' | 'ornament-front-view'
  description: string;                     // human-readable, feeds the AI prompt
  hint: 'closed-path' | 'open-path' | 'symmetric-half' | 'tileable';
  bbox?: readonly [number, number, number, number];  // optional viewBox the profile must fit
}

export interface ParamSlot {
  name: string;
  kind: 'number' | 'integer' | 'enum';
  range?: readonly [number, number];       // for number/integer
  choices?: readonly string[];             // for enum
  default: number | string;
}

// AI's deliverable for one Element in one StyleSheet:
export interface ElementBinding {
  elementId: string;
  styleSheetId: string;
  seed: bigint;
  profiles: Readonly<Record<string, string>>;            // profileSlot.name → SVG string
  params:   Readonly<Record<string, number | string>>;
  provenance: {
    source: 'ai' | 'human';
    aiProvider?: 'anthropic' | 'openai' | 'fal' | 'local';
    aiModel?: string;
    promptHash?: string;
    createdAt: string;                                   // ISO 8601
    referenceImageHashes?: readonly string[];
  };
}

// Type-level reference; resolves to a kernel function at load time.
export type ElementGraphRef = { kind: 'kernel-fn'; module: string; export: string };
```

**Key shape decisions:**

- `Element` is the *type definition*; `ElementBinding` is one *instantiation* of that type for a specific style sheet. Same element type → many bindings (one per style sheet that uses it). Mirrors how Typology + StyleSheet decouple structure from cosmetic in A1.
- `graph` is a *reference to a TypeScript function* in the engine kernel, not data. One hand-authored function per element type (10 functions for v0). Determinism is enforced by the function being pure.
- `profileSlots` is the AI plug-in surface — each slot is one piece of SVG the AI emits. `hint` constrains the shape (closed for revolve sources, tileable for repeat patterns, etc.).
- `paramSchema` is the numeric AI surface; the validator catches out-of-range AI output.
- `ElementBinding` is the *only* thing stored per style-sheet × element pairing. Style sheets reference their bindings; the engine consumes bindings to produce meshes.

## § 2 — Engine kernel

A tiny TypeScript module that takes an `Element` + `ElementBinding` and emits a triangle mesh. ~7 primitive operations + transform composition. Pure functions. No deps for the math; three.js only for the GLTF emitter.

```ts
// Geometric primitives — every element graph is a tree of these.
extrude(profile: SvgPath, axis: Vec3, length: number): Mesh
revolve(profile: SvgPath, axis: 'Y' | 'X' | 'Z', segments: number, sweep_deg: number): Mesh
sweep(profile: SvgPath, path: SvgPath): Mesh                  // profile follows a 2D path
loft(profiles: SvgPath[], positions: Vec3[]): Mesh            // interpolate between N profiles
boolean(a: Mesh, b: Mesh, op: 'union' | 'subtract' | 'intersect'): Mesh
instance(mesh: Mesh, transforms: Mat4[]): Mesh                // arrays / grids
transform(mesh: Mesh, m: Mat4): Mesh                          // translate / rotate / scale

// Support functions.
parseSvgProfile(svg: string, slotHint: ProfileSlot['hint']): SvgPath
emitGLB(mesh: Mesh): ArrayBuffer
toPCGGraph(element: Element, binding: ElementBinding): PCGGraphJson   // UE5 export, v1
```

**Hand-authored generator example** (column.ts):

```ts
export function columnGraph(b: ElementBinding): Mesh {
  const shaft  = revolve(parseSvgProfile(b.profiles.shaft,  'symmetric-half'),
                         'Y', 32, 360);
  const base   = revolve(parseSvgProfile(b.profiles.base,   'symmetric-half'),
                         'Y', 32, 360);
  const cap    = loft([parseSvgProfile(b.profiles.capital_bottom, 'closed-path'),
                       parseSvgProfile(b.profiles.capital_top,    'closed-path')],
                      [{x:0,y:0,z:0}, {x:0,y: Number(b.params.capital_height_m), z:0}]);
  return transform(
    boolean(boolean(base, transform(shaft, translateY(Number(b.params.base_height_m))), 'union'),
            transform(cap, translateY(Number(b.params.base_height_m) + Number(b.params.shaft_height_m))), 'union'),
    identity()
  );
}
```

The graph is **code**, not data — fully testable, debuggable, type-checked. AI never writes graph code; AI only fills `b.profiles` and `b.params`.

**Library choice:** [`three-bvh-csg`](https://github.com/gkjohnson/three-bvh-csg) (MIT, mature, deterministic) for boolean ops. Everything else hand-rolled.

## § 3 — AI surface

The AI's contract is narrow: **emit an `ElementBinding` for a given `(elementId, styleSheetId)` pair.** No graph authoring, no 3D, no mesh output — only SVG profiles + numbers.

```ts
interface BindingRequest {
  elementId: string;
  element: Element;
  styleSheet: StyleSheet;
  referenceImages?: string[];
  seed: bigint;
}

interface BindingResponse {
  binding: ElementBinding;
  rationale?: string;
}

interface AIProvider {
  name: 'anthropic' | 'openai' | 'fal' | 'local';
  generate(req: BindingRequest): Promise<BindingResponse>;
}
```

**Prompt structure** (system fixed, user assembled per request):

```
SYSTEM: You generate architectural element profiles as SVG. For each named profile slot,
emit a single <svg> with one <path> matching the hint (closed-path / symmetric-half / etc.).
Coordinates in millimeters, viewBox provided. Return strict JSON:
  { profiles: {...}, params: {...}, rationale: "..." }.
No mesh, no 3D, no commentary outside JSON.

USER: Element: column. Style sheet: medieval-european-gothic (1140–1400).
Primary material: stone. Roof type: gable.
Ornamentation pool: pointed-arch, flying-buttress, rose-window, gargoyle.

Required profile slots:
  - shaft  (symmetric-half, viewBox 0 0 200 1000): vertical half-profile.
  - base   (symmetric-half, viewBox 0 0 300 80):   plinth + torus + scotia.
  - capital_bottom (closed-path, viewBox -100 -100 200 200): top-of-shaft cross-section.
  - capital_top    (closed-path, viewBox -150 -150 300 300): under-abacus cross-section.

Required params:
  - base_height_m    (number 0.05–0.5)
  - shaft_height_m   (number 1.5–8.0)
  - capital_height_m (number 0.1–0.8)
  - capital_flare    (number 0.0–1.0)
```

**Default provider:** Anthropic Claude Haiku 4.5 (cheap, fast, exceptional at structured JSON with embedded SVG). Users can swap to OpenAI / FAL via the settings panel.

**Validation gate (the deterministic firewall):**

```ts
function ingestAIBinding(element: Element, response: BindingResponse, seed: bigint): ElementBinding {
  // 1. JSON shape check.
  // 2. Every required profile slot present, SVG parses, hint matches.
  // 3. Every required param present + in declared range.
  // 4. SVG canonicalization: simplify paths, round coords, dedupe.
  // 5. Stamp seed + provider + model + timestamp into provenance.
  // → On failure: structured errors; caller retries (up to 2 times) with error list in follow-up prompt.
  // → Third failure: surface raw output for human edit.
}
```

**Determinism caveat:** AI calls are non-deterministic. Once a binding is `accept`-ed, the engine half is deterministic forever — same binding → byte-identical mesh.

## § 4 — Storage layout

```
packages/architecture/src/
├── data/
│   ├── typologies.json                      # existing
│   ├── style-guides/                        # existing
│   └── elements/                            # NEW
│       ├── column.json                      # Element type definitions
│       ├── cornice.json
│       └── ... (10 files, one per element type)
│
├── bindings/                                # NEW — committed AI outputs
│   ├── medieval-european-gothic/
│   │   ├── column.json
│   │   └── ...
│   └── ... (one folder per style sheet)
│
└── kernel/                                  # NEW — engine code
    ├── primitives.ts
    ├── svg-parse.ts
    ├── glb-emit.ts
    ├── pcg-emit.ts                          # UE5 export, v1
    └── elements/                            # one TS file per element type
        ├── column.ts
        └── ...

packages/architecture/user-refs/             # NEW — gitignored upload landing
└── <styleSheetId>/<elementId>/<filename>
```

**Why bindings are committed to git:**

- A binding is the *deterministic input* to the engine. Deleting it means you can't re-derive the same mesh from a fresh AI call.
- Bindings are small (~5–30 KB each). 11 style sheets × ~10 elements × ~15 KB ≈ 2 MB worst case.
- Provenance lives in each binding for audit / replay.

## § 5 — V0 element list

| # | Element | Category | Kernel ops | Cultural variation lives in… |
|---|---|---|---|---|
| 1 | column | connector | revolve + loft + boolean | shaft profile (fluting, taper); capital silhouette |
| 2 | cornice | connector | sweep | the SVG profile — entire personality of the culture |
| 3 | arch | connector | extrude + boolean | arch curve SVG (round, pointed, horseshoe, ogee, trabeated) |
| 4 | doorframe | connector | extrude + boolean | surround profile + lintel detail |
| 5 | windowframe | connector | extrude + boolean | profile + mullion pattern (tracery / lattice) |
| 6 | lintel | connector | extrude | cross-section (timber / stone / corbel / dougong bracket) |
| 7 | finial | ornament | revolve OR extrude+boolean | front-view SVG, then revolve or biaxial extrude |
| 8 | frieze panel | ornament | extrude + instance | relief profile + repeat unit SVG |
| 9 | pediment relief | ornament | extrude | gable/pediment fill SVG (Gothic cross, Tang ridge-beast, Edo gegyo) |
| 10 | niche / corbel | connector | extrude + boolean | niche shape (Andean trapezoidal, Gothic round-headed, Tang dougong jut) |

**Realistic binding count for v0**: ~70–90 hand-curated `ElementBinding` JSON files (10 elements × 11 style sheets = 110 max, minus ~25–40 unused pairings where the culture doesn't use that element).

## § 6 — Editor UI surface for v0

Three additions to the existing atlas:

### (a) "Elements" tab — element-catalog browser

Three-pane: left rail (10 thumbnails) → element type detail (slot vocabulary, params, link to kernel TS file) → binding matrix (11 style sheets × this element, click cell to open binding detail).

### (b) Binding detail panel — per (style sheet × element)

Two columns: 3D preview (three.js orbit viewer, GLB download, future PCG export button) | AI-generated profiles (each SVG rendered, parameter sliders, Regenerate / Accept / Discard, Upload references). Provenance footer shows AI model + prompt hash + seed.

### (c) Style-sheet detail extension

A new "Bound elements" panel on each style-sheet's existing detail page, showing thumbnails of all 3D elements bound for that style sheet. Empty slots get a `[+ Generate]` CTA.

**Explicitly NOT in v0:** in-browser SVG editor (round-trip via file download), node-graph editor (graphs are TS code), region picker (blocked on tectonics), timeline phase editor (blocked on A5), UE5 PCG export button (kernel stub exists, wire format deferred to A6 successor).

## § 7 — MCP tool surface additions

Seven new tools added to `packages/hayba/src/tools/index.ts`:

```ts
architecture_list_elements(): { elements: Array<{ id, category, slotCount, paramCount }> }

architecture_get_element({ id }): { element: Element } | { error: 'not_found', id }

architecture_list_bindings({ styleSheetId }): {
  bindings: Array<{ elementId, provenanceSource, createdAt }>
}

architecture_get_binding({ styleSheetId, elementId }): {
  binding: ElementBinding
} | { error: 'not_found', styleSheetId, elementId }

architecture_generate_binding({
  styleSheetId, elementId, seed?, provider?, model?, referenceImagePaths?
}): {
  draft: ElementBinding,
  validation: { ok: true } | { ok: false, errors: ValidationError[] },
  retriesUsed: number
} | { error: 'ai_failed' | 'unknown_style' | 'unknown_element', message }

architecture_accept_binding({ binding }): {
  ok: true, writtenPath: string
} | { ok: false, errors: ValidationError[] }

architecture_emit_element_mesh({ styleSheetId, elementId, format? }): {
  format: 'glb' | 'gltf-json',
  bytesBase64: string,
  stats: { triangles, vertices, sizeBytes },
  bindingProvenance: ElementBinding['provenance']
} | { error: 'not_found' | 'kernel_error', message }
```

| Tool | Deterministic |
|---|---|
| `list_elements`, `get_element` | ✅ |
| `list_bindings`, `get_binding` | ✅ |
| `accept_binding`, `emit_element_mesh` | ✅ |
| `generate_binding` | ❌ — clearly labeled |

**Provider keys (BYOK):** server reads `HAYBA_ANTHROPIC_API_KEY` / `HAYBA_OPENAI_API_KEY` / `HAYBA_FAL_API_KEY` from env. No keys → `generate_binding` returns `{error: 'ai_failed', message: 'no API key configured for provider X'}`.

**Mesh transport:** GLB bytes returned base64-inline (atomic meshes are ~5–50 KB, fits in an MCP response).

## § 8 — Determinism contract

```
   non-deterministic            │            deterministic
   ──────────────────────       │       ──────────────────────
   AI provider call             │       Engine kernel
   (LLM, image-gen, user upload)│       (extrude / revolve / sweep / etc.)
            │                   │            │
            ↓                   │            ↑
   Validator + canonicalizer  ──┼──→  ElementBinding (the firewall)
                               │
                            committed
                          to bindings/
```

**Seed derivation:**

```
master_seed
  → deriveSeed(m, 'architecture')                       = pillar seed
    → deriveSeed(p, styleSheetId)                        = style seed
      → deriveSeed(s, elementId)                         = ElementBinding.seed
        → deriveSeed(e, primitiveOpName, opIndex)        = per-op sub-seed
```

Reuses the existing SplitMix64 + `deriveSeed` from `packages/architecture/src/rng.ts` (port from `hayba-seeds` Rust crate, mirrors A1 design).

**Bit-exactness scope:**

- **Within a single machine + same Node version:** byte-identical GLB output guaranteed and tested.
- **Across machines (different CPUs/OSes, same Node major):** byte-identical *expected* but not guaranteed by V8's IEEE-754 transcendentals; v0 cross-machine assertion is mesh equivalence (max-vertex-delta < 1e-9) rather than byte equality.
- **Cross-runtime (Bun, etc.):** out of scope.

**Determinism test suite:**

```ts
// 1. Round-trip
expect(byteEquals(emitMesh(b), emitMesh(b))).toBe(true);
// 2. No hidden state
loadCatalog(); const m1 = emitMesh(catalog, b);
loadCatalog(); const m2 = emitMesh(catalog, b);
expect(byteEquals(m1, m2)).toBe(true);
// 3. Seed isolation
expect(byteEquals(emitMesh({...b, seed:1n}), emitMesh({...b, seed:2n}))).toBe(false);
// 4. Binding is the only deterministic input
expect(byteEquals(emitMesh(b), emitMesh({...b, profiles: {...b.profiles, shaft: '<svg>...'}}))).toBe(false);
```

**AI provenance:** stored for audit, not for reproducibility. Same prompt + same model + same seed does NOT guarantee the same SVG. The binding itself is the source of truth.

**"Regenerate" semantics:** old binding is moved to `bindings/<styleSheet>/<elementId>.history/<timestamp>.json`; new binding takes its place. Meshes produced from the old binding remain reproducible from the history file.

## Risks

- **Boolean op fragility.** CSG via `three-bvh-csg` is mature but can produce degenerate meshes when input geometries are nearly co-planar or self-intersecting. Mitigation: validate SVG profiles before extrusion (snap to grid, simplify, dedupe); run a post-extrude mesh validator before emitting GLB; surface failures as kernel errors rather than silent bad meshes.
- **AI SVG quality drift across models.** Different models emit different SVG styles. Provenance pins the model id; if an org-wide rebind is wanted later, the trigger is explicit (delete bindings folder, re-run generate_binding sweep).
- **Determinism across Node versions.** V8 transcendental functions can produce different low bits across major versions. v0 pins to a Node major (≥24) in package.json `engines`; any future bump requires re-running the determinism test suite.
- **Storage bloat from history.** Binding history accumulates over time. Mitigation: cap history at 10 entries per binding; older history files moved to a periodic cleanup tool. Not built in v0, but the directory scheme supports it.
- **Reference-image IP.** User-uploaded images stay local (gitignored); not blended into output meshes; their hashes (not contents) appear in provenance. Avoids the "scraped art LoRA" liability the Gemini research flagged.
- **Cross-pillar coupling on rng.** A1 deferred the SplitMix64 port from `hayba-seeds`. This spec depends on it. If the port slips, seed derivation falls back to a deterministic FNV-1a hash chain (less elegant but functionally equivalent).

## Definition of done

- [ ] `packages/architecture/src/data/elements/*.json` — 10 element type definitions, all validate.
- [ ] `packages/architecture/src/kernel/primitives.ts` + supporting files — 7 primitives implemented and unit-tested.
- [ ] `packages/architecture/src/kernel/elements/*.ts` — 10 generator functions, one per element type, each with at least one happy-path test.
- [ ] AI binding pipeline: `generate_binding` round-trips with Anthropic Claude Haiku 4.5 default.
- [ ] Validator firewall: out-of-range params / malformed SVG / missing slots all caught with JSON-pointer error paths.
- [ ] Determinism test suite: round-trip, no-hidden-state, seed-isolation, binding-is-input — all green.
- [ ] 7 new MCP tools registered in `packages/hayba/src/tools/index.ts`.
- [ ] Atlas editor: Elements tab + binding inspector + style-sheet integration land and screenshot-validate.
- [ ] vitest ≥80% on kernel (`primitives.ts`, `svg-parse.ts`, `glb-emit.ts`) and ≥70% on per-element generators (the rest is structural code).
- [ ] At least 10 fully-bound `(styleSheet, element)` pairs hand-curated and committed (one element across all 11 sheets is fine; or one sheet across all 10 elements). Proves the pipeline end-to-end.
- [ ] Visual checkpoint: every committed binding renders without kernel errors in the atlas's binding inspector; screenshots captured and attached to the implementation PR.

## Open questions for follow-up

- **UE5 PCG export wire format.** The `toPCGGraph` function is stubbed in v0. Real export needs a UE5-side ingestion of the JSON. Lives with the A6 successor ticket.
- **Cache strategy for emitted meshes.** v0 regenerates GLB on every MCP call (cheap for atomic meshes). If a real download manager wants caching, we'd add `~/.cache/hayba-architecture/meshes/<bindingHash>.glb` and a `--no-cache` flag.
- **Local LLM (Ollama) provider.** Plumbing is straightforward; deferred to v1 to keep v0 dependency surface small.
- **Reference-image style-anchor strategy.** v0 passes uploaded images as URLs in the prompt (model-dependent — Claude/GPT-4o/Gemini all accept images natively). For models without vision support, we'd need to describe the image first via a captioner. Deferred.
- **A6 succession.** This spec materially supersedes A6 (#106). Recommend either closing #106 and opening a new "A11 — Element catalog + AI binding pipeline" issue, or rewriting #106's body to match this spec. To be decided in the spec-review step.
