# Cognitive Map — Tag-Based Grouping & Color Coding

**Date:** 2026-05-21
**Status:** Approved (brainstorm)
**Touches:** `mcp-tools/hayba-mcp`, `unreal/HaybaMCPToolkit`

## Problem

The Cognitive Map web view (`HaybaMCPSceneMapWebPanel` + `Resources/cognitive-map/index.html`) groups scene cells by a hardcoded `Semantic` enum derived from substring matches on cell labels (`"tree" → forest`, `"building" → urban`). Two failures:

1. **No tags surface in the UI.** Cells render as plain circles with no chips, no per-cell tag readout.
2. **Grouping is wrong.** The substring heuristic produces broken hubs — a lantern goes to `Light` instead of joining the `maritime/dock/props` cluster it actually belongs to.

## Goal

Replace semantic-enum-driven grouping with **actor-tag-driven grouping**, and surface tags directly on each cell as colored chips. Color is deterministic per tag so blue = `maritime` across sessions; recognition becomes free after a few uses.

## Architecture

Three small additions across the existing pipeline — no new processes, no new IPC.

```
[MCP server reindex] ── writes ──> ~/.hayba/cache/retriever-tags.json
                                        │
                                        │ loaded on first scene-map build
                                        ▼
[UE scene-map builder]  reads ──> FHaybaTagIndex (assetPath → tags[])
                                        │
                                        │ aggregates per cell (UE Tags first, retriever fallback)
                                        ▼
[FHaybaCogMapCell.Tags] ── JSON ──> Resources/cognitive-map/index.html
                                        │
                                        │ tag-overrides.json + deterministic hash
                                        ▼
                              cell fill color + tag chip strip
```

### Tag source priority (UE Tags first, retriever fallback)

For each actor in a cell:
1. Read `Actor->Tags` (UE built-in `TArray<FName>`). If non-empty, use it.
2. Else lookup the actor's source asset path in `FHaybaTagIndex`. If found, use its tags.
3. Else contribute no tags.

Aggregation per cell: count tag frequency across all actors, keep top 5 sorted by count (ties broken alphabetically for determinism).

### Color resolution

```
colorForTag(tag):
    if tag in tagOverrides:   return tagOverrides[tag]
    hue = fnv1a32(tag) % 360
    return hsl(hue, 55%, 55%)
```

- `tag-overrides.json` ships with ~15 hand-pinned mappings for the most common worldbuilding tags so they don't drift onto visually-similar hues. Example entries: `maritime → hsl(210, 60%, 50%)`, `foliage → hsl(120, 50%, 45%)`, `urban → hsl(280, 30%, 55%)`.
- Cells with zero tags render in muted gray (`hsl(0, 0%, 60%)`).

### Cell rendering

- **Fill:** `colorForTag(cell.tags[0])` — the mode tag (most common).
- **Chip strip:** rendered below the circle as up to 5 small filled dots (radius 3px) + text label visible on hover. Chip color uses the same `colorForTag` resolver, so a cell with mixed tags shows its mode color and the chip dots reveal the mix.
- **Hub anchors:** the force-layout's clustering "anchor" nodes are now keyed by tag string instead of the old `Semantic` enum value. Cells with the same mode tag gravitate to the same hub.

## Components / file plan

| File | Status | Purpose |
|---|---|---|
| `mcp-tools/hayba-mcp/src/tools/asset-retriever/tag-snapshot.ts` | new (~20 lines) | After indexing, write `~/.hayba/cache/retriever-tags.json` as `{ "<assetPath>": ["<tag1>", ...] }` |
| `mcp-tools/hayba-mcp/src/tools/asset-retriever/tag-snapshot.test.ts` | new | vitest: snapshot writer correctness + stable ordering |
| `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaTagIndex.h` | new | C++ class wrapping the on-disk snapshot, lazy-loaded |
| `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaTagIndex.cpp` | new | Loader + `Lookup(assetPath) → TArray<FString>` |
| `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSceneMapData.h` | modify | Add `TArray<FString> Tags` to `FHaybaCogMapCell` |
| `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSceneMapBuilder.cpp` (or equivalent) | modify | Per-actor tag aggregation; serialize `tags` into the JSON payload |
| `unreal/HaybaMCPToolkit/Resources/cognitive-map/tag-overrides.json` | new | ~15 hand-pinned `{tag: hsl}` entries |
| `unreal/HaybaMCPToolkit/Resources/cognitive-map/index.html` | modify | Load overrides, implement `colorForTag()`, render chip strips, re-key hubs by tag |

Snapshot path resolution in the UE plugin: `FPlatformProcess::UserHomeDir() / ".hayba/cache/retriever-tags.json"` (Windows: `%USERPROFILE%\.hayba\cache\retriever-tags.json`).

## Data shapes

### Snapshot file (`~/.hayba/cache/retriever-tags.json`)

```json
{
  "/Game/Maritime/SM_Anchor": ["maritime", "metal", "rusted", "anchor"],
  "/Game/Foliage/SM_Pine": ["foliage", "tree", "conifer", "outdoor"]
}
```

Sorted keys for diff-friendliness. Tags array preserves the order returned by the indexer.

### Updated `FHaybaCogMapCell` JSON

```json
{
  "bounds": {"min": [x, y], "max": [x, y]},
  "label": "dense_forest_zone_A",
  "count": 47,
  "dominant": ["BP_Tree_Pine", "BP_Grass_Cluster"],
  "semantic": "Foliage",
  "tags": ["foliage", "tree", "outdoor", "natural", "vegetation"]
}
```

The legacy `semantic` field stays — keeps the fallback path working and avoids breaking any client that already reads it.

### `tag-overrides.json`

```json
{
  "maritime":   "hsl(210, 60%, 50%)",
  "foliage":    "hsl(120, 50%, 45%)",
  "urban":      "hsl(280, 30%, 55%)",
  "light":      "hsl(50, 75%, 60%)",
  "character":  "hsl(15, 65%, 55%)",
  "vehicle":    "hsl(0, 60%, 50%)",
  "interior":   "hsl(30, 40%, 50%)",
  "industrial": "hsl(200, 20%, 45%)",
  "natural":    "hsl(95, 45%, 50%)",
  "rock":       "hsl(25, 25%, 45%)",
  "water":      "hsl(195, 70%, 55%)",
  "sky":        "hsl(220, 70%, 70%)",
  "tech":       "hsl(180, 55%, 50%)",
  "magic":      "hsl(290, 70%, 60%)",
  "weapon":     "hsl(355, 50%, 45%)"
}
```

15 entries; editable. Anything outside this map gets a deterministic hash-derived hue.

## Error handling

- **Snapshot file missing** → log a single warning, fall back to the existing semantic-enum coloring. No regression — the panel just looks the way it did before this work.
- **Snapshot malformed JSON** → same fallback, error logged.
- **Cell with zero tags after aggregation** → muted gray fill, no chips, no hub anchor (cell drifts free in the layout).
- **Stale snapshot** (assets reindexed but plugin not restarted) → no detection in v1; the user re-runs the reindex tool and reopens the panel when groups feel wrong.

## Testing

- **TS:** vitest on `tag-snapshot.ts` — writes correct shape, stable key ordering, idempotent on re-run.
- **C++:** no test framework in the plugin; rely on integration smoke per existing convention.
- **Visual (manual):** capture before/after screenshots on a known scene with three categories (forest / maritime / mixed). Verify:
  1. Tag chips render under cells
  2. Same tag has same color across cells
  3. Hubs form by tag, not by hardcoded semantic
  4. Cells with no tags render gray and don't anchor to any hub

## Out of scope (deferred)

- Tag filter/search UI on the webview
- Click-tag-to-isolate behavior
- Hand-pinned override editor inside UE (v1 = edit the JSON directly)
- Stale-snapshot detection (file mtime check + auto-reload)
- Per-tag legend panel — overrides are static, so a legend isn't strictly needed; can land in v2

## Non-goals

- Replacing the force-layout algorithm
- Changing the cell-extraction logic (which actors get bucketed into which cell)
- Restructuring `FHaybaCogMapCell` beyond the one new field
- Touching the asset retriever's indexing logic (we only add a small write step at the end)
