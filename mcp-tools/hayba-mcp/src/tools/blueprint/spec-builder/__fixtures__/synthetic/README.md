# Synthetic Blueprint spec fixtures

Eight Blueprint specs for an invented sample game, "Lantern Puzzle": the player
turns mirrors to send a beam of light into lanterns, and a door opens when
every lantern of the room is lit. The specs were written for these tests. No
project contains their assets, so they can be checked and planned, but not
built in an editor as they are.

The tests read the files from this directory (`spec-check.test.ts`,
`spec-plan.test.ts`, `spec-corpus.test.ts`) and compare against the counts
below.

## What each file is for

| File | Shape | What it covers |
|---|---|---|
| `BFL_BeamMath.json` | function library | `$comment`; an empty `variables` list; a pure and an impure function with up to 5 inputs and 3 outputs (float, int, name, bool, vector, rotator, object); graphs of `call` nodes only |
| `BPC_LanternRing.json` | actor component | variables of most types, with every form of default (number, bool, text, struct literal, asset path, none), `array<...>` and `linear_color`; timers; `select` with 3 and 4 options; casts to a native and to a Blueprint class with `CastFailed`; `create_widget`; calls with a native class, a Blueprint class and no class; a `custom_event` with inputs; one graph with more than 50 links |
| `PC_Lantern.json` | player controller | **CRLF line endings**; a Blueprint parent class; components; `sequence` with 2, 3 and 4 outputs; an event graph of one `event`; a node with no link; calls into a project C++ module (`/Script/LanternPuzzleCore...`); a struct literal on a pin |
| `BP_DoorLight.json` | actor with class defaults only | no `graphs` key; `cdo_defaults` with booleans, numbers written as `1500.0` and `1.0`, a fraction and an enum name |
| `GM_LanternPuzzle.json` | game mode | a Blueprint parent class; `cdo_defaults` with one class of the batch and one class outside it |
| `WBP_Lantern_Toast.graph.json` | widget, one function | no `create` and no `variables`; a literal on a pin whose name has a space (`Option 0`); a description with escaped quotes |
| `WBP_Lantern_Tally.graph.json` | widget with state | written fully expanded, as `JSON.stringify(spec, null, 2)` does; `select` with 5 options over widgets of the widget tree; pure helper functions called without a class; empty `defaults` objects |
| `WBP_Lantern_Menu.graph.json` | widget with an event graph | 7 `bound_event` nodes (three on one widget, two on another), `Construct` and `Destruct`; node names that start with a capital; explicit `x`/`y`; `vector2d`; `cdo_defaults` with nested objects |

Across the eight files:

- every node kind is used (`spec-check.test.ts` asserts it);
- the two functions with a by-reference input that the checker knows
  (`Conv_TextToString`, `K2_ClearAndInvalidateTimerHandle`) are called with
  that input linked, so no spec draws a by-reference warning;
- pin names with spaces appear in links (`AsPC Lantern`,
  `AsPoint Light Component`, `Option 3`);
- an exec input is driven from two places, and a data output feeds several inputs;
- `get` and `set` name things the spec does not declare: widgets of the widget
  tree, components, and the inherited `bShowMouseCursor`.

## References between the files

The batch lives under `/Game/LanternPuzzle/Core`, with the three widgets one
folder down in `Widgets/`. Planning with `target_root` moves the batch and
rewrites every reference to one of its eight assets, and nothing else. The
fixtures therefore hold both kinds of reference in every place a path can
stand:

| Place | To an asset of the batch | To an asset that stays where it is |
|---|---|---|
| variable type | `WBP_Lantern_Toast`, `WBP_Lantern_Tally`, `WBP_Lantern_Menu` | `WBP_Lantern_Credits` |
| variable default | | `Core/Sounds/S_Lantern_Lit` (inside the batch folder), `/Game/LanternPuzzle/Voice/...` (outside it) |
| function parameter type | `WBP_Lantern_Tally` | |
| component class | `BPC_LanternRing` | |
| `create.parent` | | `/Game/PuzzleKit/...` |
| `call` class | `BFL_BeamMath`, `PC_Lantern`, `BPC_LanternRing`, the widgets | `BFL_RoomNames`, `WBP_Lantern_Credits` |
| `cast` and `create_widget` | `PC_Lantern`, the widgets | `WBP_Lantern_Credits` |
| literal on a pin | `BP_DoorLight` | `Core/Glass/M_LanternGlass`, `/Game/LanternPuzzle/Props/BP_Mirror` |
| `cdo_defaults` | `PC_Lantern` | `PC_LanternCheats` (its name only starts like a batch asset), `/Game/LanternPuzzle/Hud/BP_PuzzleHud` |

## Frozen bytes

The files are compared byte for byte, line endings included. This directory
carries its own `.gitattributes` (`*.json -text`), so git never converts a line
ending here, whatever `core.autocrlf` says: `PC_Lantern.json` stays CRLF and
the other seven stay LF.

sha256 of each committed file (`git cat-file blob HEAD:<path> | sha256sum`):

```
43d8d7ebdfe10a2e55f3f0cf390cf28845af80e362602e211b7e31e3f66bd989  BFL_BeamMath.json
a413e5d15f88ed979007f03e36ffb85ed56a524741deb8e54de5dcb139486f70  BPC_LanternRing.json
ebd69121885ec3703beb272480380d9b9090e4f5266b67ad02d02b89c143382e  BP_DoorLight.json
e3fa0f0b28209d562df00813af9f352e0e1cfdabeca42fc37e48d6cdfd503307  GM_LanternPuzzle.json
2a7462631598a70915ae618afcf4065c24ab39b0dbfd82f7211244a9ca498918  PC_Lantern.json
7c6e22d46d8a868166dd6d82fb72ba90bb89e395098fef403129cf377286f81f  WBP_Lantern_Menu.graph.json
e02e2bd7b52a81ec1c0d333166d9155c7a4646bd33c066ca1a7eac09c3d5f47b  WBP_Lantern_Tally.graph.json
c5c3320402a79d0ad2d70089860653171fdcc5ffdc3195322d780d261519ac71  WBP_Lantern_Toast.graph.json
```

To verify a checkout, run this in this directory; all 8 lines must say `OK`:

```bash
grep -E '^[0-9a-f]{64}  ' README.md | tr -d '\r' | sha256sum -c -
```

## Counts

Counted from the files: graphs, nodes and links per spec, entries of
`defaults`, nodes of an event kind (`event`, `custom_event`, `bound_event`),
and nodes that `blueprint_apply_graph` places (every node but the events and
the function `entry` and `result`).

| File | graphs | nodes | links | defaults | event nodes | placed nodes |
|---|---|---|---|---|---|---|
| `BFL_BeamMath.json` | 2 | 33 | 47 | 15 | 0 | 29 |
| `BPC_LanternRing.json` | 11 | 124 | 145 | 39 | 2 | 110 |
| `PC_Lantern.json` | 9 | 71 | 76 | 30 | 1 | 62 |
| `BP_DoorLight.json` | 0 | 0 | 0 | 0 | 0 | 0 |
| `GM_LanternPuzzle.json` | 0 | 0 | 0 | 0 | 0 | 0 |
| `WBP_Lantern_Toast.graph.json` | 1 | 7 | 9 | 3 | 0 | 6 |
| `WBP_Lantern_Tally.graph.json` | 6 | 51 | 56 | 5 | 0 | 43 |
| `WBP_Lantern_Menu.graph.json` | 3 | 46 | 48 | 14 | 9 | 35 |
| **all eight** | 32 | 332 | 381 | 106 | 12 | 285 |

Every file passes `check()` with no error and draws no by-reference warning,
and no two files build the same asset. Planned together under a `target_root`,
the plan has no error and 3 warnings: the three widgets have no `create`, so
they are copied from their source asset first.

## Changing the fixtures

Do not edit a file without updating what depends on it. After any change:

1. recompute the sha256 list above;
2. recount the table above, and the same numbers in `spec-check.test.ts`
   (`COUNTS`), `spec-plan.test.ts` (`GOLDEN`, the totals and the
   `cdo_defaults` values) and `spec-corpus.test.ts` (the totals);
3. keep every shape and edge case of the first table, or add a fixture for it.

## Running a corpus of your own

Real projects have specs that cannot be published. To run the same offline
pipeline over such a set, point `HAYBA_BLUEPRINT_SPEC_CORPUS` at a directory:

```bash
cd mcp-tools/hayba-mcp
HAYBA_BLUEPRINT_SPEC_CORPUS="D:/path/to/specs" npx vitest run src/tools/blueprint/spec-builder/spec-corpus.test.ts
```

```powershell
cd mcp-tools\hayba-mcp
$env:HAYBA_BLUEPRINT_SPEC_CORPUS = 'D:/path/to/specs'
npx vitest run src/tools/blueprint/spec-builder/spec-corpus.test.ts
```

With the variable unset, the corpus tests are skipped and only the fixtures of
this directory are run.

The test reads every `*.json` file of the directory (not of its subfolders),
parses and checks each one, plans the valid ones together under
`/Game/HaybaMCPAutomation/SpecCorpus`, and builds the `blueprint_apply_graph`
payload of every graph. Nothing is sent to an editor. It fails when:

- anything throws, other than the parser refusing text that is not JSON;
- a spec reports an error. A corpus is expected to hold specs that build;
- a message fits none of the known error classes.

The error classes name the part of the spec a message is about: `json`,
`duplicate-key`, `shape`, `asset`, `create`, `variables`, `components`,
`functions`, `graph`, `cdo_defaults`, `duplicate-asset`, `target-root` and
`protected-path`.

A corpus may hold files that are known not to pass, for example a `*.json`
file that is not a spec. Declare them in a `corpus-expectations.json` in the
corpus directory, as file name to expected error classes:

```json
{ "WBP_Old.tree.json": ["shape", "asset"] }
```

The file then has to report those classes, and only those. An entry that no
longer applies fails the test, so the list cannot go stale.

Add `--reporter=verbose` to see the summary the test prints: the node and link
count of every spec and the totals of the plan.
