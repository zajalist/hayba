# Architecture Pillar — Editor Scope Backlog

**Captured**: 2026-05-13
**Pillar**: Architecture (`@hayba/architecture`)
**Status**: scope notes — not committed plans

Items the user has explicitly flagged as future scope. Each becomes its own spec → plan → implementation cycle when prioritized.

## B1 — PBR texture library integration

**Today**: Material spheres in the atlas use procedural canvas-generated diffuse + normal maps. Quality is adequate as a placeholder; not production-grade.

**Wanted**:
- Scrape free PBR texture libraries (**Polyhaven CC0**, **AmbientCG CC0**, **3DTextures.me CC-BY** with attribution, **Texturelib** non-commercial only — *skip*).
- Match library entries to the 8 schema material names (stone, timber, mudbrick, adobe, rammed-earth, brick, concrete, wattle-daub).
- Store curated subset locally in `packages/architecture/assets/pbr/` (gitignored if large; pulled by an `npm run fetch-pbr` script).
- Material chips + inspector spheres swap to real PBR maps when available, fall back to procedural for materials without a library match.

**Open questions for the brainstorm**:
- Bundle size: real 4K PBR sets are 50–200 MB. CDN-host vs. bundle vs. fetch-on-demand?
- Style consistency: each library has its own photographic style. Curate a single library for v1?
- License compliance: track attribution per-texture in metadata; render attribution in the inspector footer.

## B2 — More texture variants per material

**Today**: One procedural pattern per material name.

**Wanted**: Multiple variants per material (e.g., `stone-weathered`, `stone-polished`, `stone-rough`) so the same culture+era can pick different sub-types for different element instances. Maps to per-binding "material variant" parameter.

**Schema impact**: `ParamSlot` already supports enums; would need a new typed `MaterialVariant` enum per material, OR expand `StyleSheet.core.primaryMaterial` to an object `{ id, variant }`.

## B3 — User-uploaded PBR textures

**Today**: Reference image upload exists in spec but only for AI prompt anchoring, not for direct PBR use.

**Wanted**: When the editor lands, users drop `diffuse.png + normal.png + roughness.png` into the inspector → material applies the user's textures live. Stored in `packages/architecture/user-textures/<styleSheetId>/<materialId>/`.

**Schema impact**: `StyleSheet.core.primaryMaterial` would optionally point to a texture set instead of an enum. Provenance field tracks `{source: 'user-upload', files: [...]}`.

## B4 — Ornament editor

**Today**: Ornament tags are free-string entries in `StyleSheet.core.ornamentation`. Their preview is a procedural pattern matched to a few known names.

**Wanted**: A dedicated **ornament editor** UI letting users:
- Author a new ornament motif by sketching the 2D pattern (SVG path editor in-browser, or drag-drop existing SVG).
- Tag it (carved-relief / engraved / appliqué / colored-inlay).
- Set carving depth, scale, tileability flag.
- Save to a project-scoped ornament library.
- Reuse across style sheets.

**Pipeline once AI lands**: A "Generate ornament" button asks the AI to emit the SVG motif from a prompt like "rose-window-style radial petals, 8-fold symmetric, Gothic-period".

**Schema impact**: New artifact `OrnamentDefinition` (alongside Typology / StyleSheet / Element). The string tags in `core.ornamentation` become references to these.

## B5 — Region-scoped editing

**Blocked on tectonics** — once tectonic output exposes region polygons + biome zones, the editor needs to scope bindings to regions, not the whole project.

## B6 — Diachronic timeline editing

**Blocked on A5 (#105)** — the architecture pillar's differentiator. Editor needs an epoch slider that scrubs through bindings as they evolve over centuries.

---

## Priority signal (rough)

User has flagged all of the above as **wanted, but not blocking**. Order suggested by leverage:

1. **B1 (PBR scrape)** — gives every existing material a real-quality preview immediately. Highest visual ROI for least work.
2. **B4 (ornament editor)** — pairs naturally with AI binding pipeline; both are about user-driven authoring.
3. **B3 (user uploads)** — needs the editor surface to land first.
4. **B2 (variants)** — schema work; nice-to-have once B1 is in.
5. **B5 / B6** — blocked on other pillars.
