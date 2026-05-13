# Architecture Pillar — A1 Style Schema Design

**Issue**: [#101 — A1 Archetype palette + style guide schema](https://github.com/zajalist/hayba/issues/101)
**Epic**: [#109 — Architecture pillar](https://github.com/zajalist/hayba/issues/109)
**Date**: 2026-05-12
**Status**: Draft, awaiting spec-review gate

## Context

A1 is the foundation of the architecture pillar. Every downstream ticket (A2–A8) consumes the schema and the seed palettes it defines. This spec captures the data model, storage, MCP surface, and testing strategy.

The design follows an architectural-research recommendation surfaced during brainstorming: **structural topology is decoupled from morphological style**. A building on a lot is the binding `(typology, styleSheet, era, seed) → building`, late-bound at generation time. This avoids the combinatorial explosion of baking culture × era × function into single archetypes (6 × 4 × 10 = 240 hand-authored archetypes the wrong way).

## Schema artifacts

Three TypeScript types in `packages/architecture/src/schema.ts`. Plain interfaces — no Zod, no runtime dependency. Validation is hand-rolled type guards, mirroring `packages/linguistics/`.

```ts
export type FeatureBundle = Readonly<Record<string, string | readonly string[]>>;

export type RoofType =
  | 'gable' | 'hip' | 'flat' | 'pagoda' | 'thatch' | 'dome' | 'shed' | 'mansard';

export type PrimaryMaterial =
  | 'stone' | 'timber' | 'mudbrick' | 'adobe' | 'rammed-earth'
  | 'brick' | 'concrete' | 'wattle-daub';

export type FootprintShape =
  | { kind: 'rectangle';    aspectRatio: [number, number];           areaRange: [number, number] }
  | { kind: 'linear-row';   widthRange: [number, number];            depthRange: [number, number] }
  | { kind: 'L-shape';      wingDepth: [number, number];             courtyardFraction: [number, number] }
  | { kind: 'U-shape';      wingDepth: [number, number];             openingWidth: [number, number] }
  | { kind: 'courtyard';    courtyardFraction: [number, number];     wingDepth: [number, number] };

export interface Typology {
  id: string;
  footprint: FootprintShape;
  storyRange: [number, number];
  fenestrationDensity: [number, number];
  pathfindingHints?: Readonly<Record<string, string>>;
}

export interface StyleSheet {
  id: string;
  cultureId: string;
  dateRange: [number, number];
  core: {
    primaryMaterial: PrimaryMaterial;
    secondaryMaterial?: PrimaryMaterial;
    roofType: RoofType;
    ornamentation: readonly string[];
  };
  extras: FeatureBundle;
}

export interface StyleGuide {
  id: string;
  styleSheet: StyleSheet;
  typologyWeights: ReadonlyArray<{ typologyId: string; weight: number }>;
}
```

### Design choices, with rationale

- **Hybrid typed-core + open `extras` bundle (on `StyleSheet`).** A finite enum core (`roofType`, `primaryMaterial`) makes LLM-constrained decoding in A3 cheap and testable. The open `extras` bundle absorbs culture-specific concepts (engawa, tokonoma, riad, kancha) without forcing schema churn for every new culture.
- **Footprint as a discriminated union of 5 kinds.** `rectangle | linear-row | L-shape | U-shape | courtyard`. Each kind gets its own deterministic generator in A3. The `compound` kind (Hausa Zaure, nomadic enclosure rings) is deferred — Hausa palette temporarily uses `courtyard` plus `extras.multiBuilding = 'true'` so the data is preserved.
- **Era is a `dateRange` field on `StyleSheet`**, not a separate artifact. A5 resolves `(cultureId, year) → StyleSheet` by range lookup. Tiebreaker on overlapping ranges within a culture: **highest `endYear` wins** (most recent style sheet for the year).
- **`StyleGuide` embeds `StyleSheet` by value** so MCP consumers get a self-contained payload in one round trip. The 18 seed sheets dedupe at authoring time, not at the MCP boundary.

### Invariants enforced by validators

- For every `[min, max]` tuple: `min ≤ max`.
- `weight > 0` for every entry in `typologyWeights`. Weights are unnormalized positive reals; A3's sampler normalizes per call. A1 makes no assumption that they sum to anything in particular.
- Every `typologyId` referenced from any StyleGuide resolves in the typology registry.
- Within a `cultureId`, `dateRange`s may overlap; tiebreaker is `endYear` desc.
- No RNG anywhere in A1. Pure data + pure functions.

## Storage layout

```
packages/architecture/
├── package.json            # @hayba/architecture, type:module, vitest, MIT
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts            # public re-exports
│   ├── schema.ts           # interfaces above
│   ├── validate.ts         # hand-rolled type guards
│   ├── registry.ts         # load + cache typologies and style guides
│   ├── mcp.ts              # MCP tool implementations
│   └── data/
│       ├── typologies.json
│       └── style-guides/
│           ├── medieval-european-carolingian.json
│           ├── medieval-european-romanesque.json
│           ├── medieval-european-gothic.json
│           ├── tang-chinese-7c.json
│           ├── tang-chinese-9c.json
│           ├── andean-inca.json
│           ├── andean-pre-inca.json
│           ├── hausa-classical.json
│           ├── edo-japanese-early.json
│           ├── edo-japanese-late.json
│           └── industrial-revolution-english.json
```

### Typology registry (v0, ~10 entries)

`peasant_home, townhouse, market_stall, manor, temple, granary, watchtower, walled_palace, workshop, civic_hall`. Each is **culture-agnostic** by design: a `peasant_home`'s footprint is the same dressed in Mediaeval-European or Edo-Japanese — cultural feel comes entirely from the StyleSheet swap and the per-typology weights in each StyleGuide.

### Seed StyleGuides (v0, 11 entries)

Roughly one per era for each of the 6 cultures from the handoff brief. Each guide's `typologyWeights` reflects what the culture/era actually built — Andean-Inca weights `temple` / `granary` / `walled_palace` heavily; Industrial-Revolution-English weights `townhouse` / `workshop` / `civic_hall`.

### Reference data for authoring (all CC-licensed)

- **Atlas of Urban Form** — typology lists, ratios per era.
- **Wikidata urban heritage** — `P186 material used`, `P31 architectural style` per culture.
- **VernacularArchitecture.com** — public regional styles dataset.
- **Christopher Alexander's *A Pattern Language*** (253 patterns) — authoring lens for `typologyWeights`. Not encoded as data in v0; cited as inspiration only.

### License & IP

- All seed JSON authored from CC0 / CC-BY sources; no GPL inputs.
- Style-guide JSON is treated as user IP (per A1 acceptance criterion). The package ships seed palettes only as examples; the schema is the product.
- Wikidata: CC0. OSM data: not redistributed.

## MCP tool surface

Four tools, registered alongside existing tools in `packages/hayba/src/index.ts`. All are pure functions of the loaded registry — no I/O, no RNG, no state.

```ts
architecture_list_style_guides(): {
  guides: Array<{
    id: string;
    cultureId: string;
    dateRange: [number, number];
    typologyCount: number;
  }>
}

architecture_get_style_guide(args: { id: string }): {
  guide: StyleGuide;
} | { error: 'not_found'; id: string }

architecture_get_typology(args: { id: string }): {
  typology: Typology;
} | { error: 'not_found'; id: string }

architecture_validate_style_guide(args: { json: unknown }): {
  ok: true;
} | { ok: false; errors: Array<{ path: string; message: string }> }
```

### Behavioural notes

- **`list_style_guides` returns metadata only**, not full guides. Agents call `get_style_guide` for the one they want.
- **`get_typology` lives on its own** so A3/A5/A6 can fetch typologies independently when iterating lots without paying for a whole style guide each time.
- **`validate_style_guide` is the LLM-author surface**. Returns *all* errors for a given input (not first-fail) so an LLM emitting candidate JSON gets the full list in one round trip.
- **No `list_typologies`** in the public surface — the set is small, fixed in code, and the typology IDs in play are visible via every `StyleGuide.typologyWeights`. Cheap to add later if A6/A7 want it.
- **Errors are returned, not thrown** at the MCP boundary. Internal guards throw `ArchitectureSchemaError`; the MCP wrapper maps to `{error: ...}` objects.
- **Deterministic output** — identical inputs produce identical JSON. Object keys insertion-ordered; arrays sorted where order isn't semantic.

## Testing

Vitest, ≥80% coverage on the validators (per A1 acceptance — A1 ships data + schema, no generators yet).

```
src/
├── schema.test.ts          # type-shape assertions, range-tuple invariants
├── validate.test.ts        # the heaviest; covers every guard path
├── registry.test.ts        # all 11 seed StyleGuides + 10 typologies load cleanly
└── mcp.test.ts             # tool contracts: happy, not_found, malformed, determinism
```

### Cases that must pass

- **Determinism**: each MCP tool called twice in sequence produces byte-identical JSON.
- **Cross-pillar contract**: every `typologyId` in every `typologyWeights[]` resolves in the typology registry.
- **Validator surfaces *all* errors**, not first-fail — assert on error-list length, not just truthiness.
- **Range invariants**: malformed `[max, min]` tuples are caught with a JSON-pointer path.
- **Round-trip**: `validate → serialize → parse → validate` returns the same `ok: true` for every seed StyleGuide.

### No visual checkpoint

A1 is data + schema; nothing renders. A8's viewer is where the visual gate kicks in (for A3+).

## Out of scope for A1

Documented here to keep follow-up tickets focused:

- pgvector semantic search (`architecture_search_styles`) — deferred follow-up, depends on Supabase wiring.
- LLM constrained-decoding gating logic — lives in A3's sampler. A1 only provides the palette it gates against.
- Pattern Language as encoded data — authoring inspiration only in v0.
- `compound` footprint kind and `TypologyCluster` multi-building groupings.
- Era as a first-class artifact with named events / rulers / tech levels.
- Building geometry parameters (heights, openings, roof apex) — A6 territory.

## Risks

- **Schema churn from extras drift.** Without a vocabulary registry for `extras` keys, different palettes can use different keys for the same concept (`engawa` vs `verandah`). Mitigation: maintain a free-form glossary doc in `packages/architecture/docs/extras-glossary.md` alongside the seed palettes; promote popular extras keys to typed `core` fields when they generalize. Long-term: consider mapping against Getty AAT.
- **Era tiebreaker ambiguity** when two StyleSheets overlap. Documented rule (highest `endYear` wins) is deterministic but may surprise authors. Mitigation: a registry-load warning when ranges overlap within a culture.
- **Typology registry rigidity.** 10 fixed typologies might not cover every culture cleanly (e.g., Andean storage `qollqa` ≠ generic granary). Mitigation: extras on the typology side is intentionally optional and minimal in v0; revisit once A3 hits real generation.

## Definition of done

Mirrors the acceptance checklist on issue #101:

- [ ] Schema published from `packages/architecture/src/schema.ts`.
- [ ] All 11 seed StyleGuides + 10 typologies validate against the schema and load deterministically.
- [ ] All four MCP tools registered in `packages/hayba/src/index.ts` and exercised by tests.
- [ ] vitest ≥80% on validators; determinism test green.
- [ ] No GPL-licensed inputs in `data/`.
- [ ] `packages/architecture/docs/extras-glossary.md` exists and documents every extras key used by seed palettes.
