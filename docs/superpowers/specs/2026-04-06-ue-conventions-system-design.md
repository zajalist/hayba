# UE Conventions System — Design

**Date:** 2026-04-06  
**Status:** Approved  
**Scope:** Spec 2 of 4 (Unification → Conventions System → Landscape Import → Joint Workflow)

---

## Problem

When the AI creates PCG graphs, imports landscapes, or places assets, it has no knowledge of the project's folder structure, naming conventions, or workflow preferences. It either guesses (wrong) or asks the user repeatedly for the same information. There's no persistent place to store these conventions.

---

## Goal

Two MCP tools — `hayba_setup_conventions` (wizard) and `hayba_analyze_conventions` (folder scanner) — that capture UE5 project conventions and persist them to a shared config. A `conventions.ts` module exposes read/write to all other tools. The UE plugin surfaces the active conventions and lets the user re-trigger setup from the editor.

---

## Conventions Schema

Stored as `HaybaConventions` (JSON globally, INI for project-level):

```ts
interface HaybaConventions {
  version: 1;
  preset: 'epic-default' | 'gamedevtv' | 'custom';

  folders: {
    pcgGraphs: string;          // e.g. "/Game/PCG"
    landscapeMaterials: string; // e.g. "/Game/Materials/Landscape"
    heightmaps: string;         // e.g. "/Game/Terrain/Heightmaps"
    blueprints: string;         // e.g. "/Game/Blueprints"
    textures: string;           // e.g. "/Game/Textures"
  };

  naming: {
    pcgGraphPrefix: string;     // e.g. "PCG_"
    materialPrefix: string;     // e.g. "M_"
    blueprintPrefix: string;    // e.g. "BP_"
    texturePrefix: string;      // e.g. "T_"
    folderCasing: 'PascalCase' | 'snake_case' | 'lowercase';
  };

  workflow: {
    confirmBeforeOverwrite: boolean;
    preferredLandscapeResolution: 1009 | 2017 | 4033;
    defaultHeightmapFormat: 'r16' | 'png';
    autoOpenInGaeaAfterBake: boolean;
  };
}
```

### Storage

| Location | Format | When used |
|---|---|---|
| `~/.hayba/conventions.json` | JSON | Global fallback |
| `{UEProjectRoot}/Config/DefaultHayba.ini` | INI `[Conventions]` section | Per-project override |

**Resolution rule:** project-level wins entirely. If `DefaultHayba.ini` exists and has a `[Conventions]` section, global is ignored.

---

## Shared Module: `src/conventions.ts`

Single file. All read/write goes through here. No other file in the codebase touches the storage format directly.

```ts
readConventions(projectRoot?: string): HaybaConventions | null
writeGlobalConventions(conventions: HaybaConventions): void
writeProjectConventions(conventions: HaybaConventions, projectRoot: string): void
getPreset(name: 'epic-default' | 'gamedevtv' | 'custom'): HaybaConventions
conventionsToIni(conventions: HaybaConventions): string
iniToConventions(ini: string): HaybaConventions
```

Global path resolved via `os.homedir()`. INI written under `[Conventions]` section with flat dot-notation keys (e.g. `folders.pcgGraphs=/Game/PCG`).

### Presets

| Preset | Description |
|---|---|
| `epic-default` | Epic's recommended UE5 content folder layout |
| `gamedevtv` | GameDev.tv course conventions (widely used in tutorials) |
| `custom` | Blank — user fills in every field |

---

## Tool: `hayba_setup_conventions`

A multi-turn wizard. Claude drives the conversation by calling this tool once per stage and presenting the returned question/summary to the user.

### Parameters

```ts
{
  stage: 'start' | 'folders' | 'naming' | 'workflow' | 'confirm' | 'save';
  preset?: 'epic-default' | 'gamedevtv' | 'custom';  // required at 'start'
  answers?: Record<string, unknown>;                  // accumulated user responses
  target?: 'global' | 'project';                     // required at 'save'
  projectRoot?: string;                              // required if target: 'project'
}
```

### Stage Flow

1. **`start`** — Claude passes `preset`. Tool returns the preset defaults and the first `folders` question.
2. **`folders`** — Claude passes `answers` for folder fields. Tool returns naming questions.
3. **`naming`** — Claude passes naming answers. Tool returns workflow questions.
4. **`workflow`** — Claude passes workflow answers. Tool returns a formatted human-readable summary for Claude to show the user.
5. **`confirm`** — Claude calls after user approves the summary. Tool returns a prompt asking `target` (global or project).
6. **`save`** — Claude passes `target` (and `projectRoot` if project). Tool writes the file, returns success.

### Handler file

`src/tools/hayba-setup-conventions.ts` — exports `setupConventionsHandler`.

---

## Tool: `hayba_analyze_conventions`

Scans an existing UE project's Content directory. Infers folder paths from known UE patterns and asset naming from filenames. Returns a `HaybaConventions` object with a `confidence` score per field (0–1). On first call (dry run), does not write. On second call with `save: true`, writes to the specified target.

### Parameters

```ts
{
  projectRoot: string;          // path to UE project root (contains .uproject)
  save?: boolean;               // default false — dry run
  target?: 'global' | 'project'; // required when save: true
}
```

### Inference logic

- Walks `{projectRoot}/Content/` up to 3 levels deep
- Matches folder names against known patterns: `PCG`, `PCGGraphs`, `Graphs` → `folders.pcgGraphs`; `Materials/Landscape`, `LandscapeMaterials` → `folders.landscapeMaterials`; etc.
- Samples up to 20 files per folder, extracts prefix (chars before first `_`) to infer naming conventions
- Returns `confidence: 1.0` for exact matches, `0.5` for partial, `0.0` if not found (field left as preset default)

### Handler file

`src/tools/hayba-analyze-conventions.ts` — exports `analyzeConventionsHandler`.

---

## UE Plugin Changes

### Settings (`UHaybaMCPSettings`)

Add a `Conventions` category to the existing settings class:

```cpp
UPROPERTY(EditAnywhere, config, Category="Conventions")
FString ConventionsScope;  // "global" | "project" — default target for analyze tool

UPROPERTY(EditAnywhere, config, Category="Conventions")
bool bConfirmBeforeOverwrite = true;

UPROPERTY(EditAnywhere, config, Category="Conventions")
int32 PreferredLandscapeResolution = 1009;
```

### Panel UI (`HaybaMCPPanel`)

Add a **Conventions** section to the Slate panel:
- Read-only display: which config file is active, key folder/naming values
- **"Setup Conventions"** button — sends `hayba_setup_conventions` trigger to Claude client
- **"Analyze Project"** button — sends `hayba_analyze_conventions` trigger with current project root

---

## Tool Registration

Both tools added to `src/tools/index.ts` `registerTools()`:

```ts
server.tool('hayba_setup_conventions', { stage, preset, answers, target, projectRoot }, handler)
server.tool('hayba_analyze_conventions', { projectRoot, save, target }, handler)
```

---

## Testing

**`tests/conventions.test.ts`**
- `readConventions` returns null when neither file exists
- `readConventions` returns global when only global exists
- `readConventions` returns project and ignores global when both exist
- `writeGlobalConventions` / `writeProjectConventions` round-trip
- `conventionsToIni` / `iniToConventions` round-trip
- `getPreset` returns valid schema for each preset name

**`tests/tools/hayba-setup-conventions.test.ts`**
- Each stage returns expected next stage and question payload
- `confirm` stage returns a formatted summary string
- `save` stage calls `writeGlobalConventions` / `writeProjectConventions` with correct data

**`tests/tools/hayba-analyze-conventions.test.ts`**
- Correctly infers folder paths from a mock directory tree (using `vol` from `memfs`)
- Dry run returns inferred conventions without writing any file
- Save mode writes to the correct target

---

## Out of Scope

- `hayba_import_landscape` (Spec 3) — will consume `readConventions()` but is not part of this spec
- Any UI for editing individual convention fields in-plugin (read-only display only; editing is done via the MCP tools)
- Convention validation or linting of existing UE projects
