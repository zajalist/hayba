# Cognitive Map — Tag-Based Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded `semanticOf()` substring-matching grouping in the Cognitive Map web view with actor-tag-driven grouping, render per-cell tag chips, and color cells deterministically by their mode tag.

**Architecture:** MCP server's asset retriever writes a `~/.hayba/cache/retriever-tags.json` snapshot after indexing. UE plugin's `FHaybaTagIndex` loads it lazily; `BuildUniformGrid` aggregates tags per cell (UE `Actor->Tags` first, retriever fallback). The web panel JSON gains a `tags[]` field per cell. `index.html` loads a `tag-overrides.json` palette + FNV-1a deterministic hash for unknown tags; cells fill by mode-tag color, with a chip strip below each circle, and force-layout hubs re-key by tag string.

**Tech Stack:** TypeScript + vitest (MCP), Unreal C++ + Slate (plugin), HTML/D3.js (web view).

**Spec:** `docs/superpowers/specs/2026-05-21-cognitive-map-tag-grouping-design.md`

---

### Task 1: TS — tag-snapshot writer (TDD)

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/asset-retriever/tag-snapshot.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/asset-retriever/tag-snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// mcp-tools/hayba-mcp/src/tools/asset-retriever/tag-snapshot.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTagSnapshot } from './tag-snapshot.js';

describe('writeTagSnapshot', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hayba-tag-snap-')); });
  afterEach(()  => { rmSync(dir, { recursive: true, force: true }); });

  it('writes sorted assetPath → tags map as JSON', () => {
    const out = join(dir, 'retriever-tags.json');
    writeTagSnapshot(out, [
      { path: '/Game/Foliage/SM_Pine',    tags: ['foliage', 'tree', 'conifer'] },
      { path: '/Game/Maritime/SM_Anchor', tags: ['maritime', 'metal'] },
    ]);
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    expect(Object.keys(parsed)).toEqual(['/Game/Foliage/SM_Pine', '/Game/Maritime/SM_Anchor']);
    expect(parsed['/Game/Maritime/SM_Anchor']).toEqual(['maritime', 'metal']);
  });

  it('drops hits with no tags', () => {
    const out = join(dir, 'snap.json');
    writeTagSnapshot(out, [
      { path: '/Game/A', tags: [] },
      { path: '/Game/B', tags: ['x'] },
    ]);
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    expect(Object.keys(parsed)).toEqual(['/Game/B']);
  });

  it('is idempotent on identical input', () => {
    const out = join(dir, 'snap.json');
    const hits = [{ path: '/Game/X', tags: ['a', 'b'] }];
    writeTagSnapshot(out, hits);
    const first = readFileSync(out, 'utf8');
    writeTagSnapshot(out, hits);
    expect(readFileSync(out, 'utf8')).toBe(first);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npx vitest run src/tools/asset-retriever/tag-snapshot.test.ts`
Expected: FAIL (`Cannot find module './tag-snapshot.js'`).

- [ ] **Step 3: Implement the module**

```ts
// mcp-tools/hayba-mcp/src/tools/asset-retriever/tag-snapshot.ts
//
// Dumps a flat { assetPath: tags[] } JSON file the UE plugin reads to
// enrich the Cognitive Map's per-cell tag list. Sorted keys for
// diff-friendliness; assets with zero tags are omitted to keep the file
// small.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TagSnapshotHit {
  path: string;
  tags: string[];
}

export function writeTagSnapshot(outPath: string, hits: TagSnapshotHit[]): void {
  const map: Record<string, string[]> = {};
  for (const h of hits) {
    if (h.tags && h.tags.length > 0) map[h.path] = h.tags;
  }
  const sortedKeys = Object.keys(map).sort();
  const ordered: Record<string, string[]> = {};
  for (const k of sortedKeys) ordered[k] = map[k];
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npx vitest run src/tools/asset-retriever/tag-snapshot.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git -C D:/Hackathons/hayba add mcp-tools/hayba-mcp/src/tools/asset-retriever/tag-snapshot.ts mcp-tools/hayba-mcp/src/tools/asset-retriever/tag-snapshot.test.ts
git -C D:/Hackathons/hayba commit -m "feat(cogmap): tag snapshot writer for asset retriever"
```

---

### Task 2: TS — wire snapshot write into the asset-indexer rebuild path

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-indexer.ts` (find the function that finishes a full reindex and emit the snapshot)
- Modify: `mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-indexer.test.ts` (add one test asserting the snapshot file appears)

- [ ] **Step 1: Read the existing indexer**

```bash
sed -n '1,80p' D:/Hackathons/hayba/mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-indexer.ts
```

Identify the function that completes a rebuild (probably named `buildIndex`, `reindex`, or `indexAll`). It should yield the final list of hits or have access to the in-memory index of `{ path, tags }`. Locate the point right before the function returns.

- [ ] **Step 2: Resolve the snapshot output path**

Add this helper at the top of `asset-indexer.ts` (under the existing imports):

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeTagSnapshot } from './tag-snapshot.js';

const TAG_SNAPSHOT_PATH = join(homedir(), '.hayba', 'cache', 'retriever-tags.json');
```

- [ ] **Step 3: Emit the snapshot at end of rebuild**

In the rebuild function, immediately before returning, add:

```ts
const snapshotHits = allHits.map(h => ({ path: h.path, tags: h.tags ?? [] }));
try {
  writeTagSnapshot(TAG_SNAPSHOT_PATH, snapshotHits);
} catch (err) {
  console.error('[cogmap] failed to write tag snapshot:', err);
}
```

Adjust `allHits` to whatever the local variable is named (the array of indexed entries with `path` + `tags`). If the indexer keeps a `Map<string, AssetEntry>`, iterate that map instead. Wrap in try/catch — a failed snapshot must never break indexing.

- [ ] **Step 4: Add a test**

In `asset-indexer.test.ts`, add a new `it(...)` near the other rebuild tests:

```ts
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

it('writes the cogmap tag snapshot after rebuild', async () => {
  const snapPath = join(homedir(), '.hayba', 'cache', 'retriever-tags.json');
  // best-effort cleanup so the test starts from a known state
  try { rmSync(snapPath); } catch {}

  // (set up a tiny fixture indexer with two assets — reuse the same fixture
  // pattern as the other tests in this file)
  await rebuildFixtureIndex();

  expect(existsSync(snapPath)).toBe(true);
  const parsed = JSON.parse(readFileSync(snapPath, 'utf8'));
  expect(Object.values(parsed).flat().length).toBeGreaterThan(0);
});
```

If the existing tests don't have a `rebuildFixtureIndex()` helper, instead exercise whatever the existing rebuild entrypoint is and assert `existsSync(snapPath)`.

- [ ] **Step 5: Run tests**

```
cd D:/Hackathons/hayba/mcp-tools/hayba-mcp
npx vitest run src/tools/asset-retriever/asset-indexer.test.ts
```

Expected: all pre-existing tests still pass + the new one passes.

- [ ] **Step 6: Commit**

```bash
git -C D:/Hackathons/hayba add mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-indexer.ts mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-indexer.test.ts
git -C D:/Hackathons/hayba commit -m "feat(cogmap): emit retriever-tags snapshot after asset reindex"
```

---

### Task 3: C++ — `FHaybaTagIndex` loader

**Files:**
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaTagIndex.h`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaTagIndex.cpp`

- [ ] **Step 1: Header**

```cpp
// HaybaTagIndex.h — Lazy loader for the asset-retriever tag snapshot
// (~/.hayba/cache/retriever-tags.json). Maps UE asset path → tag list.
// Used by the Cognitive Map builder to enrich cells with semantic tags
// when actors carry no UE Tags of their own.

#pragma once

#include "CoreMinimal.h"

class FHaybaTagIndex
{
public:
    /** Path resolution: %USERPROFILE%/.hayba/cache/retriever-tags.json on Windows. */
    static FString DefaultSnapshotPath();

    /** Process-wide instance. Loads on first call; subsequent calls are O(1). */
    static FHaybaTagIndex& Get();

    /** Returns empty list when the asset path is unknown or the snapshot is missing. */
    const TArray<FString>& Lookup(const FString& AssetPath) const;

    /** True iff the snapshot was successfully loaded. */
    bool IsLoaded() const { return bLoaded; }

    /** Drops the cached map and forces a reload on the next Lookup. */
    void Invalidate();

private:
    FHaybaTagIndex() = default;
    void EnsureLoaded();

    mutable bool bLoaded = false;
    mutable bool bLoadAttempted = false;
    mutable TMap<FString, TArray<FString>> PathToTags;
    static const TArray<FString> EmptyTags;
};
```

- [ ] **Step 2: Implementation**

```cpp
// HaybaTagIndex.cpp
#include "HaybaTagIndex.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformMisc.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

const TArray<FString> FHaybaTagIndex::EmptyTags;

FString FHaybaTagIndex::DefaultSnapshotPath()
{
#if PLATFORM_WINDOWS
    FString Home = FPlatformMisc::GetEnvironmentVariable(TEXT("USERPROFILE"));
    if (Home.IsEmpty()) Home = FPaths::ProjectSavedDir();
    return FPaths::Combine(Home, TEXT(".hayba"), TEXT("cache"), TEXT("retriever-tags.json"));
#else
    FString Home = FPlatformMisc::GetEnvironmentVariable(TEXT("HOME"));
    if (Home.IsEmpty()) Home = FPaths::ProjectSavedDir();
    return FPaths::Combine(Home, TEXT(".hayba"), TEXT("cache"), TEXT("retriever-tags.json"));
#endif
}

FHaybaTagIndex& FHaybaTagIndex::Get()
{
    static FHaybaTagIndex Singleton;
    return Singleton;
}

void FHaybaTagIndex::Invalidate()
{
    PathToTags.Reset();
    bLoaded = false;
    bLoadAttempted = false;
}

void FHaybaTagIndex::EnsureLoaded()
{
    if (bLoadAttempted) return;
    bLoadAttempted = true;

    const FString Path = DefaultSnapshotPath();
    if (!IFileManager::Get().FileExists(*Path))
    {
        UE_LOG(LogTemp, Log, TEXT("[HaybaTagIndex] snapshot not present at %s — falling back to actor tags only"), *Path);
        return;
    }

    FString Raw;
    if (!FFileHelper::LoadFileToString(Raw, *Path))
    {
        UE_LOG(LogTemp, Warning, TEXT("[HaybaTagIndex] failed to read %s"), *Path);
        return;
    }

    TSharedPtr<FJsonObject> Root;
    TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
    if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
    {
        UE_LOG(LogTemp, Warning, TEXT("[HaybaTagIndex] %s is not valid JSON"), *Path);
        return;
    }

    for (const auto& KV : Root->Values)
    {
        if (!KV.Value.IsValid() || KV.Value->Type != EJson::Array) continue;
        TArray<FString>& Out = PathToTags.Add(KV.Key);
        for (const TSharedPtr<FJsonValue>& V : KV.Value->AsArray())
        {
            FString S;
            if (V.IsValid() && V->TryGetString(S)) Out.Add(S);
        }
    }
    bLoaded = true;
    UE_LOG(LogTemp, Log, TEXT("[HaybaTagIndex] loaded %d entries from %s"), PathToTags.Num(), *Path);
}

const TArray<FString>& FHaybaTagIndex::Lookup(const FString& AssetPath) const
{
    const_cast<FHaybaTagIndex*>(this)->EnsureLoaded();
    if (const TArray<FString>* Found = PathToTags.Find(AssetPath)) return *Found;
    return EmptyTags;
}
```

- [ ] **Step 3: Commit**

```bash
git -C D:/Hackathons/hayba add unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaTagIndex.h unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaTagIndex.cpp
git -C D:/Hackathons/hayba commit -m "feat(cogmap): FHaybaTagIndex lazy loader for retriever tag snapshot"
```

---

### Task 4: C++ — `FHaybaCogMapCell::Tags` + per-cell aggregation

**Files:**
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSceneMapData.h` (add `Tags` field)
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCogMapBuilder.cpp` (aggregate tags inside `BuildUniformGrid`)

- [ ] **Step 1: Add `Tags` field to `FHaybaCogMapCell`**

In `HaybaMCPSceneMapData.h`, modify the struct (currently at lines 32-40):

```cpp
struct FHaybaCogMapCell
{
    FBox2D Bounds = FBox2D(ForceInit);
    FString Label;
    EHaybaNodeSemantic Semantic = EHaybaNodeSemantic::Unknown;
    int32 ActorCount = 0;
    TArray<FString> DominantClasses;
    TArray<FString> ActorLabels;
    TArray<FString> Tags;          // NEW — top-5 tags by frequency across the cell's actors
};
```

- [ ] **Step 2: Add the per-cell tag aggregator in the builder**

In `HaybaMCPCogMapBuilder.cpp`, near the existing `DominantClasses` helper (around line 102) and before `BuildUniformGrid`, add:

```cpp
#include "HaybaTagIndex.h"
#include "GameFramework/Actor.h"
#include "Components/ActorComponent.h"

// Aggregate up to Limit tags across the cell's actors, sorted by frequency
// then alphabetically for stability. Prefers UE Actor->Tags; falls back to
// the retriever snapshot indexed by the actor's primary asset path.
TArray<FString> AggregateTagsForCell(const TArray<AActor*>& Actors, int32 Limit)
{
    TMap<FString, int32> Counts;

    auto Bump = [&Counts](const FString& Tag)
    {
        if (!Tag.IsEmpty()) Counts.FindOrAdd(Tag)++;
    };

    const FHaybaTagIndex& Index = FHaybaTagIndex::Get();

    for (AActor* A : Actors)
    {
        if (!A) continue;
        bool bHadUETag = false;
        for (const FName& T : A->Tags) { Bump(T.ToString()); bHadUETag = true; }
        if (bHadUETag) continue;

        // Fallback: resolve the actor's source-asset path via its root component's UObject, if any.
        FString AssetPath;
        if (UObject* SrcAsset = A->GetClass()) AssetPath = SrcAsset->GetPathName();
        if (!AssetPath.IsEmpty())
        {
            for (const FString& T : Index.Lookup(AssetPath)) Bump(T);
        }
    }

    TArray<TPair<FString, int32>> Sorted;
    for (const auto& KV : Counts) Sorted.Add(KV);
    Sorted.Sort([](const TPair<FString,int32>& A, const TPair<FString,int32>& B)
    {
        if (A.Value != B.Value) return A.Value > B.Value;
        return A.Key < B.Key;
    });

    TArray<FString> Out;
    Out.Reserve(Limit);
    for (int32 i = 0; i < FMath::Min(Limit, Sorted.Num()); ++i) Out.Add(Sorted[i].Key);
    return Out;
}
```

- [ ] **Step 3: Call the aggregator inside the cell loop**

In `BuildUniformGrid` (around line 159-167), modify the per-bin block:

```cpp
FHaybaCogMapCell Cell;
Cell.Bounds = FBox2D(
    FVector2D(Bounds.Min.X + GX * CellSize.X,     Bounds.Min.Y + GY * CellSize.Y),
    FVector2D(Bounds.Min.X + (GX+1) * CellSize.X, Bounds.Min.Y + (GY+1) * CellSize.Y));
Cell.ActorCount = Bin.Num();
Cell.DominantClasses = DominantClasses(Bin, /*Limit=*/5);
Cell.Tags           = AggregateTagsForCell(Bin, /*Limit=*/5);   // NEW
ClassifyDominant(Cell.DominantClasses, Cell.Label, Cell.Semantic);
for (AActor* A : Bin) Cell.ActorLabels.Add(A->GetActorLabel());
Cells.Add(MoveTemp(Cell));
```

- [ ] **Step 4: Commit**

```bash
git -C D:/Hackathons/hayba add unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSceneMapData.h unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCogMapBuilder.cpp
git -C D:/Hackathons/hayba commit -m "feat(cogmap): aggregate per-cell tags from UE Tags + retriever index"
```

---

### Task 5: C++ — Emit `tags[]` in the cog-map JSON payload

**Files:**
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSceneMapWebPanel.cpp` (the JSON builder around lines 103-119)

- [ ] **Step 1: Add a tags array to each cell's JSON**

Replace the loop body (currently lines 104-117) with:

```cpp
for (int32 i = 0; i < Cells.Num(); ++i)
{
    const FHaybaCogMapCell& C = Cells[i];
    if (i) J += TEXT(",");
    J += FString::Printf(TEXT("{\"label\":\"%s\",\"count\":%d,\"bounds\":{\"min\":[%.3f,%.3f],\"max\":[%.3f,%.3f]},\"dominant\":["),
        *EscStr(C.Label), C.ActorCount,
        C.Bounds.Min.X, C.Bounds.Min.Y, C.Bounds.Max.X, C.Bounds.Max.Y);
    for (int32 d = 0; d < C.DominantClasses.Num(); ++d)
    {
        if (d) J += TEXT(",");
        J += TEXT("\"") + EscStr(C.DominantClasses[d]) + TEXT("\"");
    }
    J += TEXT("],\"tags\":[");
    for (int32 t = 0; t < C.Tags.Num(); ++t)
    {
        if (t) J += TEXT(",");
        J += TEXT("\"") + EscStr(C.Tags[t]) + TEXT("\"");
    }
    J += TEXT("]}");
}
```

- [ ] **Step 2: Commit**

```bash
git -C D:/Hackathons/hayba add unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSceneMapWebPanel.cpp
git -C D:/Hackathons/hayba commit -m "feat(cogmap): include tags[] in scene-map JSON payload"
```

---

### Task 6: D3 — `tag-overrides.json` + `colorForTag()` + chip strip + hub re-keying

**Files:**
- Create: `unreal/HaybaMCPToolkit/Resources/cognitive-map/tag-overrides.json`
- Modify: `unreal/HaybaMCPToolkit/Resources/cognitive-map/index.html`

- [ ] **Step 1: Add the overrides file**

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

- [ ] **Step 2: Add the tag colorizer to index.html**

At the top of the `<script>` block in `index.html` (before `semanticOf` at line ~95), add:

```html
<script>
let TAG_OVERRIDES = {};
fetch('tag-overrides.json').then(r => r.ok ? r.json() : {}).then(o => { TAG_OVERRIDES = o; render(); });

// FNV-1a 32-bit hash. Deterministic per tag string.
function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; ++i) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function colorForTag(tag) {
  if (!tag) return 'hsl(0, 0%, 60%)';      // muted gray for tagless cells
  if (TAG_OVERRIDES[tag]) return TAG_OVERRIDES[tag];
  const hue = fnv1a(tag) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}
</script>
```

Adjust the existing `<script>` block — these go inside it, not in a new tag.

- [ ] **Step 3: Replace `semanticOf`-driven cell color + hub keying**

In the cell rendering code, replace whatever `.fill(...)` call colors the leaf cell with:

```js
.attr('fill', c => colorForTag((c.tags && c.tags[0]) || null))
```

Then locate the `families` Map (around line 144) that groups by `semanticOf(c.label)`. Replace its keying:

```js
const families = new Map(); // tag → { node, cells:[] }
cells.forEach(c => {
  const key = (c.tags && c.tags[0]) ? c.tags[0] : '_untagged';
  if (!families.has(key)) {
    families.set(key, {
      node: { id: 'hub:' + key, isHub: true, tag: key, color: colorForTag(key === '_untagged' ? null : key) },
      cells: []
    });
  }
  families.get(key).cells.push(c);
});
```

Wherever hub nodes get their fill color from `palette[sem]`, change to `d.color`.

- [ ] **Step 4: Render the per-cell chip strip**

Locate the SVG group that contains each leaf circle (look for the `<circle>` append on cells). After the circle's `append('circle')...` call, append a chip strip group:

```js
const chipR = 3;
const chipGap = 2;
cellGroup.each(function(c) {
  const g = d3.select(this);
  const chips = (c.tags || []).slice(0, 5);
  const totalW = chips.length * (chipR * 2 + chipGap) - chipGap;
  const startX = -totalW / 2;
  const chipY  = (c.radius || 8) + chipR + 4;
  g.selectAll('circle.chip').remove();
  g.selectAll('circle.chip').data(chips).enter().append('circle')
    .attr('class', 'chip')
    .attr('cx', (_, i) => startX + i * (chipR * 2 + chipGap) + chipR)
    .attr('cy', chipY)
    .attr('r', chipR)
    .attr('fill', t => colorForTag(t))
    .append('title').text(t => t);
});
```

Use the actual variable name for the per-cell group from the existing code (likely `cellGroup`, `nodeG`, or similar — read the file to confirm). The `c.radius || 8` fallback matches whatever the existing leaf-circle radius logic produces.

- [ ] **Step 5: Commit**

```bash
git -C D:/Hackathons/hayba add unreal/HaybaMCPToolkit/Resources/cognitive-map/tag-overrides.json unreal/HaybaMCPToolkit/Resources/cognitive-map/index.html
git -C D:/Hackathons/hayba commit -m "feat(cogmap): tag-keyed hubs, deterministic colors, chip strip per cell"
```

---

### Task 7: Smoke verification + manual visual check

**Files:** none (verification only)

- [ ] **Step 1: TS smoke**

```
cd D:/Hackathons/hayba/mcp-tools/hayba-mcp
npx vitest run src/tools/asset-retriever
```

Expected: all asset-retriever tests pass, including the new `tag-snapshot.test.ts` + the indexer test that checks the snapshot file appears.

- [ ] **Step 2: Manual UE side (record in PR body)**

After the user opens the Unreal editor and rebuilds modules:

1. Run `mcp__hayba-toolkit__hayba_asset_reindex` from Claude — confirms `~/.hayba/cache/retriever-tags.json` is written.
2. Open `Window → Hayba MCP` (or wherever the Cognitive Map panel lives), trigger the cog-map build.
3. Verify visually:
   - Each cell circle has 0-5 small colored chip dots below it.
   - Hover over a chip → tooltip shows the tag name.
   - Cells with no tags render as muted gray with no chips.
   - The same tag appears as the same color across different cells (e.g. anything maritime is the same blue).
   - Force-layout hubs cluster by tag, not by hardcoded semantic.

- [ ] **Step 3: Commit nothing** (manual verification — no diff)

---

### Task 8: Push branch + open PR

- [ ] **Step 1: Push**

```bash
git -C D:/Hackathons/hayba push -u origin spec/cogmap-tag-grouping
```

The branch was created earlier when the spec was committed; subsequent code commits live on the same branch.

- [ ] **Step 2: Open PR**

```bash
gh pr create --base main --head spec/cogmap-tag-grouping \
  --title "Cognitive Map: tag-based grouping + color coding" \
  --body "$(cat <<'EOF'
## Summary
- MCP server writes `~/.hayba/cache/retriever-tags.json` after asset reindex.
- UE plugin loads it via `FHaybaTagIndex`; per-cell tag aggregation prefers UE `Actor->Tags` and falls back to the retriever snapshot.
- Web view (`Resources/cognitive-map/index.html`) gains a `tag-overrides.json` palette + FNV-1a deterministic hash for unknown tags.
- Cells fill by mode-tag color; chip strip below each cell shows the top-5 tags; force-layout hubs re-keyed by tag.

Implements `docs/superpowers/specs/2026-05-21-cognitive-map-tag-grouping-design.md`.

## Test plan
- [x] vitest src/tools/asset-retriever/tag-snapshot.test.ts (3/3)
- [x] vitest src/tools/asset-retriever/asset-indexer.test.ts (snapshot-file assertion)
- [ ] Manual: reindex → snapshot present at ~/.hayba/cache/retriever-tags.json
- [ ] Manual: cog-map cells now show chip strips
- [ ] Manual: same tag → same color across cells
- [ ] Manual: hubs cluster by tag instead of hardcoded semantic

## Scope cuts (v2)
- Tag filter/search UI on the webview
- Click-tag-to-isolate behavior
- In-editor overrides editor (v1 = edit the JSON)
- Stale-snapshot detection
EOF
)"
```

Expected: PR URL printed.

---

## Self-Review Notes

**Spec coverage:**

| Spec section | Covered by |
|---|---|
| Snapshot writer `~/.hayba/cache/retriever-tags.json` | T1 |
| Snapshot wired into reindex path | T2 |
| `FHaybaTagIndex` lazy loader | T3 |
| `FHaybaCogMapCell.Tags` field | T4 step 1 |
| Per-cell aggregation (UE Tags first, retriever fallback) | T4 steps 2-3 |
| JSON payload includes `tags[]` | T5 |
| `tag-overrides.json` (~15 hand-pinned) | T6 step 1 |
| Deterministic `colorForTag` w/ FNV-1a fallback | T6 step 2 |
| Cell fill = mode-tag color | T6 step 3 |
| Force-layout hubs re-keyed by tag | T6 step 3 |
| Chip strip rendering | T6 step 4 |
| Smoke + visual verification | T7 |

**Out-of-scope items correctly deferred:** tag filter, click-isolate, in-editor overrides editor, stale-snapshot detection — none have implementation steps.

**Placeholder scan:** every step has the actual code/command. The only blanks are the existing-variable-name lookups in T2 (`allHits`) and T6 step 4 (cell group var) — both flagged explicitly with "read the file" instructions and exact patterns to match.

**Type consistency:** `Tags: TArray<FString>` is the same name in `HaybaMCPSceneMapData.h` (T4), the JSON emitter (`C.Tags`, T5), and the JS reader (`c.tags`, T6). `FHaybaTagIndex::Lookup` returns `const TArray<FString>&` consistent with how T4's aggregator iterates it. The `colorForTag(null)` muted-gray fallback in T6 step 2 matches the chip-strip behavior in step 4 (no chips rendered when `c.tags` is empty).
