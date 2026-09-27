# Blueprint Bulk Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make whole-Blueprint authoring from a JSON spec a first-class Hayba capability: `blueprint_spec_check` (offline) and `blueprint_build_from_spec` (four-pass build on a new all-or-nothing C++ `blueprint_apply_graph`).

**Architecture:** The pure spec logic of the first consumer project's `bpgraph.mjs` is ported to TypeScript (`spec-parse` → `spec-check` → `spec-plan`), and a new `spec-build` drives the editor through `executeCommand`. On the C++ side, `blueprint_apply_graph` places one graph's nodes, literals and links in one call, validating before it links and removing everything it placed on failure. `blueprint_inspect_graph` gains paging plus `enabled`/`default` fields, a new `blueprint_set_component_property` sets SCS template properties, and the text-pin readback is fixed. The pure C++ rules go in `HaybaBlueprintOps`, where automation tests reach them without an editor.

**Tech Stack:** TypeScript (Node16 ESM, strict), zod, vitest; UE 5.8 C++ editor module (`HaybaMCPToolkit`), UE automation tests.

**Spec:** `docs/superpowers/specs/2026-09-27-blueprint-bulk-builder-design.md` (binding). Also read the first consumer project's bulk graph builder handoff (2026-09-26).

## Global Constraints

- No AI or `Co-Authored-By` trailers in any commit message. This overrides any harness attribution guidance.
- Do not push without asking.
- Never start PIE.
- Save only the packages the build created or modified.
- Never rebuild a protected root. Asset paths under one are refused unless `allow_live_paths: true`.
- Access the consumer project's editor only under the editor gate: `python <project>/Tools/GameFlow/editor_gate.py acquire --owner hayba-specbuild --timeout-min 60 --ttl-min 20`. Hold it for less than 20 minutes and always `release --owner hayba-specbuild`.
- Coordinate with the consumer project's session before deploying into `<project>/Plugins/HaybaMCPToolkit`.
- UE Live Coding cannot change class layout, register new commands' handlers reliably, or register new automation tests. Every C++ change in this plan needs a **full UBT rebuild** with the editor closed.
- The UE automation filter is `Hayba`: `test_list { filter_pattern: "Hayba" }`, not `Hayba.MCP`.
- Verify that new C++ tests actually ran by **name** in `test_list`/`test_run` output. UE can report "Result: Succeeded" for a binary that silently omits a new `.cpp`, and a test that never ran reports green.
- TS gate, run from the worktree root: `cd mcp-tools/hayba-mcp && npx tsc --noEmit && npx vitest run`. One failure is pre-existing and expected: `compile-persistence-truth-contract` › "revokes every module-owned callback before hot unload". Any other failure is yours.
- C++ compile gate for Tasks 4–7. The Aphrosia host's plugin junction points at the main checkout, not this worktree, so build the plugin standalone:
  `"C:\Program Files\Epic Games\UE_5.8\Engine\Build\BatchFiles\RunUAT.bat" BuildPlugin -Plugin="<worktree>\unreal\HaybaMCPToolkit\HaybaMCPToolkit.uplugin" -Package="%TEMP%\hayba-bp-buildplugin" -TargetPlatforms=Win64`
  Expect `BUILD SUCCESSFUL`, then delete the package folder. It takes 10–30 minutes. Compile errors are in the console output and in `%LOCALAPPDATA%\UnrealBuildTool\Log.txt`.
- Work on branch `feat/hayba-brain-client` in this worktree. Do not touch the main checkout, which is on `docs/redesign-dossier` and holds someone else's work.
- Public text (descriptions, commits, changelog) stays standalone: no competitor names.
- `executeCommand` must be called with a **string literal** command name. `wire-command-names.test.ts` scans for `executeCommand('name'`, so a wrapper that hides the name opts the call out of that check.

## Review Focus

1. **A loosely written pin name on a node that `apply_graph` creates.** Examples are `mul.returnvalue`, `AsPlayerController` against a pin named `AsPlayer Controller`, and a cast's bare `As`. C++ must resolve these exactly as TS `resolvePin` does, and must not fall back to UE's case-insensitive `FString ==` for the exact tier. Pinned by the Task 4 `ResolvePinName` test, which mirrors the TS case table, and the Task 7 `AppliesAndVerifies` test, which uses a loose name.
2. **A literal the engine stores in a different spelling.** Examples: `2` → `2.000000`, `0,0,1000` → `0.000000,0.000000,1000.000000`, `true` → `True`. These must verify rather than surface as mismatches. Pinned by the Task 4 `PinLiteral` test.
3. **A graph whose `apply_graph` reply was lost to a TCP drop.** The call may have landed. A re-run without `reset_graphs` must refuse the graph. A re-run with `reset_graphs` must rebuild it with no duplicate nodes. `apply_graph` is never retried. Pinned by the Task 9 test "a dropped apply is never retried, and a re-run refuses or resets the half-built graph".
4. **A paged read that cannot be trusted.** This covers a server that ignores `offset`, a trimmed (`_truncated`) page, and totals that change between pages. Verification must fail loudly and never undercount or overcount. Pinned by the Task 9 `readGraphComplete` tests and the Task 4 `PageWindow` past-the-end case.
5. **`target_root` rewriting.** Every reference to a batch asset must be rewritten, including `array<object:…>` types, pin-literal defaults and `cdo_defaults` values. References to non-batch assets under the same root (audio, materials, other widgets) must be left alone. Pinned by the Task 3 rewrite tests and the golden fixture test's "no live reference to a batch asset remains" assertion.

---

## Decisions where the spec is silent or the code disagrees

The implementation follows these decisions. They are listed so reviewers do not "fix" them back.

- **D1: the tests read synthetic specs.** The specs this work was designed against belong to a private project and are not part of this repository. The fixtures are 8 specs of an invented sample game, "Lantern Puzzle", that keep the shapes and the edge cases of the real ones (`__fixtures__/synthetic/README.md` lists them). Every count in this plan is counted from those 8 files; the golden table in Task 3 is authoritative. The real specs are kept as a private corpus and run through the optional corpus test (`HAYBA_BLUEPRINT_SPEC_CORPUS`).
- **D2: widget specs have no `create`.** They depend on widget trees built elsewhere. When `target_root` is set and the target asset is missing, the build copies the source asset with `asset_duplicate` (a read of the live asset, never a write). The build **always resets the graphs of an asset it copied**, because the copy carries the live graphs.
- **D3: `target_root` rewrite.** The root is the longest common directory of the batch's asset paths (`/Game/LanternPuzzle/Core` for the fixtures). Only strings that reference a **batch asset** are rewritten: its package path, or that path followed by `.`, `>` or the end of the string. In the fixtures, `/Game/LanternPuzzle/Core/Sounds/...` and `WBP_Lantern_Credits` stay live references.
- **D4: validation happens in two stages.** Pins do not exist until a node is placed, so `CanCreateConnection` cannot run before mutation. `apply_graph` first checks shape, kinds, classes, functions, variables and existing node ids with nothing touched. It then places the nodes and checks every pin, literal and connection **before making any link or setting any literal**. Any failure from placement onwards is followed by an explicit rollback. This meets "reject the whole payload, graph unchanged".
- **D5: pin resolution for new nodes lives in C++** (`HaybaBlueprintOps::ResolvePinName`). The payload carries the spec's raw pin names. TS `resolvePin` is used by the verify pass, which maps spec links onto pins read back from the graph.
- **D6: literal readback mismatches are warnings, not rollbacks.** `apply_graph` compares loosely (D2 of Review Focus). A remaining mismatch is reported in `default_mismatches` and surfaced as a build warning, because rolling back a correct graph over a comparator's spelling quirk is worse.
- **D7: `blueprint_get_info` also gets the response-builder override.** Its variable list was capped at 50, which made variables past 50 look missing (bpgraph patch 4). TS keeps the "already exists ⇒ warning" fallback as well.
- **D8: a skeleton compile failure is fatal.** bpgraph downgraded it to a warning under `--reset-graphs`. The plugin's broken-blueprint gate would then refuse the very `remove_node` calls a reset needs, so the build stops with that explanation instead.
- **D9: the protected root is a constant** (`PROTECTED_ASSET_ROOTS` in `spec-plan.ts`), as the spec requires.

## File structure

TS, under `mcp-tools/hayba-mcp/src/`:

| File | Responsibility |
|---|---|
| `tools/blueprint/spec-builder/spec-types.ts` | Spec and plan data types shared by every module |
| `tools/blueprint/spec-builder/spec-parse.ts` | JSON-with-comments parser with duplicate-key reports; the Hayba type grammar |
| `tools/blueprint/spec-builder/spec-check.ts` | Every bpgraph validation rule, cross-spec check, by-ref literal warnings, counts |
| `tools/blueprint/spec-builder/spec-plan.ts` | Pin resolution, layout, terminals/signatures, `target_root` rewrite, live-path check, build plan, `apply_graph` payload |
| `tools/blueprint/spec-builder/spec-build.ts` | Complete paged reads and the four passes through `executeCommand`; the report |
| `tools/blueprint/spec-builder/spec-builder-tools.ts` | Spec loading and the two tool descriptors |
| `tools/blueprint/spec-builder/__fixtures__/sample-spec.ts` | A spec that uses every node kind, after bpgraph's `sample()`; shared by the tests |
| `tools/blueprint/spec-builder/__fixtures__/synthetic/*.json` | 8 synthetic specs (an invented sample game), frozen byte for byte; a README with their sha256 and counts |
| `tools/testing/fake-blueprint-editor.ts` | A stateful fake of the blueprint commands, for end-to-end tests |
| `tools/blueprint/spec-builder/*.test.ts` | Tests, one per module |

Wiring edits: `tools/index.ts`, `tools/tool-executor.ts`, `tools/heavy-ops.ts`, `chat/agent-loop.ts`, `tools/code-mode/list-tool-categories.ts`, `legacy-commands/sidecar.json`, `tools/blueprint-graph-handler-contract.test.ts`, `tools/routing/search-quality.test.ts`, `CHANGELOG.md`.

C++, under `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/`:

| File | Change |
|---|---|
| `Public/HaybaBlueprintOps.h`, `Private/HaybaBlueprintOps.cpp` | Payload parse, `ResolvePinName`, `ComputePage`, `PinLiteral`/`PinLiteralMatches` |
| `Private/handlers/HaybaMCPBlueprintHandler.h/.cpp` | `ApplyGraph`, `SetComponentProperty`, paged `InspectGraph`, describe `enabled`/`default`, text-pin fix |
| `Private/HaybaMCPCommandHandler.cpp` | `DestructiveCommands` entries and the response-builder override |
| `Private/Tests/HaybaBlueprintOpsTest.cpp` | 4 pure-rule tests |
| `Private/Tests/HaybaBlueprintTestScratch.h` (new) | A scratch `/Temp` Actor Blueprint and a JSON helper for tests |
| `Private/Tests/HaybaMCPBlueprintInspectTest.cpp` (new) | Paging and text-pin tests |
| `Private/Tests/HaybaMCPBlueprintComponentTest.cpp` (new) | Component-property test |
| `Private/Tests/HaybaMCPBlueprintApplyGraphTest.cpp` (new) | Apply, reject and rollback tests |

TS test runs below use `cd mcp-tools/hayba-mcp && npx vitest run <file>`. All paths are relative to the worktree root.

---

### Task 1: Spec text parser and type grammar

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-types.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-parse.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-parse.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `spec-types.ts`: `Scalar`, `ParamSpec`, `VariableSpec`, `ComponentSpec`, `FunctionSpec`, `NodeSpec`, `GraphSpec`, `BlueprintSpec`, `SpecEntry`, `NodeKind`.
  - `spec-parse.ts`: `parseSpecText(text: string): ParsedSpecText`; `parseType(spec: unknown): ParsedType`; `type TypeKind`; `type ParsedType = {kind: TypeKind; path: string; array: boolean} | {error: string}`; `CATEGORY_OF_KIND: Readonly<Record<TypeKind,string>>`.

- [ ] **Step 1: Write the failing tests**

```ts
// mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-parse.test.ts
// Ported from bpgraph.test.mjs (the first consumer project's spec tool)
// (lines 246-256), plus the parser behaviour check() relies on.
import { describe, expect, it } from 'vitest';
import { CATEGORY_OF_KIND, parseSpecText, parseType } from './spec-parse.js';

describe('parseType', () => {
  // bpgraph.test.mjs:246-252
  it('follows the Hayba grammar', () => {
    expect(parseType('Float')).toEqual({ kind: 'real', path: '', array: false });
    expect(parseType(' linear_color ')).toEqual({ kind: 'struct', path: '/Script/CoreUObject.LinearColor', array: false });
    expect(parseType('array<object:/Script/Engine.Actor>')).toEqual({ kind: 'object', path: '/Script/Engine.Actor', array: true });
    expect(parseType('enum:/Game/Enums/E_State')).toEqual({ kind: 'enum', path: '/Game/Enums/E_State', array: false });
    expect('error' in parseType('')).toBe(true);
  });

  it('refuses what the plugin would refuse later with a worse message', () => {
    expect(parseType('vector3')).toMatchObject({ error: expect.stringMatching(/unknown type 'vector3'/) });
    expect(parseType('obj:/Script/Engine.Actor')).toMatchObject({ error: expect.stringMatching(/unknown reference kind 'obj'/) });
    expect(parseType('object:Engine.Actor')).toMatchObject({ error: expect.stringMatching(/needs a full path/) });
    expect(parseType('array<float')).toMatchObject({ error: expect.stringMatching(/never closes/) });
    expect(parseType('array<array<int>>')).toMatchObject({ error: expect.stringMatching(/arrays of arrays/) });
    expect(parseType('object:/Game/UI/WBP_Title')).toMatchObject({ error: expect.stringMatching(/ends in \.Name_C/) });
    expect(parseType(3)).toEqual({ error: 'type must be a string' });
  });

  it('maps every kind to the pin category blueprint_get_info reports', () => {
    expect(CATEGORY_OF_KIND.real).toBe('real');
    expect(CATEGORY_OF_KIND.enum).toBe('byte');
    expect(CATEGORY_OF_KIND.soft_object).toBe('softobject');
  });
});

describe('parseSpecText', () => {
  // bpgraph.test.mjs:254-256
  it('reports line and column', () => {
    expect(() => parseSpecText('{\n  "a": tru\n}')).toThrow(/line 2, column 8/);
  });

  it('names every duplicate key instead of silently keeping the last', () => {
    const r = parseSpecText('{"graphs":[{"nodes":{"g":{"get":"Glow"},"g":{"branch":true}}}]}');
    expect(r.duplicates).toEqual(['graphs[0].nodes: duplicate key "g"']);
  });

  it('accepts // and /* */ comments and a byte-order mark', () => {
    const r = parseSpecText('\uFEFF// header\n{ /* the package */ "asset": "/Game/X" }');
    expect(r.value).toEqual({ asset: '/Game/X' });
    expect(r.duplicates).toEqual([]);
  });

  it('refuses trailing commas and trailing text', () => {
    expect(() => parseSpecText('{"asset": "/Game/X", }')).toThrow(/trailing comma at line 1/);
    expect(() => parseSpecText('{} x')).toThrow(/unexpected text after the JSON value/);
  });

  it('does not let a "__proto__" key reach the prototype', () => {
    const r = parseSpecText('{"__proto__": {"polluted": true}}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(r.value as object)).toEqual(['__proto__']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/blueprint/spec-builder/spec-parse.test.ts`
Expected: FAIL with "Failed to resolve import './spec-parse.js'".

- [ ] **Step 3: Write `spec-types.ts`**

```ts
// Data types of the Blueprint spec format (ported from the first consumer project's bpgraph.mjs;
// format documented in that project's specs/README.md).
// A spec that passed check() has exactly these shapes.

export type Scalar = string | number | boolean;

export interface ParamSpec {
  name: string;
  type: string;
}

export interface VariableSpec {
  name: string;
  type: string;
  default?: unknown;
}

export interface ComponentSpec {
  name: string;
  class: string;
  /** SCS component template properties (added by the Hayba port). */
  properties?: Record<string, Scalar>;
}

export interface FunctionSpec {
  name: string;
  inputs?: ParamSpec[];
  outputs?: ParamSpec[];
  pure?: boolean;
}

/** One node: exactly one kind key (see NodeKind) plus optional x, y, class, inputs. */
export type NodeSpec = Record<string, unknown>;

export interface GraphSpec {
  graph: string;
  nodes: Record<string, NodeSpec>;
  links?: Array<[string, string]>;
  defaults?: Record<string, Scalar>;
}

export interface BlueprintSpec {
  asset: string;
  create?: { parent: string };
  variables?: VariableSpec[];
  components?: ComponentSpec[];
  functions?: FunctionSpec[];
  graphs?: GraphSpec[];
  cdo_defaults?: Record<string, unknown>;
  description?: string;
  $comment?: unknown;
}

/** A spec plus where it came from (a file path, or "specs[i]"). */
export interface SpecEntry {
  file: string;
  spec: BlueprintSpec;
}

export type NodeKind =
  | 'entry' | 'result' | 'event' | 'custom_event' | 'bound_event' | 'call' | 'get' | 'set'
  | 'branch' | 'sequence' | 'select' | 'self' | 'cast' | 'create_widget' | 'timer';
```

- [ ] **Step 4: Write `spec-parse.ts`**

```ts
// Spec text and the Hayba type grammar, ported from the first consumer project's bpgraph.mjs
// (2026-09-27) so a spec
// can be checked with no editor running.

export interface ParsedSpecText {
  value: unknown;
  /** One message per repeated object key; JSON.parse would silently keep the last. */
  duplicates: string[];
}

/**
 * Parse JSON with // and /* *\/ comments and report duplicate object keys.
 * Throws SyntaxError naming the line and column.
 */
export function parseSpecText(text: string): ParsedSpecText {
  // PORT bpgraph.mjs:50-173 (the body of parseSpecText) verbatim, with these
  // TypeScript adaptations only:
  //   - `const fail = (message: string): never => { throw new SyntaxError(...) }`
  //   - `function parseValue(path: string): unknown`, `parseObject(path: string): Record<string, unknown>`,
  //     `parseArray(path: string): unknown[]`, `parseString(): string`
  //   - `const out: Record<string, unknown> = {}` in parseObject; keep Object.defineProperty
  //     (it is what stops a "__proto__" key from reaching the prototype)
  //   - the BOM test `c === '\uFEFF'` written as an escape, not a literal character
  //   - return type ParsedSpecText
}

export type TypeKind =
  | 'bool' | 'int' | 'int64' | 'real' | 'string' | 'name' | 'text' | 'byte'
  | 'enum' | 'struct' | 'object' | 'class' | 'soft_object' | 'soft_class';

export type ParsedType = { kind: TypeKind; path: string; array: boolean } | { error: string };

const SCALAR_TYPES = new Map<string, TypeKind>([
  ['bool', 'bool'], ['boolean', 'bool'],
  ['int', 'int'], ['integer', 'int'], ['int32', 'int'],
  ['int64', 'int64'],
  ['float', 'real'], ['double', 'real'], ['real', 'real'],
  ['string', 'string'], ['fstring', 'string'],
  ['name', 'name'], ['fname', 'name'],
  ['text', 'text'], ['ftext', 'text'],
  ['byte', 'byte'], ['uint8', 'byte'],
]);
const ENGINE_STRUCTS = new Map<string, string>([
  ['vector', '/Script/CoreUObject.Vector'],
  ['rotator', '/Script/CoreUObject.Rotator'],
  ['transform', '/Script/CoreUObject.Transform'],
  ['linear_color', '/Script/CoreUObject.LinearColor'],
  ['linearcolor', '/Script/CoreUObject.LinearColor'],
  ['vector2d', '/Script/CoreUObject.Vector2D'],
]);
const REFERENCE_KINDS = new Set<TypeKind>(['object', 'class', 'soft_object', 'soft_class', 'struct', 'enum']);

/** The pin category Hayba's blueprint_get_info reports for a parsed type. */
export const CATEGORY_OF_KIND: Readonly<Record<TypeKind, string>> = {
  bool: 'bool', int: 'int', int64: 'int64', real: 'real', string: 'string', name: 'name', text: 'text',
  byte: 'byte', enum: 'byte', struct: 'struct', object: 'object', class: 'class',
  soft_object: 'softobject', soft_class: 'softclass',
};

/**
 * Parse a Hayba type string (mirror of HaybaBlueprintOps::ParseTypeSpec).
 * Stricter in one way: an object/class reference into /Game must name the
 * generated class (…_C), because the plugin's LoadClass of the asset path fails
 * live with a less direct message.
 */
export function parseType(spec: unknown): ParsedType {
  if (typeof spec !== 'string') return { error: 'type must be a string' };
  const s = spec.trim();
  if (!s) return { error: 'empty type' };
  if (/^array</i.test(s)) {
    if (!s.endsWith('>')) return { error: `'${spec}' opens array< but never closes it` };
    const inner = s.slice(6, -1).trim();
    if (/^array</i.test(inner)) return { error: `'${spec}': arrays of arrays are not a Blueprint type` };
    const t = parseType(inner);
    return 'error' in t ? t : { ...t, array: true };
  }
  const colon = s.indexOf(':');
  if (colon >= 0) {
    const prefix = s.slice(0, colon).trim().toLowerCase() as TypeKind;
    const path = s.slice(colon + 1).trim();
    if (!REFERENCE_KINDS.has(prefix)) return { error: `'${spec}': unknown reference kind '${prefix}'` };
    if (!path.startsWith('/')) return { error: `'${spec}' needs a full path after '${prefix}:'` };
    if (['object', 'class', 'soft_object', 'soft_class'].includes(prefix) && path.startsWith('/Game/') && !/\.[A-Za-z_]\w*_C$/.test(path)) {
      return { error: `'${spec}': a Blueprint class path ends in .Name_C, e.g. /Game/Dir/BP_X.BP_X_C` };
    }
    return { kind: prefix, path, array: false };
  }
  const lower = s.toLowerCase();
  const scalar = SCALAR_TYPES.get(lower);
  if (scalar) return { kind: scalar, path: '', array: false };
  const struct = ENGINE_STRUCTS.get(lower);
  if (struct) return { kind: 'struct', path: struct, array: false };
  return {
    error: `unknown type '${spec}' (accepted: bool, int, int64, float, double, string, name, text, byte, vector, rotator, transform, linear_color, vector2d, object:/class:/soft_object:/soft_class:/struct:/enum:<path>, array<...>)`,
  };
}
```

Replace the `// PORT` comment block inside `parseSpecText` with the ported body. It must end with `return { value, duplicates };`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/blueprint/spec-builder/spec-parse.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Run tsc**

Run: `cd mcp-tools/hayba-mcp && npx tsc --noEmit`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-types.ts mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-parse.ts mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-parse.test.ts
git commit -m "feat(blueprint): port the spec parser and type grammar from bpgraph"
```

---

### Task 2: Spec validation rules and the synthetic fixtures

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-check.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/__fixtures__/sample-spec.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/__fixtures__/synthetic/` (8 JSON files, `README.md`, `.gitattributes`)
- Test: `mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-check.test.ts`

**Interfaces:**
- Consumes: `parseSpecText`, `parseType` (Task 1); the types in `spec-types.ts`.
- Produces:
  - `NODE_KIND_NAMES: readonly NodeKind[]`
  - `EVENT_KINDS: ReadonlySet<NodeKind>`
  - `nodeKind(node: unknown): NodeKind | null`
  - `interface Endpoint {node: string; pin: string}`
  - `parseEndpoint(endpoint: unknown): Endpoint | null`
  - `check(input: unknown): string[]`
  - `checkAcross(entries: ReadonlyArray<{file: string; spec: unknown}>): string[]`
  - `KNOWN_BY_REF_INPUTS: ReadonlyMap<string, readonly string[]>`
  - `byRefLiteralWarnings(spec: BlueprintSpec, byRef?: ReadonlyMap<string, readonly string[]>): string[]`
  - `countSpec(spec: BlueprintSpec): {nodes: number; links: number}`
  - `sample(): BlueprintSpec` in `__fixtures__/sample-spec.ts`

- [ ] **Step 1: Write the 8 synthetic specs as frozen fixtures**

The specs belong to an invented sample game, "Lantern Puzzle" (mirrors send a beam into lanterns; a door opens when every lantern of the room is lit). Nothing in them is taken from a real project. Between them they must cover every shape and edge case the checker and the planner meet in real specs:

| File | Shape |
|---|---|
| `BFL_BeamMath.json` | function library: no variables, a pure and an impure function, `call` nodes only |
| `BPC_LanternRing.json` | actor component: variables of most types, timers, `select`, casts, `create_widget`, a `custom_event`, one graph with more than 50 links |
| `PC_Lantern.json` | player controller with a Blueprint parent, components, `sequence` nodes; **CRLF line endings** |
| `BP_DoorLight.json` | actor with `cdo_defaults` only |
| `GM_LanternPuzzle.json` | game mode whose `cdo_defaults` name one class of the batch and one outside it |
| `WBP_Lantern_Toast.graph.json` | widget with no `create`, one function |
| `WBP_Lantern_Tally.graph.json` | widget with no `create`, variables, timers and pure helpers; written fully expanded |
| `WBP_Lantern_Menu.graph.json` | widget with no `create`, an event graph, `bound_event` nodes and nested `cdo_defaults` |

The batch lives under `/Game/LanternPuzzle/Core`, the three widgets one folder down in `Widgets/`. The specs refer to each other (types, component classes, `call` classes, casts, pin literals, `cdo_defaults`) and to assets that are not part of the batch, inside and outside that folder.

The files are frozen byte for byte. Add `__fixtures__/synthetic/.gitattributes` with the one line `*.json -text` **before** the first `git add`, so git never converts a line ending there, and record the sha256 of every file in `__fixtures__/synthetic/README.md`:

```bash
D=mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/__fixtures__/synthetic
(cd "$D" && sha256sum *.json)
```

Derive each file's row of the count tables here and in Task 3 with this command:

```bash
node -e "const s=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const K=['entry','result','event','custom_event','bound_event','call','get','set','branch','sequence','select','self','cast','create_widget','timer'];let n=0,l=0,d=0,e=0,t=0;for(const g of s.graphs||[]){for(const x of Object.values(g.nodes)){const k=Object.keys(x).find(y=>K.includes(y));n++;if(k.endsWith('event'))e++;if(k==='entry'||k==='result')t++;}l+=(g.links||[]).length;d+=Object.keys(g.defaults||{}).length;}console.log({graphs:(s.graphs||[]).length,nodes:n,links:l,defaults:d,events:e,apply:n-e-t})" <file>
```

- [ ] **Step 2: Write `__fixtures__/sample-spec.ts`**

Write `sample()` after the one in `bpgraph.test.mjs:7-82`: the same nodes, links and literals, with the names of the sample game in place of bpgraph's. The asset is `/Game/LanternPuzzle/Core/BPC_Sample`; the variables are `Glow` (name, default `Dim`), `PulseInterval`, `PulseTimer`, `Rail`, `Hints` and `Menu`; the component is `ChimeAudio`; the functions are `CheckGlow` and `Twice`; the bound event targets `PlayButton`; the literals of `CheckGlow` are `Bright` and `Blazing`. The declaration is `export function sample(): BlueprintSpec {`, with `import type { BlueprintSpec } from '../spec-types.js';` at the top. The object literal satisfies `BlueprintSpec` as it is: links are `[string, string]` tuples in a typed position, and `cdo_defaults` is `Record<string, unknown>`.

- [ ] **Step 3: Write the failing tests**

```ts
// mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-check.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { byRefLiteralWarnings, check, checkAcross, countSpec, NODE_KIND_NAMES, nodeKind } from './spec-check.js';
import { parseSpecText } from './spec-parse.js';
import { sample } from './__fixtures__/sample-spec.js';
import type { BlueprintSpec, GraphSpec } from './spec-types.js';

const clone = <T>(v: T): T => structuredClone(v);
const graph = (spec: BlueprintSpec, name: string): GraphSpec => spec.graphs!.find((g) => g.graph === name)!;
const rejects = (spec: unknown, pattern: RegExp): void => {
  const errors = check(spec);
  expect(errors.some((e) => pattern.test(e)), `expected an error matching ${pattern}, got:\n  ${errors.join('\n  ') || '(no errors)'}`).toBe(true);
};

describe('check (ported from bpgraph.test.mjs)', () => {
  // Port each test below from bpgraph.test.mjs by name and line, converting
  // node:assert to vitest:
  //   assert.deepEqual(a, b) -> expect(a).toEqual(b)
  //   assert.ok(cond, msg)   -> expect(cond, msg).toBe(true)
  //   assert.match(s, re)    -> expect(s).toMatch(re)
  //   assert.throws(fn, re)  -> expect(fn).toThrow(re)
  // Test bodies otherwise verbatim (they use sample(), clone, graph and rejects above),
  // with the sample's names in place of bpgraph's.
  //   :91  'accepts a valid spec that uses every node kind'
  //   :95  'accepts the same spec as JSON text, with comments'
  //   :100 'rejects an unknown node kind'
  //   :106 'rejects a node with two kinds'
  //   :112 'rejects a link to an undeclared node'
  //   :118 'rejects a link from an undeclared node'
  //   :124 'rejects bad "node.Pin" syntax'
  //   :132 'rejects bad pin syntax in a defaults key'
  //   :138 'rejects a bad type string'
  //   :153 'rejects a bad type in a function signature and a custom event input'
  //   :161 'rejects an entry node in the EventGraph'
  //   :167 'rejects a result node when the function declares no outputs'
  //   :173 'rejects event nodes in a function graph'
  //   :179 'rejects a graph for an undeclared function'
  //   :185 'rejects duplicate names'
  //   :197 'rejects duplicate node names that JSON.parse would silently merge'
  //   :203 'rejects duplicate parameter names and reserved ones'
  //   :211 'rejects links that run the wrong way or double-drive a pin'
  //   :224 'rejects a literal on a pin that is also linked'
  //   :230 'rejects bad shapes and bad class paths'
  //   :241 'checkAcross rejects one asset built by two specs'
});

describe('component template properties (new in the Hayba port)', () => {
  it('accepts scalar properties on a component', () => {
    const spec = clone(sample());
    spec.components![0].properties = { bAutoActivate: false, VolumeMultiplier: 0.5, Sound: '/Game/A/S_Title.S_Title' };
    expect(check(spec)).toEqual([]);
  });

  it('refuses an empty map, a non-identifier name and a non-scalar value', () => {
    const empty = clone(sample());
    (empty.components![0] as { properties: unknown }).properties = {};
    rejects(empty, /components\[0\] \(ChimeAudio\)\.properties: must be a non-empty object/);
    const bad = clone(sample());
    (bad.components![0] as { properties: unknown }).properties = { 'bad name': true, Nested: { a: 1 } };
    rejects(bad, /properties\["bad name"\]: property names are identifiers/);
    rejects(bad, /properties\["Nested"\]: value must be a string, number or boolean/);
  });
});

describe('by-reference literal warnings', () => {
  it('warns about a literal on a known by-reference input', () => {
    const spec = clone(sample());
    const g = graph(spec, 'CheckGlow');
    g.nodes.toText = { call: 'Conv_TextToString', class: '/Script/Engine.KismetTextLibrary' };
    g.defaults = { ...g.defaults, 'toText.InText': 'hi' };
    expect(check(spec)).toEqual([]);
    expect(byRefLiteralWarnings(spec)).toEqual([
      'graph CheckGlow defaults["toText.InText"]: InText is a by-reference input of Conv_TextToString; the editor refuses a literal there — link a variable get into it instead',
    ]);
  });

  it('is silent when nothing is known about the function', () => {
    expect(byRefLiteralWarnings(sample())).toEqual([]);
  });
});

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'synthetic');
const COUNTS: Record<string, { nodes: number; links: number }> = {
  'BFL_BeamMath.json': { nodes: 33, links: 47 },
  'BPC_LanternRing.json': { nodes: 124, links: 145 },
  'PC_Lantern.json': { nodes: 71, links: 76 },
  'BP_DoorLight.json': { nodes: 0, links: 0 },
  'GM_LanternPuzzle.json': { nodes: 0, links: 0 },
  'WBP_Lantern_Toast.graph.json': { nodes: 7, links: 9 },
  'WBP_Lantern_Tally.graph.json': { nodes: 51, links: 56 },
  'WBP_Lantern_Menu.graph.json': { nodes: 46, links: 48 },
};

describe('the eight synthetic specs', () => {
  it.each(Object.entries(COUNTS))('%s passes check with its node and link counts', (file, want) => {
    const text = readFileSync(join(FIXTURES, file), 'utf8');
    expect(check(text)).toEqual([]);
    const spec = parseSpecText(text).value as BlueprintSpec;
    expect(countSpec(spec)).toEqual(want);
    expect(byRefLiteralWarnings(spec)).toEqual([]);
  });

  it('build together without two specs claiming one asset', () => {
    const entries = Object.keys(COUNTS).map((file) => ({ file, spec: parseSpecText(readFileSync(join(FIXTURES, file), 'utf8')).value }));
    expect(checkAcross(entries)).toEqual([]);
  });

  it('cover every node kind, and both line endings', () => {
    const kinds = new Set<string>();
    const endings = new Set<string>();
    for (const file of Object.keys(COUNTS)) {
      const text = readFileSync(join(FIXTURES, file), 'utf8');
      endings.add(text.includes('\r\n') ? 'CRLF' : 'LF');
      const spec = parseSpecText(text).value as BlueprintSpec;
      for (const g of spec.graphs ?? []) for (const node of Object.values(g.nodes)) kinds.add(String(nodeKind(node)));
    }
    expect([...kinds].sort()).toEqual([...NODE_KIND_NAMES].sort());
    expect([...endings].sort()).toEqual(['CRLF', 'LF']);
  });
});
```

Write each ported test in full as an `it('<name>', () => { ... })` inside the first `describe`. The comment list is the index of what to port; delete it once the tests are written.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/blueprint/spec-builder/spec-check.test.ts`
Expected: FAIL with "Failed to resolve import './spec-check.js'".

- [ ] **Step 5: Write `spec-check.ts`**

```ts
// Every validation rule of the first consumer project's bpgraph.mjs `check`, ported so
// blueprint_spec_check runs with no editor. Pure: no I/O.
import { parseSpecText, parseType } from './spec-parse.js';
import type { BlueprintSpec, NodeKind } from './spec-types.js';

// PORT bpgraph.mjs:242-560 verbatim (IDENT, PIN, ENDPOINT, RESERVED_PARAMS, isObj,
// isScalar, lc, loose, classPathProblem, NODE_KINDS, NODE_KIND_NAMES, EVENT_KINDS,
// POSITION_KEYS, nodeKind, parseEndpoint, checkParams, TOP_KEYS, check, checkAcross),
// with these adaptations:
//   1. Types: `const isObj = (v: unknown): v is Record<string, unknown> => ...`;
//      `interface KindRule { value: (v: unknown) => true | string; extras: string[];
//      inputs: boolean; outputs: boolean; functionOnly?: boolean; eventOnly?: boolean }`;
//      `const NODE_KINDS: Record<NodeKind, KindRule>`;
//      `export const NODE_KIND_NAMES = Object.keys(NODE_KINDS) as NodeKind[]`;
//      `export const EVENT_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['event','custom_event','bound_event'])`.
//   2. `export interface Endpoint { node: string; pin: string }`;
//      `export function parseEndpoint(endpoint: unknown): Endpoint | null`;
//      `export function nodeKind(node: unknown): NodeKind | null`;
//      `export function check(input: unknown): string[]` (a string is parsed with
//      parseSpecText and its duplicate-key messages are included);
//      `export function checkAcross(entries: ReadonlyArray<{ file: string; spec: unknown }>): string[]`.
//   3. parseType(...).error → `'error' in t ? t.error : undefined`.
//   4. Component checks (bpgraph.mjs:385-395): allowed keys become name/class/properties,
//      the shape message becomes `must be {"name", "class", "properties"?}`, and after the
//      class-path check insert the COMPONENT PROPERTIES block below.

// COMPONENT PROPERTIES block (inside the components.forEach, after the class check):
//   if (c.properties !== undefined) {
//     if (!isObj(c.properties) || Object.keys(c.properties).length === 0) {
//       errors.push(`${at} (${c.name}).properties: must be a non-empty object of property -> value`);
//     } else {
//       for (const [k, v] of Object.entries(c.properties)) {
//         if (!IDENT.test(k)) errors.push(`${at} (${c.name}).properties["${k}"]: property names are identifiers`);
//         if (!isScalar(v)) errors.push(`${at} (${c.name}).properties["${k}"]: value must be a string, number or boolean`);
//       }
//     }
//   }

/** Inputs the K2 schema refuses a literal on (by-reference parameters), found
 *  live in the first consumer project on UE 5.8. Extend when another one is found. */
export const KNOWN_BY_REF_INPUTS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ['Conv_TextToString', ['InText']],
  ['K2_ClearAndInvalidateTimerHandle', ['Handle']],
]);

/** Warnings for literals on by-reference inputs of known functions. They are
 *  warnings, not errors: the table is partial, and apply_graph refuses the
 *  literal anyway, naming the pin. */
export function byRefLiteralWarnings(spec: BlueprintSpec, byRef: ReadonlyMap<string, readonly string[]> = KNOWN_BY_REF_INPUTS): string[] {
  const out: string[] = [];
  for (const g of spec.graphs ?? []) {
    for (const endpoint of Object.keys(g.defaults ?? {})) {
      const e = parseEndpoint(endpoint);
      if (!e) continue;
      const node = g.nodes?.[e.node];
      const fn = node && typeof node.call === 'string' ? node.call : undefined;
      const pins = fn ? byRef.get(fn) : undefined;
      if (pins?.some((p) => p.toLowerCase() === e.pin.toLowerCase())) {
        out.push(`graph ${g.graph} defaults["${endpoint}"]: ${e.pin} is a by-reference input of ${fn}; the editor refuses a literal there — link a variable get into it instead`);
      }
    }
  }
  return out;
}

/** Node and link totals of a spec, as reported by blueprint_spec_check. */
export function countSpec(spec: BlueprintSpec): { nodes: number; links: number } {
  let nodes = 0;
  let links = 0;
  for (const g of spec.graphs ?? []) {
    nodes += Object.keys(g.nodes ?? {}).length;
    links += (g.links ?? []).length;
  }
  return { nodes, links };
}
```

Replace the `// PORT` and `// COMPONENT PROPERTIES` comments with the ported code. `parseSpecText` is used by `check` for string input, and `BlueprintSpec` by the new helpers.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/blueprint/spec-builder/spec-check.test.ts`
Expected: PASS (21 ported + 4 new + 10 fixture = 35 tests).

- [ ] **Step 7: Run the TS gate**

Run: `cd mcp-tools/hayba-mcp && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; only the known pre-existing failure.

- [ ] **Step 8: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder
git commit -m "feat(blueprint): port bpgraph spec validation with synthetic fixtures"
```

---

### Task 3: Build planning (pins, layout, signatures, target_root, payloads)

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-plan.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-plan.test.ts`

**Interfaces:**
- Consumes: `parseEndpoint`, `nodeKind`, `Endpoint` (Task 2); `BlueprintSpec`, `SpecEntry`, `NodeKind`, `ParamSpec`, `VariableSpec`, `ComponentSpec`, `FunctionSpec`, `GraphSpec`, `NodeSpec` (Task 1).
- Produces (all exported from `spec-plan.ts`):
  - `interface InspectedPin { name: string; direction: 'input' | 'output'; type?: string; default?: string }`
  - `interface InspectedNode { node_id: string; title: string; enabled?: boolean; pins: InspectedPin[] }`
  - `interface InspectedEdge { from_node: string; from_pin: string; to_node: string; to_pin: string }`
  - `interface InspectedGraph { nodes: InspectedNode[]; edges: InspectedEdge[]; node_count: number; edge_count: number }`
  - `resolvePin(pins: InspectedPin[] | undefined, wanted: string, direction: 'input'|'output', opts?: {cast?: boolean}): {name: string} | {error: string}`
  - `layoutNodes(names: string[], links: ReadonlyArray<readonly [string, string]>): Record<string, {x: number; y: number}>`
  - `findTerminals(nodes: InspectedNode[], functionName: string, known?: {entry?: string; result?: string}): {entry?: InspectedNode; result?: InspectedNode; resultCount: number}`
  - `signatureProblems(terminals: {entry?: {pins: InspectedPin[]}; result?: {pins: InspectedPin[]}}, fnSpec: FunctionSpec): string[]`
  - `type ApplyNodeKind = 'existing'|'call'|'get'|'set'|'branch'|'sequence'|'select'|'self'|'cast'|'create_widget'|'timer'`
  - `interface ApplyNode { key: string; kind: ApplyNodeKind; node_id?: string; function?: string; class?: string; variable?: string; count?: number; x: number; y: number }`
  - `interface ApplyDefault { node: string; pin: string; value: string }`
  - `interface ApplyLink { from_node: string; from_pin: string; to_node: string; to_pin: string }`
  - `interface ApplyGraphPayload { path: string; graph_name: string; nodes: ApplyNode[]; defaults: ApplyDefault[]; links: ApplyLink[] }`
  - `interface PlannedEvent { key: string; kind: 'event'|'custom_event'|'bound_event'; event: string; target?: string; inputs?: ParamSpec[]; x: number; y: number }`
  - `interface PlannedLink { text: string; from: Endpoint; to: Endpoint; fromKind: NodeKind; toKind: NodeKind }`
  - `interface PlannedGraph { graph: string; isEvent: boolean; nodeKinds: Record<string, NodeKind>; terminalKeys: {entry?: string; result?: string}; eventNodes: PlannedEvent[]; applyNodes: ApplyNode[]; applyDefaults: ApplyDefault[]; applyLinks: ApplyLink[]; specLinks: PlannedLink[]; linkedEventKeys: string[] }`
  - `interface PlannedAsset { asset: string; sourceAsset: string; name: string; create?: {parent: string}; duplicateFrom?: string; variables: VariableSpec[]; components: ComponentSpec[]; functions: FunctionSpec[]; graphs: PlannedGraph[]; cdoDefaults?: Record<string, unknown> }`
  - `interface BuildPlan { assets: PlannedAsset[]; errors: string[]; warnings: string[]; totals: {assets: number; graphs: number; nodes: number; links: number; defaults: number} }`
  - `interface PlanOptions { targetRoot?: string; allowLivePaths?: boolean }`
  - `PROTECTED_ASSET_ROOTS: readonly string[]`
  - `commonAssetRoot(assets: string[]): string`
  - `rewriteTargetRoot(entries: SpecEntry[], targetRoot: string): SpecEntry[]`
  - `livePathProblems(assets: string[], allowLive: boolean): string[]`
  - `planBuild(entries: SpecEntry[], opts?: PlanOptions): BuildPlan`
  - `applyGraphPayload(asset: string, g: PlannedGraph, ids: Readonly<Record<string, string>>): ApplyGraphPayload`

- [ ] **Step 1: Write the failing tests**

```ts
// mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-plan.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyGraphPayload, commonAssetRoot, findTerminals, layoutNodes, livePathProblems, planBuild,
  PROTECTED_ASSET_ROOTS, resolvePin, rewriteTargetRoot, signatureProblems,
} from './spec-plan.js';
import { parseSpecText } from './spec-parse.js';
import { sample } from './__fixtures__/sample-spec.js';
import type { BlueprintSpec, SpecEntry } from './spec-types.js';

describe('pins, layout and terminals (ported from bpgraph.test.mjs)', () => {
  // Port with the node:assert -> vitest conversions from Task 2, and invented names
  // for the inspected function of the last test:
  //   :258 'resolvePin: exact, then loose, then the cast "As" shorthand'
  //   :274 'layoutNodes places consumers right of their sources'
  //   :280 "signatureProblems ignores a library function's hidden world context and catches real differences"
  //   :293 'findTerminals recognises function entry and result nodes'
});

const TARGET = '/Game/HaybaMCPAutomation/SpecBuild';

describe('target_root rewrite', () => {
  const entry = (spec: BlueprintSpec): SpecEntry => ({ file: 'x.json', spec });

  it('finds the common folder of the batch', () => {
    expect(commonAssetRoot(['/Game/A/B/X', '/Game/A/B/UI/Y'])).toBe('/Game/A/B');
    expect(commonAssetRoot(['/Game/A/B/X'])).toBe('/Game/A/B');
  });

  it('rewrites every reference to a batch asset, and nothing else', () => {
    const pc: BlueprintSpec = {
      asset: '/Game/Live/Flow/PC_Main',
      create: { parent: '/Game/PuzzleKit/BP_Base.BP_Base_C' },
      variables: [
        { name: 'Screens', type: 'array<object:/Game/Live/Flow/UI/WBP_Screen.WBP_Screen_C>' },
        { name: 'Sfx', type: 'object:/Script/Engine.SoundBase', default: '/Game/Live/Flow/Audio/S_Beep.S_Beep' },
      ],
      graphs: [{
        graph: 'EventGraph',
        nodes: {
          find: { call: 'GetActorOfClass', class: '/Script/Engine.GameplayStatics' },
          mk: { create_widget: '/Game/Live/Flow/UI/WBP_Screen.WBP_Screen_C' },
          other: { create_widget: '/Game/Live/Flow/UI/WBP_Other.WBP_Other_C' },
        },
        defaults: { 'find.ActorClass': '/Game/Live/Flow/UI/WBP_Screen.WBP_Screen_C' },
      }],
      cdo_defaults: { ScreenClass: '/Game/Live/Flow/UI/WBP_Screen.WBP_Screen_C', Plain: 'WBP_Screen' },
    };
    const screen: BlueprintSpec = { asset: '/Game/Live/Flow/UI/WBP_Screen' };
    const [p, s] = rewriteTargetRoot([entry(pc), entry(screen)], TARGET);
    expect(s!.spec.asset).toBe(`${TARGET}/UI/WBP_Screen`);
    expect(p!.spec.asset).toBe(`${TARGET}/PC_Main`);
    expect(p!.spec.variables![0]!.type).toBe(`array<object:${TARGET}/UI/WBP_Screen.WBP_Screen_C>`);
    expect(p!.spec.variables![1]!.default).toBe('/Game/Live/Flow/Audio/S_Beep.S_Beep');
    const nodes = p!.spec.graphs![0]!.nodes;
    expect(nodes.mk!.create_widget).toBe(`${TARGET}/UI/WBP_Screen.WBP_Screen_C`);
    expect(nodes.other!.create_widget).toBe('/Game/Live/Flow/UI/WBP_Other.WBP_Other_C');
    expect(p!.spec.graphs![0]!.defaults!['find.ActorClass']).toBe(`${TARGET}/UI/WBP_Screen.WBP_Screen_C`);
    expect(p!.spec.cdo_defaults).toEqual({ ScreenClass: `${TARGET}/UI/WBP_Screen.WBP_Screen_C`, Plain: 'WBP_Screen' });
    expect(p!.spec.create!.parent).toBe('/Game/PuzzleKit/BP_Base.BP_Base_C');
  });

  it('does not rewrite an asset whose name merely starts with a batch asset name', () => {
    const [a] = rewriteTargetRoot([
      entry({ asset: '/Game/Live/Flow/PC_Main', cdo_defaults: { X: '/Game/Live/Flow/PC_Main2.PC_Main2_C' } }),
    ], TARGET);
    expect(a!.spec.cdo_defaults!.X).toBe('/Game/Live/Flow/PC_Main2.PC_Main2_C');
  });
});

describe('live paths', () => {
  // The protected folder, and the sample spec as an asset of that folder.
  const LIVE = PROTECTED_ASSET_ROOTS[0]!;
  const liveSample = (): BlueprintSpec => ({ ...sample(), asset: `${LIVE}/BPC_Sample` });

  it('refuses the protected root unless explicitly allowed', () => {
    expect(PROTECTED_ASSET_ROOTS).toEqual(['/Game/Live/Flow']);
    expect(livePathProblems([`${LIVE}/PC_Lantern`], false)[0]).toContain(`${LIVE}/PC_Lantern is under ${LIVE}`);
    expect(livePathProblems([`${LIVE}/Widgets/WBP_X`], false)).toHaveLength(1);
    expect(livePathProblems([`${LIVE}/PC_Lantern`], true)).toEqual([]);
    expect(livePathProblems([`${TARGET}/PC_Lantern`, `${LIVE}X/Y`], false)).toEqual([]);
  });

  it('planBuild refuses a live asset with no target_root', () => {
    const plan = planBuild([{ file: 'a', spec: liveSample() }]);
    expect(plan.errors.join('\n')).toContain(`BPC_Sample is under ${LIVE}`);
  });

  it('planBuild refuses a malformed target_root', () => {
    expect(planBuild([{ file: 'a', spec: liveSample() }], { targetRoot: 'Game/Nope' }).errors[0]).toMatch(/target_root "Game\/Nope" must be a \/Game folder path/);
  });
});

describe('planBuild on the sample spec', () => {
  const plan = planBuild([{ file: 'a', spec: sample() }], { targetRoot: TARGET });
  const asset = plan.assets[0]!;

  it('splits events, terminals and placed nodes', () => {
    expect(plan.errors).toEqual([]);
    const eg = asset.graphs.find((g) => g.graph === 'EventGraph')!;
    expect(eg.eventNodes.map((e) => [e.key, e.kind])).toEqual([['bp', 'event'], ['tick', 'custom_event'], ['click', 'bound_event']]);
    expect(eg.eventNodes[2]).toMatchObject({ event: 'OnClicked', target: 'PlayButton' });
    expect(eg.eventNodes[1]!.inputs).toEqual([{ name: 'Amount', type: 'float' }]);
    expect(eg.applyNodes.map((n) => n.kind).sort()).toEqual(['call', 'create_widget', 'select', 'self', 'sequence', 'timer'].sort());
    expect(eg.applyNodes.find((n) => n.key === 'seq')!.count).toBe(3);
    expect(eg.applyNodes.find((n) => n.key === 'w')).toMatchObject({ x: 900, y: 0 });
    expect(eg.linkedEventKeys).toEqual(['bp', 'tick']);
    const twice = asset.graphs.find((g) => g.graph === 'Twice')!;
    expect(twice.terminalKeys).toEqual({ entry: 'entry', result: 'result' });
    expect(twice.applyDefaults).toEqual([{ node: 'mul', pin: 'B', value: '2' }]);
    expect(twice.applyLinks[0]).toEqual({ from_node: 'entry', from_pin: 'then', to_node: 'result', to_pin: 'execute' });
  });

  it('builds an apply_graph payload that references placed events and terminals by id', () => {
    const eg = asset.graphs.find((g) => g.graph === 'EventGraph')!;
    const payload = applyGraphPayload(asset.asset, eg, { bp: 'G-BP', tick: 'G-TICK', click: 'G-CLICK' });
    expect(payload.graph_name).toBe('EventGraph');
    expect(payload.nodes.filter((n) => n.kind === 'existing')).toEqual([
      { key: 'bp', kind: 'existing', node_id: 'G-BP', x: 0, y: 0 },
      { key: 'tick', kind: 'existing', node_id: 'G-TICK', x: 0, y: 0 },
    ]);
    expect(payload.links).toHaveLength(6);
    expect(() => applyGraphPayload(asset.asset, eg, { tick: 'G-TICK' })).toThrow(/node "bp" has no node id/);
  });
});

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'synthetic');
const SOURCE = '/Game/LanternPuzzle/Core';
const FILES = [
  'BFL_BeamMath.json', 'BPC_LanternRing.json', 'PC_Lantern.json', 'BP_DoorLight.json', 'GM_LanternPuzzle.json',
  'WBP_Lantern_Toast.graph.json', 'WBP_Lantern_Tally.graph.json', 'WBP_Lantern_Menu.graph.json',
];
const z = { graphs: 0, nodes: 0, links: 0, defaults: 0, events: 0, apply: 0 };
const GOLDEN: Record<string, typeof z> = {
  [`${TARGET}/BFL_BeamMath`]: { graphs: 2, nodes: 33, links: 47, defaults: 15, events: 0, apply: 29 },
  [`${TARGET}/BPC_LanternRing`]: { graphs: 11, nodes: 124, links: 145, defaults: 39, events: 2, apply: 110 },
  [`${TARGET}/PC_Lantern`]: { graphs: 9, nodes: 71, links: 76, defaults: 30, events: 1, apply: 62 },
  [`${TARGET}/BP_DoorLight`]: z,
  [`${TARGET}/GM_LanternPuzzle`]: z,
  [`${TARGET}/Widgets/WBP_Lantern_Toast`]: { graphs: 1, nodes: 7, links: 9, defaults: 3, events: 0, apply: 6 },
  [`${TARGET}/Widgets/WBP_Lantern_Tally`]: { graphs: 6, nodes: 51, links: 56, defaults: 5, events: 0, apply: 43 },
  [`${TARGET}/Widgets/WBP_Lantern_Menu`]: { graphs: 3, nodes: 46, links: 48, defaults: 14, events: 9, apply: 35 },
};

describe('golden plan for the eight synthetic specs under target_root', () => {
  const entries: SpecEntry[] = FILES.map((file) => ({ file, spec: parseSpecText(readFileSync(join(FIXTURES, file), 'utf8')).value as BlueprintSpec }));
  const plan = planBuild(entries, { targetRoot: TARGET });

  it('plans without errors and with the expected totals', () => {
    expect(plan.errors).toEqual([]);
    expect(plan.totals).toEqual({ assets: 8, graphs: 32, nodes: 332, links: 381, defaults: 106 });
  });

  it.each(Object.entries(GOLDEN))('%s has its golden counts', (asset, want) => {
    const a = plan.assets.find((x) => x.asset === asset)!;
    expect(a, `${asset} missing from the plan`).toBeDefined();
    const sum = (f: (g: (typeof a.graphs)[number]) => number) => a.graphs.reduce((n, g) => n + f(g), 0);
    expect({
      graphs: a.graphs.length,
      nodes: sum((g) => Object.keys(g.nodeKinds).length),
      links: sum((g) => g.specLinks.length),
      defaults: sum((g) => g.applyDefaults.length),
      events: sum((g) => g.eventNodes.length),
      apply: sum((g) => g.applyNodes.length),
    }).toEqual(want);
  });

  it('copies the widget blueprints that have no "create" from their live source', () => {
    const dup = plan.assets.filter((a) => a.duplicateFrom).map((a) => [a.asset, a.duplicateFrom]);
    expect(dup).toEqual([
      [`${TARGET}/Widgets/WBP_Lantern_Toast`, `${SOURCE}/Widgets/WBP_Lantern_Toast`],
      [`${TARGET}/Widgets/WBP_Lantern_Tally`, `${SOURCE}/Widgets/WBP_Lantern_Tally`],
      [`${TARGET}/Widgets/WBP_Lantern_Menu`, `${SOURCE}/Widgets/WBP_Lantern_Menu`],
    ]);
  });

  it('leaves no live reference to a batch asset, and keeps live references to everything else', () => {
    const text = JSON.stringify(plan.assets.map(({ sourceAsset: _s, duplicateFrom: _d, ...rest }) => rest));
    for (const file of FILES) {
      const live = (parseSpecText(readFileSync(join(FIXTURES, file), 'utf8')).value as BlueprintSpec).asset;
      expect(new RegExp(`${live.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=["./>])`).test(text), `${live} is still referenced`).toBe(false);
    }
    expect(text).toContain(`${SOURCE}/Sounds/`);
    expect(text).toContain(`${SOURCE}/Widgets/WBP_Lantern_Credits.WBP_Lantern_Credits_C`);
    const pc = plan.assets.find((a) => a.asset === `${TARGET}/PC_Lantern`)!;
    expect(pc.components[0]!.class).toBe(`${TARGET}/BPC_LanternRing.BPC_LanternRing_C`);
    const gm = plan.assets.find((a) => a.asset === `${TARGET}/GM_LanternPuzzle`)!;
    expect(gm.cdoDefaults).toEqual({
      PlayerControllerClass: `${TARGET}/PC_Lantern.PC_Lantern_C`,
      HUDClass: '/Game/LanternPuzzle/Hud/BP_PuzzleHud.BP_PuzzleHud_C',
    });
  });
});
```

Write the four ported tests in full inside the first `describe` and delete the index comment.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/blueprint/spec-builder/spec-plan.test.ts`
Expected: FAIL with "Failed to resolve import './spec-plan.js'".

- [ ] **Step 3: Write `spec-plan.ts`**

```ts
// Pure planning for blueprint_build_from_spec: what to create, what to place,
// what to link — and where, when building copies under target_root.
import { nodeKind, parseEndpoint, type Endpoint } from './spec-check.js';
import type {
  BlueprintSpec, ComponentSpec, FunctionSpec, GraphSpec, NodeKind, NodeSpec, ParamSpec, SpecEntry, VariableSpec,
} from './spec-types.js';

export interface InspectedPin { name: string; direction: 'input' | 'output'; type?: string; default?: string }
export interface InspectedNode { node_id: string; title: string; enabled?: boolean; pins: InspectedPin[] }
export interface InspectedEdge { from_node: string; from_pin: string; to_node: string; to_pin: string }
export interface InspectedGraph { nodes: InspectedNode[]; edges: InspectedEdge[]; node_count: number; edge_count: number }

const loose = (s: string): string => s.toLowerCase().replace(/\s+/g, '');
const lc = (s: string): string => s.toLowerCase();

// PORT bpgraph.mjs:569-582 (resolvePin), 586-620 (layoutNodes), 623-632 (findTerminals)
// and 639-655 (signatureProblems) verbatim, exported with the signatures in this task's
// Interfaces block. Adaptations: `const candidates = (pins ?? []).filter(...)`;
// layoutNodes' `depth.get(x)!`; findTerminals' `byId = (id?: string) => ...`;
// signatureProblems' `have(node: {pins: InspectedPin[]} | undefined, dir: string, skip: string)`.

export type ApplyNodeKind = 'existing' | 'call' | 'get' | 'set' | 'branch' | 'sequence' | 'select' | 'self' | 'cast' | 'create_widget' | 'timer';
export interface ApplyNode { key: string; kind: ApplyNodeKind; node_id?: string; function?: string; class?: string; variable?: string; count?: number; x: number; y: number }
export interface ApplyDefault { node: string; pin: string; value: string }
export interface ApplyLink { from_node: string; from_pin: string; to_node: string; to_pin: string }
export interface ApplyGraphPayload { path: string; graph_name: string; nodes: ApplyNode[]; defaults: ApplyDefault[]; links: ApplyLink[] }

export interface PlannedEvent { key: string; kind: 'event' | 'custom_event' | 'bound_event'; event: string; target?: string; inputs?: ParamSpec[]; x: number; y: number }
export interface PlannedLink { text: string; from: Endpoint; to: Endpoint; fromKind: NodeKind; toKind: NodeKind }
export interface PlannedGraph {
  graph: string;
  isEvent: boolean;
  nodeKinds: Record<string, NodeKind>;
  terminalKeys: { entry?: string; result?: string };
  eventNodes: PlannedEvent[];
  applyNodes: ApplyNode[];
  applyDefaults: ApplyDefault[];
  applyLinks: ApplyLink[];
  specLinks: PlannedLink[];
  /** Event nodes a spec link leaves from; each must read back enabled. */
  linkedEventKeys: string[];
}
export interface PlannedAsset {
  asset: string;
  /** The spec's own asset path before any target_root rewrite. */
  sourceAsset: string;
  name: string;
  create?: { parent: string };
  /** Copy this live asset first (a spec with no "create", built under target_root). */
  duplicateFrom?: string;
  variables: VariableSpec[];
  components: ComponentSpec[];
  functions: FunctionSpec[];
  graphs: PlannedGraph[];
  cdoDefaults?: Record<string, unknown>;
}
export interface BuildPlan {
  assets: PlannedAsset[];
  errors: string[];
  warnings: string[];
  totals: { assets: number; graphs: number; nodes: number; links: number; defaults: number };
}
export interface PlanOptions { targetRoot?: string; allowLivePaths?: boolean }

/** Live assets a build never writes to unless allow_live_paths is set (spec §5.4). */
export const PROTECTED_ASSET_ROOTS: readonly string[] = ['/Game/Live/Flow'];
const PACKAGE_FOLDER = /^\/Game(\/[A-Za-z_][A-Za-z0-9_]*)+$/;
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The longest folder every asset of the batch lives under. */
export function commonAssetRoot(assets: string[]): string {
  if (assets.length === 0) return '';
  const dirs = assets.map((a) => a.slice(0, a.lastIndexOf('/')).split('/'));
  let n = dirs[0]!.length;
  for (const d of dirs) {
    let i = 0;
    while (i < n && i < d.length && d[i] === dirs[0]![i]) i++;
    n = i;
  }
  return dirs[0]!.slice(0, n).join('/');
}

/**
 * Move a batch under targetRoot, keeping each asset's path below the batch's
 * common folder. Every string that names a batch asset — its package path, or
 * that path followed by ".", ">" or the end — is rewritten, wherever it sits
 * (types, class paths, pin literals, CDO values). Other assets, even under the
 * same folder, stay where they are: the copies read them, never write them.
 */
export function rewriteTargetRoot(entries: SpecEntry[], targetRoot: string): SpecEntry[] {
  const root = commonAssetRoot(entries.map((e) => e.spec.asset));
  const moves = entries
    .map((e) => e.spec.asset)
    .sort((a, b) => b.length - a.length)
    .map((from) => ({ pattern: new RegExp(`${escapeRegExp(from)}(?=$|[.>])`, 'g'), to: targetRoot + from.slice(root.length) }));
  const rewrite = (v: unknown): unknown => {
    if (typeof v === 'string') return moves.reduce((s, m) => s.replace(m.pattern, m.to), v);
    if (Array.isArray(v)) return v.map(rewrite);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x)]));
    return v;
  };
  return entries.map((e) => ({ file: e.file, spec: rewrite(e.spec) as BlueprintSpec }));
}

export function livePathProblems(assets: string[], allowLive: boolean): string[] {
  if (allowLive) return [];
  const out: string[] = [];
  for (const asset of assets) {
    for (const root of PROTECTED_ASSET_ROOTS) {
      if (lc(asset) === lc(root) || lc(asset).startsWith(`${lc(root)}/`)) {
        out.push(`${asset} is under ${root}, which is live and is never rebuilt by default; pass target_root to build a copy, or allow_live_paths: true to rebuild it on purpose`);
      }
    }
  }
  return out;
}

function toApplyNode(key: string, kind: NodeKind, node: NodeSpec, x: number, y: number): ApplyNode {
  const cls = typeof node.class === 'string' ? { class: node.class } : {};
  switch (kind) {
    case 'call': return { key, kind, function: String(node.call), ...cls, x, y };
    case 'get': return { key, kind, variable: String(node.get), x, y };
    case 'set': return { key, kind, variable: String(node.set), x, y };
    case 'sequence': return { key, kind, count: Number(node.sequence), x, y };
    case 'select': return { key, kind, count: Number(node.select), x, y };
    case 'cast': return { key, kind, class: String(node.cast), x, y };
    case 'create_widget': return { key, kind, class: String(node.create_widget), x, y };
    case 'branch':
    case 'self':
    case 'timer':
      return { key, kind, x, y };
    default:
      throw new Error(`node "${key}": ${kind} is not placed through apply_graph`);
  }
}

function planGraph(g: GraphSpec): PlannedGraph {
  const links = g.links ?? [];
  const layout = layoutNodes(Object.keys(g.nodes), links);
  const plan: PlannedGraph = {
    graph: g.graph, isEvent: lc(g.graph) === 'eventgraph', nodeKinds: {}, terminalKeys: {},
    eventNodes: [], applyNodes: [], applyDefaults: [], applyLinks: [], specLinks: [], linkedEventKeys: [],
  };
  for (const [key, node] of Object.entries(g.nodes)) {
    const kind = nodeKind(node)!; // check() refused every node without exactly one kind
    plan.nodeKinds[key] = kind;
    const x = Math.round(typeof node.x === 'number' ? node.x : layout[key]!.x);
    const y = Math.round(typeof node.y === 'number' ? node.y : layout[key]!.y);
    if (kind === 'entry' || kind === 'result') plan.terminalKeys[kind] = key;
    else if (kind === 'event') plan.eventNodes.push({ key, kind, event: String(node.event), x, y });
    else if (kind === 'custom_event') plan.eventNodes.push({ key, kind, event: String(node.custom_event), inputs: (node.inputs as ParamSpec[] | undefined) ?? [], x, y });
    else if (kind === 'bound_event') {
      const b = node.bound_event as { target: string; event: string };
      plan.eventNodes.push({ key, kind, event: b.event, target: b.target, x, y });
    } else plan.applyNodes.push(toApplyNode(key, kind, node, x, y));
  }
  for (const [endpoint, value] of Object.entries(g.defaults ?? {})) {
    const e = parseEndpoint(endpoint)!;
    plan.applyDefaults.push({ node: e.node, pin: e.pin, value: String(value) });
  }
  for (const [a, b] of links) {
    const from = parseEndpoint(a)!;
    const to = parseEndpoint(b)!;
    plan.applyLinks.push({ from_node: from.node, from_pin: from.pin, to_node: to.node, to_pin: to.pin });
    plan.specLinks.push({ text: `${a} -> ${b}`, from, to, fromKind: plan.nodeKinds[from.node]!, toKind: plan.nodeKinds[to.node]! });
  }
  plan.linkedEventKeys = plan.eventNodes.map((e) => e.key).filter((k) => plan.specLinks.some((l) => l.from.node === k));
  return plan;
}

function planAsset(spec: BlueprintSpec, sourceAsset: string, copying: boolean): PlannedAsset {
  return {
    asset: spec.asset,
    sourceAsset,
    name: spec.asset.slice(spec.asset.lastIndexOf('/') + 1),
    ...(spec.create ? { create: spec.create } : {}),
    ...(!spec.create && copying && sourceAsset !== spec.asset ? { duplicateFrom: sourceAsset } : {}),
    variables: spec.variables ?? [],
    components: spec.components ?? [],
    functions: spec.functions ?? [],
    graphs: (spec.graphs ?? []).map(planGraph),
    ...(spec.cdo_defaults ? { cdoDefaults: spec.cdo_defaults } : {}),
  };
}

/** Plan a build of checked specs. Specs must already pass check()/checkAcross(). */
export function planBuild(entries: SpecEntry[], opts: PlanOptions = {}): BuildPlan {
  const errors: string[] = [];
  const warnings: string[] = [];
  let working = entries;
  let copying = false;
  if (opts.targetRoot !== undefined) {
    if (!PACKAGE_FOLDER.test(opts.targetRoot)) errors.push(`target_root "${opts.targetRoot}" must be a /Game folder path like /Game/Scratch/SpecBuild`);
    else { working = rewriteTargetRoot(entries, opts.targetRoot); copying = true; }
  }
  errors.push(...livePathProblems(working.map((e) => e.spec.asset), opts.allowLivePaths === true));
  const assets = working.map((e, i) => planAsset(e.spec, entries[i]!.spec.asset, copying));
  for (const a of assets) {
    if (a.duplicateFrom) warnings.push(`${a.asset}: the spec has no "create", so it is copied from ${a.duplicateFrom} and its graphs are rebuilt from the spec`);
  }
  const graphs = assets.flatMap((a) => a.graphs);
  return {
    assets, errors, warnings,
    totals: {
      assets: assets.length,
      graphs: graphs.length,
      nodes: graphs.reduce((n, g) => n + Object.keys(g.nodeKinds).length, 0),
      links: graphs.reduce((n, g) => n + g.specLinks.length, 0),
      defaults: graphs.reduce((n, g) => n + g.applyDefaults.length, 0),
    },
  };
}

/** One graph's apply_graph payload. Nodes placed earlier (events, a function's
 *  entry/result) are referenced by id as `existing`; `ids` maps spec keys to ids. */
export function applyGraphPayload(asset: string, g: PlannedGraph, ids: Readonly<Record<string, string>>): ApplyGraphPayload {
  const placed = new Set(g.applyNodes.map((n) => n.key));
  const referenced = new Set<string>([...g.applyLinks.flatMap((l) => [l.from_node, l.to_node]), ...g.applyDefaults.map((d) => d.node)]);
  const existing: ApplyNode[] = [];
  for (const key of referenced) {
    if (placed.has(key)) continue;
    const id = ids[key];
    if (!id) throw new Error(`graph ${g.graph}: node "${key}" has no node id (it was not placed)`);
    existing.push({ key, kind: 'existing', node_id: id, x: 0, y: 0 });
  }
  return { path: asset, graph_name: g.graph, nodes: [...existing, ...g.applyNodes], defaults: g.applyDefaults, links: g.applyLinks };
}
```

Replace the `// PORT` comment with the four ported functions.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/blueprint/spec-builder/spec-plan.test.ts`
Expected: PASS (4 ported + 3 rewrite + 3 live-path + 2 sample + 12 golden = 24 tests).

- [ ] **Step 5: Run the TS gate**

Run: `cd mcp-tools/hayba-mcp && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; only the known pre-existing failure.

- [ ] **Step 6: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-plan.ts mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-plan.test.ts
git commit -m "feat(blueprint): plan spec builds with target_root copies and apply payloads"
```

---
### Task 4: Pure C++ rules in HaybaBlueprintOps

**Files:**
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Public/HaybaBlueprintOps.h`. Append inside `namespace HaybaBlueprintOps`.
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaBlueprintOps.cpp`. Append inside the namespace.
- Test: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaBlueprintOpsTest.cpp`. Append before `#endif`.

**Interfaces:**
- Consumes: nothing new.
- Produces, in namespace `HaybaBlueprintOps`:
  - `enum class EApplyNodeKind : uint8 { Existing, Call, Get, Set, Branch, Sequence, Select, Self, Cast, CreateWidget, Timer }`
  - `struct FApplyNodeRequest { FString Key; EApplyNodeKind Kind; FString NodeId, Function, ClassPath, Variable; int32 Count = 2, X = 0, Y = 0; }`
  - `struct FApplyDefaultRequest { FString Node, Pin, Value; }`
  - `struct FApplyLinkRequest { FString FromNode, FromPin, ToNode, ToPin; }`
  - `struct FApplyGraphRequest { TArray<FApplyNodeRequest> Nodes; TArray<FApplyDefaultRequest> Defaults; TArray<FApplyLinkRequest> Links; }`
  - `TArray<FString> ParseApplyGraphPayload(const TSharedPtr<FJsonObject>& Params, FApplyGraphRequest& Out)`
  - `struct FPinInfo { FString Name; bool bOutput = false; }`
  - `struct FPinResolution { FString Name; FString Error; bool IsValid() const; }`
  - `FPinResolution ResolvePinName(const TArray<FPinInfo>& Pins, const FString& Wanted, bool bOutput, bool bCast)`
  - `struct FPageWindow { int32 NodeBegin, NodeEnd, EdgeBegin, EdgeEnd; bool bHasMore; int32 NextOffset; }`
  - `FPageWindow ComputePage(int32 NodeTotal, int32 EdgeTotal, int32 Offset, int32 Limit)`
  - `FString PinLiteral(bool bTextPin, const FString& DefaultValue, const FString& DefaultTextString, const FString& DefaultObjectPath)`
  - `bool PinLiteralMatches(const FString& Applied, const FString& Wanted)`

- [ ] **Step 1: Write the failing automation tests**

In `HaybaBlueprintOpsTest.cpp`, add these includes after `#include "HaybaBlueprintOps.h"`:

```cpp
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
```

Then append the tests below immediately before `#endif // WITH_DEV_AUTOMATION_TESTS`:

```cpp
static TSharedPtr<FJsonObject> HaybaOpsTestJson(const TCHAR* Text)
{
    TSharedPtr<FJsonObject> Obj;
    FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Obj);
    return Obj;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaBlueprintOpsApplyGraphPayloadTest,
    "Hayba.MCP.BlueprintOps.ApplyGraphPayload",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaBlueprintOpsApplyGraphPayloadTest::RunTest(const FString&)
{
    using namespace HaybaBlueprintOps;
    {
        FApplyGraphRequest R;
        const TArray<FString> Errors = ParseApplyGraphPayload(HaybaOpsTestJson(TEXT(R"({
            "path": "/Game/X/BP_X", "graph_name": "Twice",
            "nodes": [
                {"key": "entry", "kind": "existing", "node_id": "A1"},
                {"key": "mul", "kind": "call", "function": "Multiply_DoubleDouble", "class": "/Script/Engine.KismetMathLibrary", "x": 300.4, "y": -20},
                {"key": "seq", "kind": "sequence", "count": 3}
            ],
            "defaults": [{"node": "mul", "pin": "B", "value": "2"}],
            "links": [{"from_node": "entry", "from_pin": "In", "to_node": "mul", "to_pin": "A"}]
        })")), R);
        TestEqual(TEXT("a well-formed payload has no problems"), Errors.Num(), 0);
        if (TestEqual(TEXT("every node is read"), R.Nodes.Num(), 3))
        {
            TestTrue(TEXT("kinds are read"), R.Nodes[0].Kind == EApplyNodeKind::Existing
                && R.Nodes[1].Kind == EApplyNodeKind::Call && R.Nodes[2].Kind == EApplyNodeKind::Sequence);
            TestEqual(TEXT("positions round to whole units"), R.Nodes[1].X, 300);
            TestEqual(TEXT("count is read"), R.Nodes[2].Count, 3);
        }
        TestEqual(TEXT("literals are read"), R.Defaults.Num(), 1);
        TestEqual(TEXT("links are read"), R.Links.Num(), 1);
    }

    auto ExpectProblem = [this](const TCHAR* Json, const TCHAR* Fragment)
    {
        FApplyGraphRequest R;
        const FString All = FString::Join(ParseApplyGraphPayload(HaybaOpsTestJson(Json), R), TEXT(" | "));
        TestTrue(FString::Printf(TEXT("reports '%s' (got: %s)"), Fragment, *All), All.Contains(Fragment));
    };
    ExpectProblem(TEXT(R"({})"), TEXT("'nodes' is required"));
    ExpectProblem(TEXT(R"({"nodes": []})"), TEXT("'nodes' is empty"));
    ExpectProblem(TEXT(R"({"nodes": [{"key": "d", "kind": "delay"}]})"), TEXT("unknown kind 'delay'"));
    ExpectProblem(TEXT(R"({"nodes": [{"key": "a", "kind": "branch"}, {"key": "a", "kind": "self"}]})"), TEXT("key is used twice"));
    ExpectProblem(TEXT(R"({"nodes": [{"key": "1a", "kind": "branch"}]})"), TEXT("key must be an identifier"));
    ExpectProblem(TEXT(R"({"nodes": [{"key": "c", "kind": "call"}]})"), TEXT("a call node needs 'function'"));
    ExpectProblem(TEXT(R"({"nodes": [{"key": "e", "kind": "existing"}]})"), TEXT("needs 'node_id'"));
    ExpectProblem(TEXT(R"({"nodes": [{"key": "s", "kind": "sequence", "count": 40}]})"), TEXT("count must be 2..32"));
    ExpectProblem(TEXT(R"({"nodes": [{"key": "b", "kind": "branch"}], "links": [{"from_node": "b", "from_pin": "then", "to_node": "ghost", "to_pin": "execute"}]})"),
        TEXT("to node 'ghost' is not in 'nodes'"));
    ExpectProblem(TEXT(R"({"nodes": [{"key": "b", "kind": "branch"}], "links": [{"from_node": "b", "from_pin": "then", "to_node": "b", "to_pin": "execute"}]})"),
        TEXT("links a node to itself"));
    ExpectProblem(TEXT(R"({"nodes": [{"key": "b", "kind": "branch"}], "defaults": [{"node": "nobody", "pin": "Condition", "value": "true"}]})"),
        TEXT("node 'nobody' is not in 'nodes'"));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaBlueprintOpsResolvePinNameTest,
    "Hayba.MCP.BlueprintOps.ResolvePinName",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaBlueprintOpsResolvePinNameTest::RunTest(const FString&)
{
    using namespace HaybaBlueprintOps;
    // Same cases as the TypeScript resolvePin test (bpgraph.test.mjs:258).
    // New nodes' pins are resolved here and verified in TS, so the two must
    // agree exactly.
    const TArray<FPinInfo> Cast = {
        { TEXT("execute"), false }, { TEXT("Object"), false },
        { TEXT("then"), true }, { TEXT("CastFailed"), true },
        { TEXT("AsPlayer Controller"), true }, { TEXT("bSuccess"), true },
    };
    TestEqual(TEXT("exact"), ResolvePinName(Cast, TEXT("Object"), false, false).Name, FString(TEXT("Object")));
    TestEqual(TEXT("case-insensitive"), ResolvePinName(Cast, TEXT("object"), false, false).Name, FString(TEXT("Object")));
    TestEqual(TEXT("space-insensitive"), ResolvePinName(Cast, TEXT("AsPlayerController"), true, false).Name, FString(TEXT("AsPlayer Controller")));
    TestEqual(TEXT("a cast's bare As"), ResolvePinName(Cast, TEXT("As"), true, true).Name, FString(TEXT("AsPlayer Controller")));
    TestTrue(TEXT("bare As only on casts"), ResolvePinName(Cast, TEXT("As"), true, false).Error.Contains(TEXT("no output pin \"As\"")));
    TestTrue(TEXT("a miss names the pins"), ResolvePinName(Cast, TEXT("Obj"), false, true).Error.Contains(TEXT("its input pins are \"execute\", \"Object\"")));
    TestTrue(TEXT("direction matters"), ResolvePinName(Cast, TEXT("then"), false, false).Error.Contains(TEXT("no input pin \"then\"")));
    // FString == ignores case, which would let the loose tier win over the exact one.
    const TArray<FPinInfo> Two = { { TEXT("Value"), false }, { TEXT("value"), false } };
    TestEqual(TEXT("exact means case-sensitive"), ResolvePinName(Two, TEXT("value"), false, false).Name, FString(TEXT("value")));
    TestTrue(TEXT("an ambiguous loose match is refused"),
        ResolvePinName(Two, TEXT("VALUE"), false, false).Error.Contains(TEXT("matches several input pins")));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaBlueprintOpsPageWindowTest,
    "Hayba.MCP.BlueprintOps.PageWindow",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaBlueprintOpsPageWindowTest::RunTest(const FString&)
{
    using namespace HaybaBlueprintOps;
    FPageWindow W = ComputePage(120, 60, 0, 50);
    TestTrue(TEXT("first page"), W.NodeBegin == 0 && W.NodeEnd == 50 && W.EdgeBegin == 0 && W.EdgeEnd == 50 && W.bHasMore && W.NextOffset == 50);
    W = ComputePage(120, 60, 50, 50);
    TestTrue(TEXT("edges run out first"), W.NodeEnd == 100 && W.EdgeBegin == 50 && W.EdgeEnd == 60 && W.bHasMore && W.NextOffset == 100);
    W = ComputePage(120, 60, 100, 50);
    TestTrue(TEXT("last page"), W.NodeBegin == 100 && W.NodeEnd == 120 && W.EdgeBegin == 60 && W.EdgeEnd == 60 && !W.bHasMore);
    W = ComputePage(50, 50, 0, 50);
    TestFalse(TEXT("an exact fit is one page"), W.bHasMore);
    W = ComputePage(10, 0, 500, 50);
    TestTrue(TEXT("an offset past the end is an empty last page, not a wrap"), W.NodeBegin == 10 && W.NodeEnd == 10 && !W.bHasMore);
    W = ComputePage(0, 0, 0, 50);
    TestTrue(TEXT("an empty graph"), W.NodeEnd == 0 && W.EdgeEnd == 0 && !W.bHasMore);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaBlueprintOpsPinLiteralTest,
    "Hayba.MCP.BlueprintOps.PinLiteral",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaBlueprintOpsPinLiteralTest::RunTest(const FString&)
{
    using namespace HaybaBlueprintOps;
    // Text pins keep their literal in DefaultTextValue. Reading DefaultValue
    // is why every text literal was reported as "not retained" (consumer handoff #2).
    TestEqual(TEXT("text pins read the text"), PinLiteral(true, TEXT(""), TEXT("Boot sequence"), TEXT("")), FString(TEXT("Boot sequence")));
    TestEqual(TEXT("other pins read DefaultValue"), PinLiteral(false, TEXT("2.0"), TEXT(""), TEXT("")), FString(TEXT("2.0")));
    TestEqual(TEXT("object pins read the object"), PinLiteral(false, TEXT(""), TEXT(""), TEXT("/Game/A.A")), FString(TEXT("/Game/A.A")));

    TestTrue(TEXT("identical"), PinLiteralMatches(TEXT("Quit"), TEXT("Quit")));
    TestTrue(TEXT("number spelling"), PinLiteralMatches(TEXT("2.000000"), TEXT("2")));
    TestTrue(TEXT("bool spelling"), PinLiteralMatches(TEXT("True"), TEXT("true")));
    TestTrue(TEXT("vector spelling"), PinLiteralMatches(TEXT("0.000000,0.000000,1000.000000"), TEXT("0,0,1000")));
    TestFalse(TEXT("a different number"), PinLiteralMatches(TEXT("2.5"), TEXT("2")));
    TestFalse(TEXT("different words"), PinLiteralMatches(TEXT("Warning"), TEXT("Safe")));
    TestFalse(TEXT("empty is not zero"), PinLiteralMatches(TEXT(""), TEXT("0")));
    TestFalse(TEXT("a different component count"), PinLiteralMatches(TEXT("0,0"), TEXT("0,0,0")));
    return true;
}
```

- [ ] **Step 2: Declare the rules in `HaybaBlueprintOps.h`**

Append inside `namespace HaybaBlueprintOps { ... }`, after `ParamNamesProblem`:

```cpp
    // ── blueprint_apply_graph payload ────────────────────────────────────────

    enum class EApplyNodeKind : uint8
    {
        Existing, Call, Get, Set, Branch, Sequence, Select, Self, Cast, CreateWidget, Timer,
    };

    /** One payload node: a node to place, or `existing` for one already in the graph. */
    struct FApplyNodeRequest
    {
        FString Key;
        EApplyNodeKind Kind = EApplyNodeKind::Existing;
        FString NodeId;     // existing
        FString Function;   // call
        FString ClassPath;  // call (optional owner), cast, create_widget
        FString Variable;   // get, set
        int32 Count = 2;    // sequence outputs, select options
        int32 X = 0;
        int32 Y = 0;
    };

    struct FApplyDefaultRequest { FString Node; FString Pin; FString Value; };
    struct FApplyLinkRequest { FString FromNode; FString FromPin; FString ToNode; FString ToPin; };

    struct FApplyGraphRequest
    {
        TArray<FApplyNodeRequest> Nodes;
        TArray<FApplyDefaultRequest> Defaults;
        TArray<FApplyLinkRequest> Links;
    };

    /** Read a blueprint_apply_graph payload and check its shape: keys, kinds,
     *  required fields per kind, and that every literal and link names a
     *  payload node. Returns every problem found; empty means well-formed.
     *  Resolves nothing against a blueprint. */
    TArray<FString> ParseApplyGraphPayload(const TSharedPtr<FJsonObject>& Params, FApplyGraphRequest& Out);

    // ── Which pin a spec name means ──────────────────────────────────────────

    struct FPinInfo { FString Name; bool bOutput = false; };
    struct FPinResolution
    {
        FString Name;
        FString Error;
        bool IsValid() const { return Error.IsEmpty() && !Name.IsEmpty(); }
    };

    /** Tries three rules in order:
     *  1. the exact, case-sensitive name;
     *  2. the name ignoring case and spaces;
     *  3. for a cast asked for "As", its single output whose name starts with "As".
     *  Mirrors resolvePin in mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/
     *  spec-plan.ts, messages included. The two must agree. */
    FPinResolution ResolvePinName(const TArray<FPinInfo>& Pins, const FString& Wanted, bool bOutput, bool bCast);

    // ── Paging a graph read ──────────────────────────────────────────────────

    /** One page: nodes [NodeBegin, NodeEnd) and edges [EdgeBegin, EdgeEnd), both
     *  from one offset. More remains while offset+limit is short of the larger total. */
    struct FPageWindow
    {
        int32 NodeBegin = 0;
        int32 NodeEnd = 0;
        int32 EdgeBegin = 0;
        int32 EdgeEnd = 0;
        bool bHasMore = false;
        int32 NextOffset = 0;
    };
    FPageWindow ComputePage(int32 NodeTotal, int32 EdgeTotal, int32 Offset, int32 Limit);

    // ── What a pin's literal is, and whether it is the one asked for ─────────

    /** The literal as a caller would write it: the object path for object pins,
     *  the text (DefaultTextValue) for text pins, otherwise DefaultValue. */
    FString PinLiteral(bool bTextPin, const FString& DefaultValue, const FString& DefaultTextString, const FString& DefaultObjectPath);

    /** Whether a stored literal means the requested one. It does if they are
     *  identical, equal ignoring case, numerically equal ("2" and "2.000000"),
     *  or comma-separated lists whose components each match. */
    bool PinLiteralMatches(const FString& Applied, const FString& Wanted);
```

- [ ] **Step 3: Implement the rules in `HaybaBlueprintOps.cpp`**

Add `#include "Dom/JsonValue.h"` after the existing includes. Append inside `namespace HaybaBlueprintOps { ... }`:

```cpp
    static bool IsIdentifier(const FString& S)
    {
        if (S.IsEmpty() || !(FChar::IsAlpha(S[0]) || S[0] == TEXT('_'))) return false;
        for (const TCHAR C : S)
        {
            if (!(FChar::IsAlnum(C) || C == TEXT('_'))) return false;
        }
        return true;
    }

    static const TCHAR* ApplyNodeKindList =
        TEXT("existing, call, get, set, branch, sequence, select, self, cast, create_widget, timer");

    TArray<FString> ParseApplyGraphPayload(const TSharedPtr<FJsonObject>& Params, FApplyGraphRequest& Out)
    {
        TArray<FString> Errors;
        Out = FApplyGraphRequest();
        if (!Params.IsValid())
        {
            Errors.Add(TEXT("no params object was supplied"));
            return Errors;
        }

        auto ReadArray = [&Params, &Errors](const TCHAR* Field, int32 Max, bool bRequired) -> const TArray<TSharedPtr<FJsonValue>>*
        {
            if (!Params->HasField(Field))
            {
                if (bRequired) Errors.Add(FString::Printf(TEXT("'%s' is required"), Field));
                return nullptr;
            }
            const TArray<TSharedPtr<FJsonValue>>* Items = nullptr;
            if (!Params->TryGetArrayField(Field, Items) || !Items)
            {
                Errors.Add(FString::Printf(TEXT("'%s' must be an array"), Field));
                return nullptr;
            }
            if (Items->Num() > Max)
            {
                Errors.Add(FString::Printf(TEXT("'%s' has %d entries; the limit is %d"), Field, Items->Num(), Max));
                return nullptr;
            }
            return Items;
        };
        auto ItemObject = [](const TSharedPtr<FJsonValue>& V) -> TSharedPtr<FJsonObject>
        {
            const TSharedPtr<FJsonObject>* Obj = nullptr;
            return (V.IsValid() && V->TryGetObject(Obj) && Obj) ? *Obj : nullptr;
        };

        static const TMap<FString, EApplyNodeKind> Kinds = {
            { TEXT("existing"), EApplyNodeKind::Existing }, { TEXT("call"), EApplyNodeKind::Call },
            { TEXT("get"), EApplyNodeKind::Get },           { TEXT("set"), EApplyNodeKind::Set },
            { TEXT("branch"), EApplyNodeKind::Branch },     { TEXT("sequence"), EApplyNodeKind::Sequence },
            { TEXT("select"), EApplyNodeKind::Select },     { TEXT("self"), EApplyNodeKind::Self },
            { TEXT("cast"), EApplyNodeKind::Cast },         { TEXT("create_widget"), EApplyNodeKind::CreateWidget },
            { TEXT("timer"), EApplyNodeKind::Timer },
        };

        TSet<FString> Keys;
        TSet<FString> ExistingIds;
        if (const TArray<TSharedPtr<FJsonValue>>* Items = ReadArray(TEXT("nodes"), 512, true))
        {
            if (Items->Num() == 0) Errors.Add(TEXT("'nodes' is empty; a payload places or references at least one node"));
            for (int32 I = 0; I < Items->Num(); ++I)
            {
                const TSharedPtr<FJsonObject> Obj = ItemObject((*Items)[I]);
                if (!Obj)
                {
                    Errors.Add(FString::Printf(TEXT("nodes[%d] must be an object"), I));
                    continue;
                }
                FApplyNodeRequest R;
                FString KindName;
                Obj->TryGetStringField(TEXT("key"), R.Key);
                Obj->TryGetStringField(TEXT("kind"), KindName);
                Obj->TryGetStringField(TEXT("node_id"), R.NodeId);
                Obj->TryGetStringField(TEXT("function"), R.Function);
                Obj->TryGetStringField(TEXT("class"), R.ClassPath);
                Obj->TryGetStringField(TEXT("variable"), R.Variable);
                double Number = 0.0;
                if (Obj->TryGetNumberField(TEXT("count"), Number)) R.Count = FMath::RoundToInt(Number);
                if (Obj->TryGetNumberField(TEXT("x"), Number)) R.X = FMath::RoundToInt(Number);
                if (Obj->TryGetNumberField(TEXT("y"), Number)) R.Y = FMath::RoundToInt(Number);

                const FString At = R.Key.IsEmpty() ? FString::Printf(TEXT("nodes[%d]"), I) : FString::Printf(TEXT("node '%s'"), *R.Key);
                if (!IsIdentifier(R.Key)) Errors.Add(FString::Printf(TEXT("%s: key must be an identifier"), *At));
                else if (Keys.Contains(R.Key)) Errors.Add(FString::Printf(TEXT("%s: key is used twice"), *At));
                else Keys.Add(R.Key);

                const FString Kind = KindName.ToLower();
                const EApplyNodeKind* Found = Kinds.Find(Kind);
                if (!Found)
                {
                    Errors.Add(FString::Printf(TEXT("%s: unknown kind '%s'; valid kinds: %s"), *At, *KindName, ApplyNodeKindList));
                    continue;
                }
                R.Kind = *Found;
                auto Need = [&Errors, &At, &Kind](const FString& Value, const TCHAR* Field)
                {
                    if (Value.IsEmpty()) Errors.Add(FString::Printf(TEXT("%s: a %s node needs '%s'"), *At, *Kind, Field));
                };
                switch (R.Kind)
                {
                case EApplyNodeKind::Existing:
                    Need(R.NodeId, TEXT("node_id"));
                    if (!R.NodeId.IsEmpty() && ExistingIds.Contains(R.NodeId))
                        Errors.Add(FString::Printf(TEXT("%s: node_id %s is referenced by two keys"), *At, *R.NodeId));
                    ExistingIds.Add(R.NodeId);
                    break;
                case EApplyNodeKind::Call: Need(R.Function, TEXT("function")); break;
                case EApplyNodeKind::Get:
                case EApplyNodeKind::Set: Need(R.Variable, TEXT("variable")); break;
                case EApplyNodeKind::Cast:
                case EApplyNodeKind::CreateWidget: Need(R.ClassPath, TEXT("class")); break;
                case EApplyNodeKind::Sequence:
                case EApplyNodeKind::Select:
                    if (R.Count < 2 || R.Count > 32)
                        Errors.Add(FString::Printf(TEXT("%s: count must be 2..32, got %d"), *At, R.Count));
                    break;
                default:
                    break;
                }
                Out.Nodes.Add(R);
            }
        }

        if (const TArray<TSharedPtr<FJsonValue>>* Items = ReadArray(TEXT("defaults"), 1024, false))
        {
            for (int32 I = 0; I < Items->Num(); ++I)
            {
                const TSharedPtr<FJsonObject> Obj = ItemObject((*Items)[I]);
                FApplyDefaultRequest D;
                if (!Obj || !Obj->TryGetStringField(TEXT("node"), D.Node) || !Obj->TryGetStringField(TEXT("pin"), D.Pin)
                    || !Obj->TryGetStringField(TEXT("value"), D.Value))
                {
                    Errors.Add(FString::Printf(TEXT("defaults[%d] must be {\"node\", \"pin\", \"value\"}"), I));
                    continue;
                }
                if (!Keys.Contains(D.Node))
                    Errors.Add(FString::Printf(TEXT("defaults[%d] (%s.%s): node '%s' is not in 'nodes'"), I, *D.Node, *D.Pin, *D.Node));
                if (D.Pin.TrimStartAndEnd().IsEmpty())
                    Errors.Add(FString::Printf(TEXT("defaults[%d]: pin is empty"), I));
                Out.Defaults.Add(D);
            }
        }

        if (const TArray<TSharedPtr<FJsonValue>>* Items = ReadArray(TEXT("links"), 1024, false))
        {
            for (int32 I = 0; I < Items->Num(); ++I)
            {
                const TSharedPtr<FJsonObject> Obj = ItemObject((*Items)[I]);
                FApplyLinkRequest L;
                if (!Obj || !Obj->TryGetStringField(TEXT("from_node"), L.FromNode) || !Obj->TryGetStringField(TEXT("from_pin"), L.FromPin)
                    || !Obj->TryGetStringField(TEXT("to_node"), L.ToNode) || !Obj->TryGetStringField(TEXT("to_pin"), L.ToPin))
                {
                    Errors.Add(FString::Printf(TEXT("links[%d] must be {\"from_node\", \"from_pin\", \"to_node\", \"to_pin\"}"), I));
                    continue;
                }
                const FString At = FString::Printf(TEXT("links[%d] (%s.%s -> %s.%s)"), I, *L.FromNode, *L.FromPin, *L.ToNode, *L.ToPin);
                if (!Keys.Contains(L.FromNode)) Errors.Add(FString::Printf(TEXT("%s: from node '%s' is not in 'nodes'"), *At, *L.FromNode));
                if (!Keys.Contains(L.ToNode)) Errors.Add(FString::Printf(TEXT("%s: to node '%s' is not in 'nodes'"), *At, *L.ToNode));
                if (L.FromNode.Equals(L.ToNode, ESearchCase::CaseSensitive)) Errors.Add(FString::Printf(TEXT("%s: links a node to itself"), *At));
                Out.Links.Add(L);
            }
        }
        return Errors;
    }

    static FString LoosePinName(const FString& S)
    {
        FString Out;
        for (const TCHAR C : S)
        {
            if (!FChar::IsWhitespace(C)) Out.AppendChar(FChar::ToLower(C));
        }
        return Out;
    }

    FPinResolution ResolvePinName(const TArray<FPinInfo>& Pins, const FString& Wanted, bool bOutput, bool bCast)
    {
        const TCHAR* Direction = bOutput ? TEXT("output") : TEXT("input");
        TArray<const FPinInfo*> Candidates;
        for (const FPinInfo& P : Pins)
        {
            if (P.bOutput == bOutput) Candidates.Add(&P);
        }
        for (const FPinInfo* P : Candidates)
        {
            if (P->Name.Equals(Wanted, ESearchCase::CaseSensitive)) return { P->Name, FString() };
        }
        const FString LooseWanted = LoosePinName(Wanted);
        TArray<const FPinInfo*> Near;
        for (const FPinInfo* P : Candidates)
        {
            if (LoosePinName(P->Name).Equals(LooseWanted, ESearchCase::CaseSensitive)) Near.Add(P);
        }
        if (Near.Num() == 1) return { Near[0]->Name, FString() };
        if (Near.Num() > 1)
        {
            TArray<FString> Names;
            for (const FPinInfo* P : Near) Names.Add(P->Name);
            return { FString(), FString::Printf(TEXT("\"%s\" matches several %s pins: %s"), *Wanted, Direction, *FString::Join(Names, TEXT(", "))) };
        }
        if (bCast && LooseWanted.Equals(TEXT("as"), ESearchCase::CaseSensitive))
        {
            TArray<const FPinInfo*> As;
            for (const FPinInfo* P : Candidates)
            {
                if (P->Name.StartsWith(TEXT("As"), ESearchCase::IgnoreCase)) As.Add(P);
            }
            if (As.Num() == 1) return { As[0]->Name, FString() };
        }
        TArray<FString> Names;
        for (const FPinInfo* P : Candidates) Names.Add(FString::Printf(TEXT("\"%s\""), *P->Name));
        return { FString(), FString::Printf(TEXT("no %s pin \"%s\"; its %s pins are %s"), Direction, *Wanted, Direction,
            Names.Num() > 0 ? *FString::Join(Names, TEXT(", ")) : TEXT("(none)")) };
    }

    FPageWindow ComputePage(int32 NodeTotal, int32 EdgeTotal, int32 Offset, int32 Limit)
    {
        FPageWindow W;
        const int32 Nodes = FMath::Max(0, NodeTotal);
        const int32 Edges = FMath::Max(0, EdgeTotal);
        const int32 Start = FMath::Max(0, Offset);
        const int32 End = Start + FMath::Max(1, Limit);
        W.NodeBegin = FMath::Min(Start, Nodes);
        W.NodeEnd = FMath::Min(End, Nodes);
        W.EdgeBegin = FMath::Min(Start, Edges);
        W.EdgeEnd = FMath::Min(End, Edges);
        W.bHasMore = End < FMath::Max(Nodes, Edges);
        W.NextOffset = W.bHasMore ? End : 0;
        return W;
    }

    FString PinLiteral(bool bTextPin, const FString& DefaultValue, const FString& DefaultTextString, const FString& DefaultObjectPath)
    {
        if (!DefaultObjectPath.IsEmpty()) return DefaultObjectPath;
        return bTextPin ? DefaultTextString : DefaultValue;
    }

    static bool LiteralTokenMatches(const FString& A, const FString& B)
    {
        const FString TA = A.TrimStartAndEnd();
        const FString TB = B.TrimStartAndEnd();
        if (TA.Equals(TB, ESearchCase::IgnoreCase)) return true;
        if (TA.IsEmpty() || TB.IsEmpty() || !TA.IsNumeric() || !TB.IsNumeric()) return false;
        return FMath::Abs(FCString::Atod(*TA) - FCString::Atod(*TB)) < 1e-6;
    }

    bool PinLiteralMatches(const FString& Applied, const FString& Wanted)
    {
        if (Applied.Equals(Wanted, ESearchCase::CaseSensitive)) return true;
        if (LiteralTokenMatches(Applied, Wanted)) return true;
        TArray<FString> A, W;
        Applied.ParseIntoArray(A, TEXT(","), false);
        Wanted.ParseIntoArray(W, TEXT(","), false);
        if (A.Num() < 2 || A.Num() != W.Num()) return false;
        for (int32 I = 0; I < A.Num(); ++I)
        {
            if (!LiteralTokenMatches(A[I], W[I])) return false;
        }
        return true;
    }
```

- [ ] **Step 4: Compile the plugin**

Run the C++ compile gate from Global Constraints.
Expected: `BUILD SUCCESSFUL`. The four tests need an editor, so they run in Task 11 Step 6.

- [ ] **Step 5: Run the TS gate**

Run: `cd mcp-tools/hayba-mcp && npx tsc --noEmit && npx vitest run`
Expected: the known pre-existing failure only.

- [ ] **Step 6: Commit**

```bash
git add unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Public/HaybaBlueprintOps.h unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaBlueprintOps.cpp unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaBlueprintOpsTest.cpp
git commit -m "feat(blueprint): pure rules for bulk graph payloads, pin names, paging and literals"
```

---

### Task 5: Paged inspect with enabled/default fields, and the text-pin fix

**Files:**
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPBlueprintHandler.cpp`, in three places:
  - `HaybaDescribeNode` (~:844)
  - the `SetPinDefault` readback (~:1194-1198)
  - `InspectGraph` (~:1352-1374)
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCommandHandler.cpp`, the response limits block (~:1590-1616)
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaBlueprintTestScratch.h`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaMCPBlueprintInspectTest.cpp`
- Test (source contract): `mcp-tools/hayba-mcp/src/tools/blueprint-graph-handler-contract.test.ts`

**Interfaces:**
- Consumes: `ComputePage`, `PinLiteral`, `PinLiteralMatches` (Task 4).
- Produces:
  - `blueprint_inspect_graph` params: `{path, graph_name?, offset?=0 (0..1000000), limit?=100 (1..200)}`.
  - `blueprint_inspect_graph` reply: `{path, graph, nodes[], edges[], node_count, edge_count, offset, limit, has_more, next_offset?, dirty}`. The counts are whole-graph totals.
  - Each node is `{node_id, title, enabled, pins:[{name, direction, type, default}]}`. The same `enabled` and `default` fields appear on every command that describes nodes.
  - `static FString HaybaPinLiteral(const UEdGraphPin*)` in the handler .cpp.
  - Test helpers in `HaybaBlueprintTestScratch.h`:
    - `struct FHaybaScratchBlueprint { UPackage* Package; UBlueprint* Blueprint; explicit FHaybaScratchBlueprint(const TCHAR* Prefix); FString Path() const; }`
    - `TSharedPtr<FJsonObject> HaybaTestJson(const FString& Text)`

- [ ] **Step 1: Write the failing source-contract tests**

Append to `mcp-tools/hayba-mcp/src/tools/blueprint-graph-handler-contract.test.ts`:

```ts
/** A handler body, from its definition to the next handler definition. */
function handlerBody(name: string): string {
  const start = source.indexOf(`FHaybaHandlerResult FHaybaMCPBlueprintHandler::${name}(`);
  expect(start, `${name} handler not found`).toBeGreaterThan(-1);
  const next = source.indexOf('\nFHaybaHandlerResult FHaybaMCPBlueprintHandler::', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe('graph reads a caller can trust', () => {
  it('pages inspect_graph over nodes and edges from one offset', () => {
    const body = handlerBody('InspectGraph');
    expect(body).toContain('HaybaBlueprintOps::ComputePage');
    expect(body).toContain('TEXT("next_offset")');
    expect(body).toContain('TEXT("has_more")');
  });

  it("reports whether each node is enabled and each pin's literal", () => {
    const start = source.indexOf('static TSharedPtr<FJsonObject> HaybaDescribeNode(');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    expect(body).toContain('TEXT("enabled")');
    expect(body).toContain('IsAutomaticallyPlacedGhostNode');
    expect(body).toContain('TEXT("default"), HaybaPinLiteral(Pin)');
  });

  it('reads a text literal back from the text, not DefaultValue', () => {
    const body = handlerBody('SetPinDefault');
    expect(body).toContain('HaybaBlueprintOps::PinLiteralMatches(Applied, Value)');
    expect(body).not.toContain(': Pin->DefaultValue == Value');
  });

  it('never lets the 50-item response cap trim a graph page', () => {
    const limits = commandHandler.slice(commandHandler.indexOf('FHaybaResponseLimits Limits;'));
    expect(limits).toMatch(/Cmd == TEXT\("blueprint_inspect_graph"\)[\s\S]*?Limits\.MaxArrayItems = 256;/);
    expect(limits).toContain('Cmd == TEXT("blueprint_get_info")');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/blueprint-graph-handler-contract.test.ts`
Expected: FAIL in the four new tests.

- [ ] **Step 3: Add `HaybaPinLiteral` and extend `HaybaDescribeNode`**

Insert this in `HaybaMCPBlueprintHandler.cpp` immediately before `static TSharedPtr<FJsonObject> HaybaDescribeNode(UEdGraphNode* Node)`:

```cpp
/** The literal a pin holds, as a caller would write it. Text pins keep it in
 *  DefaultTextValue and object pins in DefaultObject — reading DefaultValue
 *  alone reported every text literal as missing. */
static FString HaybaPinLiteral(const UEdGraphPin* Pin)
{
    return HaybaBlueprintOps::PinLiteral(
        Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Text,
        Pin->DefaultValue,
        Pin->DefaultTextValue.ToString(),
        Pin->DefaultObject ? Pin->DefaultObject->GetPathName() : FString());
}
```

In `HaybaDescribeNode`, after the `title` field, add:

```cpp
    // A new blueprint's BeginPlay/Tick are disabled "ghost" nodes that look like
    // real ones and never run until something is wired to them.
    Out->SetBoolField(TEXT("enabled"), Node->IsNodeEnabled() && !Node->IsAutomaticallyPlacedGhostNode());
```

In the pin loop of `HaybaDescribeNode`, after the `type` field, add:

```cpp
        PinObj->SetStringField(TEXT("default"), HaybaPinLiteral(Pin));
```

- [ ] **Step 4: Fix the `SetPinDefault` readback**

Replace:

```cpp
    Out->SetStringField(TEXT("applied"), Pin->DefaultObject ? Pin->DefaultObject->GetPathName() : Pin->DefaultValue);
    const bool bVerified = bHardObjectPin
        ? Pin->DefaultObject == ResolvedDefaultObject
        : Pin->DefaultValue == Value;
```

with:

```cpp
    const FString Applied = HaybaPinLiteral(Pin);
    Out->SetStringField(TEXT("applied"), Applied);
    // Text pins keep the literal in DefaultTextValue; comparing DefaultValue
    // reported text literals as not retained although they had stuck.
    const bool bVerified = bHardObjectPin
        ? Pin->DefaultObject == ResolvedDefaultObject
        : HaybaBlueprintOps::PinLiteralMatches(Applied, Value);
```

- [ ] **Step 5: Replace `InspectGraph` with the paged version**

```cpp
FHaybaHandlerResult FHaybaMCPBlueprintHandler::InspectGraph(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader ParamR(P, TEXT("blueprint_inspect_graph"));
    const FString Path = ParamR.RequiredString(TEXT("path"));
    const FString GraphName = ParamR.OptionalString(TEXT("graph_name"));
    // A page is at most 200 nodes and 200 edges. The response builder's override
    // for this command (HaybaMCPCommandHandler.cpp) is 256, so a page is never
    // trimmed. The caller reads on with next_offset until has_more is false.
    const int32 Offset = ParamR.OptionalIntInRange(TEXT("offset"), 0, 0, 1000000);
    const int32 Limit = ParamR.OptionalIntInRange(TEXT("limit"), 100, 1, 200);
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(BlueprintNotFoundError(TEXT("blueprint_inspect_graph"), Path));
    UEdGraph* Graph = HaybaFindGraph(BP, GraphName);
    if (!Graph) return FHaybaHandlerResult::Err(TEXT("blueprint_inspect_graph: graph not found"));

    // Every node and edge in one stable order (graph node order, pin order,
    // link order), so consecutive pages neither skip nor repeat an item.
    TArray<UEdGraphNode*> AllNodes;
    TArray<TSharedPtr<FJsonValue>> AllEdges;
    for (UEdGraphNode* Node : Graph->Nodes)
    {
        if (!Node) continue;
        AllNodes.Add(Node);
        for (UEdGraphPin* Pin : Node->Pins)
        {
            if (!Pin || Pin->Direction != EGPD_Output) continue;
            for (UEdGraphPin* Linked : Pin->LinkedTo)
            {
                if (!Linked || !Linked->GetOwningNode()) continue;
                TSharedPtr<FJsonObject> Edge = MakeShared<FJsonObject>();
                Edge->SetStringField(TEXT("from_node"), Node->NodeGuid.ToString());
                Edge->SetStringField(TEXT("from_pin"), Pin->PinName.ToString());
                Edge->SetStringField(TEXT("to_node"), Linked->GetOwningNode()->NodeGuid.ToString());
                Edge->SetStringField(TEXT("to_pin"), Linked->PinName.ToString());
                AllEdges.Add(MakeShared<FJsonValueObject>(Edge.ToSharedRef()));
            }
        }
    }

    const HaybaBlueprintOps::FPageWindow Window =
        HaybaBlueprintOps::ComputePage(AllNodes.Num(), AllEdges.Num(), Offset, Limit);
    TArray<TSharedPtr<FJsonValue>> Nodes, Edges;
    for (int32 I = Window.NodeBegin; I < Window.NodeEnd; ++I)
        Nodes.Add(MakeShared<FJsonValueObject>(HaybaDescribeNode(AllNodes[I]).ToSharedRef()));
    for (int32 I = Window.EdgeBegin; I < Window.EdgeEnd; ++I)
        Edges.Add(AllEdges[I]);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), BP->GetPathName());
    Out->SetStringField(TEXT("graph"), Graph->GetName());
    Out->SetArrayField(TEXT("nodes"), Nodes);
    Out->SetArrayField(TEXT("edges"), Edges);
    Out->SetNumberField(TEXT("node_count"), AllNodes.Num());
    Out->SetNumberField(TEXT("edge_count"), AllEdges.Num());
    Out->SetNumberField(TEXT("offset"), Offset);
    Out->SetNumberField(TEXT("limit"), Limit);
    Out->SetBoolField(TEXT("has_more"), Window.bHasMore);
    if (Window.bHasMore) Out->SetNumberField(TEXT("next_offset"), Window.NextOffset);
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    return FHaybaHandlerResult::Ok(Out);
}
```

- [ ] **Step 6: Add the response-builder override**

In `HaybaMCPCommandHandler.cpp`, insert this branch before `else if (Cmd == TEXT("editor_pie_actor_list") ...`:

```cpp
        else if (Cmd == TEXT("blueprint_inspect_graph")
            || Cmd == TEXT("blueprint_apply_graph")
            || Cmd == TEXT("blueprint_get_info"))
        {
            // Graph pages, bulk-apply results and member lists carry node ids,
            // pin names and counts that callers match exactly. inspect pages are
            // capped at 200 by the handler. The generic 50-item cap turned every
            // large graph into a silent partial read, and hid variables past 50
            // from blueprint_get_info.
            Limits.MaxArrayItems = 256;
            Limits.MaxStringChars = 2048;
        }
```

- [ ] **Step 7: Write the scratch-blueprint test helper**

```cpp
// unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaBlueprintTestScratch.h
#pragma once

#if WITH_DEV_AUTOMATION_TESTS && WITH_EDITOR
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "GameFramework/Actor.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/Package.h"

/** A throwaway Actor Blueprint in /Temp. It is never saved, never enters the
 *  asset registry, and is marked for collection when the test ends. Handlers
 *  find it by path because LoadObject resolves in-memory objects first. */
struct FHaybaScratchBlueprint
{
    UPackage* Package = nullptr;
    UBlueprint* Blueprint = nullptr;

    explicit FHaybaScratchBlueprint(const TCHAR* Prefix)
    {
        const FString Name = FString::Printf(TEXT("%s_%s"), Prefix, *FGuid::NewGuid().ToString(EGuidFormats::Digits));
        Package = CreatePackage(*(FString(TEXT("/Temp/HaybaMCPAutomation/")) + Name));
        Blueprint = Package ? FKismetEditorUtilities::CreateBlueprint(
            AActor::StaticClass(), Package, *Name, BPTYPE_Normal,
            UBlueprint::StaticClass(), UBlueprintGeneratedClass::StaticClass()) : nullptr;
    }

    ~FHaybaScratchBlueprint()
    {
        if (Package) Package->SetDirtyFlag(false);
        if (Blueprint)
        {
            Blueprint->ClearFlags(RF_Public | RF_Standalone);
            Blueprint->MarkAsGarbage();
        }
        if (Package) Package->MarkAsGarbage();
    }

    FString Path() const { return Blueprint ? Blueprint->GetPathName() : FString(); }
};

inline TSharedPtr<FJsonObject> HaybaTestJson(const FString& Text)
{
    TSharedPtr<FJsonObject> Obj;
    FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Obj);
    return Obj;
}
#endif
```

- [ ] **Step 8: Write the inspect and text-pin automation tests**

```cpp
// unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaMCPBlueprintInspectTest.cpp
// Graph reads a caller can build on: every node and edge reachable through
// pages, ghost nodes visible as disabled, and text literals read back.
#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS && WITH_EDITOR
#include "Tests/HaybaBlueprintTestScratch.h"
#include "handlers/HaybaMCPBlueprintHandler.h"
#include "EdGraph/EdGraph.h"
#include "K2Node_IfThenElse.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPBlueprintInspectPagingTest,
    "Hayba.MCP.Blueprint.InspectGraph.PagesEveryNodeAndEdge",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPBlueprintInspectPagingTest::RunTest(const FString&)
{
    FHaybaScratchBlueprint Scratch(TEXT("BP_InspectPaging"));
    if (!TestNotNull(TEXT("scratch blueprint"), Scratch.Blueprint)) return false;
    UEdGraph* Graph = Scratch.Blueprint->UbergraphPages.Num() > 0 ? Scratch.Blueprint->UbergraphPages[0] : nullptr;
    if (!TestNotNull(TEXT("event graph"), Graph)) return false;

    TArray<UK2Node_IfThenElse*> Branches;
    for (int32 I = 0; I < 60; ++I)
    {
        UK2Node_IfThenElse* Node = NewObject<UK2Node_IfThenElse>(Graph);
        Node->CreateNewGuid();
        Node->NodePosX = I * 300;
        Graph->AddNode(Node, false, false);
        Node->PostPlacedNewNode();
        Node->AllocateDefaultPins();
        Branches.Add(Node);
    }
    for (int32 I = 0; I + 1 < Branches.Num(); ++I)
        Branches[I]->GetThenPin()->MakeLinkTo(Branches[I + 1]->GetExecPin());
    // Make a ghost node explicitly, rather than rely on which default events
    // the engine placed.
    Branches.Last()->MakeAutomaticallyPlacedGhostNode();
    const FString GhostId = Branches.Last()->NodeGuid.ToString();

    int32 ExpectedEdges = 0;
    for (UEdGraphNode* N : Graph->Nodes)
        for (UEdGraphPin* Pin : N->Pins)
            if (Pin->Direction == EGPD_Output) ExpectedEdges += Pin->LinkedTo.Num();

    FHaybaMCPBlueprintHandler Handler;
    TSet<FString> SeenNodes;
    int32 SeenEdges = 0;
    int32 Offset = 0;
    int32 Pages = 0;
    bool bGhostReportedDisabled = false;
    for (; Pages < 20; ++Pages)
    {
        TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
        Params->SetStringField(TEXT("path"), Scratch.Path());
        Params->SetNumberField(TEXT("offset"), Offset);
        Params->SetNumberField(TEXT("limit"), 20);
        const FHaybaHandlerResult Page = Handler.Handle(TEXT("blueprint_inspect_graph"), Params);
        if (!TestTrue(TEXT("each page is served"), Page.bOk && Page.Data.IsValid())) return false;
        TestEqual(TEXT("node_count is the whole graph on every page"), (int32)Page.Data->GetNumberField(TEXT("node_count")), Graph->Nodes.Num());
        TestEqual(TEXT("edge_count is the whole graph on every page"), (int32)Page.Data->GetNumberField(TEXT("edge_count")), ExpectedEdges);
        for (const TSharedPtr<FJsonValue>& V : Page.Data->GetArrayField(TEXT("nodes")))
        {
            const TSharedPtr<FJsonObject> N = V->AsObject();
            SeenNodes.Add(N->GetStringField(TEXT("node_id")));
            TestTrue(TEXT("every node says whether it is enabled"), N->HasField(TEXT("enabled")));
            if (N->GetStringField(TEXT("node_id")) == GhostId) bGhostReportedDisabled = !N->GetBoolField(TEXT("enabled"));
        }
        SeenEdges += Page.Data->GetArrayField(TEXT("edges")).Num();
        if (!Page.Data->GetBoolField(TEXT("has_more"))) break;
        const int32 Next = (int32)Page.Data->GetNumberField(TEXT("next_offset"));
        if (!TestTrue(TEXT("next_offset advances"), Next > Offset)) return false;
        Offset = Next;
    }
    TestEqual(TEXT("paging reaches every node once"), SeenNodes.Num(), Graph->Nodes.Num());
    TestEqual(TEXT("paging reaches every edge once"), SeenEdges, ExpectedEdges);
    TestTrue(TEXT("more than one page was needed"), Pages >= 2);
    TestTrue(TEXT("a ghost node reports enabled:false"), bGhostReportedDisabled);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPBlueprintTextPinDefaultTest,
    "Hayba.MCP.Blueprint.SetPinDefault.TextPinVerifies",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPBlueprintTextPinDefaultTest::RunTest(const FString&)
{
    FHaybaScratchBlueprint Scratch(TEXT("BP_TextPin"));
    if (!TestNotNull(TEXT("scratch blueprint"), Scratch.Blueprint)) return false;
    FHaybaMCPBlueprintHandler Handler;

    // PrintText takes its FText by value, so InText accepts a literal.
    TSharedPtr<FJsonObject> Add = MakeShared<FJsonObject>();
    Add->SetStringField(TEXT("path"), Scratch.Path());
    Add->SetStringField(TEXT("node_type"), TEXT("call_function"));
    Add->SetStringField(TEXT("function_name"), TEXT("PrintText"));
    Add->SetStringField(TEXT("class_path"), TEXT("/Script/Engine.KismetSystemLibrary"));
    const FHaybaHandlerResult Added = Handler.Handle(TEXT("blueprint_add_node"), Add);
    if (!TestTrue(TEXT("PrintText is placed"), Added.bOk && Added.Data.IsValid())) return false;
    const FString NodeId = Added.Data->GetStringField(TEXT("node_id"));

    TSharedPtr<FJsonObject> Set = MakeShared<FJsonObject>();
    Set->SetStringField(TEXT("path"), Scratch.Path());
    Set->SetStringField(TEXT("node_id"), NodeId);
    Set->SetStringField(TEXT("pin_name"), TEXT("InText"));
    Set->SetStringField(TEXT("value"), TEXT("Boot sequence"));
    const FHaybaHandlerResult Result = Handler.Handle(TEXT("blueprint_set_pin_default"), Set);
    if (!TestTrue(TEXT("set_pin_default answers"), Result.bOk && Result.Data.IsValid())) return false;
    TestTrue(TEXT("a text literal verifies"), Result.Data->GetBoolField(TEXT("verified")));
    TestEqual(TEXT("applied is the text"), Result.Data->GetStringField(TEXT("applied")), FString(TEXT("Boot sequence")));

    TSharedPtr<FJsonObject> Read = MakeShared<FJsonObject>();
    Read->SetStringField(TEXT("path"), Scratch.Path());
    const FHaybaHandlerResult Inspected = Handler.Handle(TEXT("blueprint_inspect_graph"), Read);
    FString Literal;
    for (const TSharedPtr<FJsonValue>& V : Inspected.Data->GetArrayField(TEXT("nodes")))
    {
        if (V->AsObject()->GetStringField(TEXT("node_id")) != NodeId) continue;
        for (const TSharedPtr<FJsonValue>& PinV : V->AsObject()->GetArrayField(TEXT("pins")))
            if (PinV->AsObject()->GetStringField(TEXT("name")) == TEXT("InText")) Literal = PinV->AsObject()->GetStringField(TEXT("default"));
    }
    TestEqual(TEXT("inspect reports the text literal"), Literal, FString(TEXT("Boot sequence")));
    return true;
}
#endif
```

- [ ] **Step 9: Run the contract test to verify it passes**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/blueprint-graph-handler-contract.test.ts`
Expected: PASS. This includes the existing assertions on `HaybaDescribeNode(Node)` and `Linked->GetOwningNode()->NodeGuid`.

- [ ] **Step 10: Compile the plugin, then run the TS gate**

Run the C++ compile gate, then `cd mcp-tools/hayba-mcp && npx tsc --noEmit && npx vitest run`.
Expected: `BUILD SUCCESSFUL`, and only the known TS failure.

- [ ] **Step 11: Commit**

```bash
git add unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPBlueprintHandler.cpp unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCommandHandler.cpp unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaBlueprintTestScratch.h unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaMCPBlueprintInspectTest.cpp mcp-tools/hayba-mcp/src/tools/blueprint-graph-handler-contract.test.ts
git commit -m "feat(blueprint): page inspect_graph, report enabled and pin literals, verify text pins"
```

---

### Task 6: `blueprint_set_component_property`

**Files:**
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPBlueprintHandler.h`
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPBlueprintHandler.cpp`
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCommandHandler.cpp` (`DestructiveCommands`)
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaMCPBlueprintComponentTest.cpp`
- Test (source contract): `mcp-tools/hayba-mcp/src/tools/blueprint-graph-handler-contract.test.ts`

**Interfaces:**
- Consumes:
  - `FHaybaScratchBlueprint` (Task 5).
  - Existing helpers: `HaybaValidateMutationJsonShape`, `HaybaReflection::SetValueFromJson`, `LoadBPByPath`, `BlueprintNotFoundError`.
- Produces the wire command `blueprint_set_component_property`:
  - params: `{path, component_name, property, value}`
  - reply: `{component_name, property, applied, verified, dirty, note}`
  - It is registered as a mutating command (the broken-blueprint gate) and as a destructive one (plan gate plus transaction).

- [ ] **Step 1: Write the failing contract test**

Append to `blueprint-graph-handler-contract.test.ts`:

```ts
describe('component template properties', () => {
  it('advertises, routes, gates and plan-gates blueprint_set_component_property', () => {
    expect(textLiterals(setLiteral(source, 'FHaybaMCPBlueprintHandler::GetCommands() const'))).toContain('blueprint_set_component_property');
    expect(source).toMatch(/if \(Cmd == TEXT\("blueprint_set_component_property"\)\)\s*return SetComponentProperty\(P\);/);
    expect(textLiterals(setLiteral(source, 'static const TSet<FString> MutatingCommands'))).toContain('blueprint_set_component_property');
    expect(textLiterals(setLiteral(commandHandler, 'static const TSet<FString> DestructiveCommands'))).toContain('blueprint_set_component_property');
  });

  it('stages the value before touching the template and verifies by readback', () => {
    const body = handlerBody('SetComponentProperty');
    expect(body).toContain('ComponentTemplate');
    expect(body.indexOf('HaybaReflection::SetValueFromJson')).toBeLessThan(body.indexOf('Template->Modify()'));
    expect(body).toContain('TEXT("verified")');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/blueprint-graph-handler-contract.test.ts`
Expected: FAIL.

- [ ] **Step 3: Declare, advertise, gate and route the command**

1. In `HaybaMCPBlueprintHandler.h`, after `RemoveNode`, add:
   ```cpp
       /** Set one property on a component's template in this blueprint's own component tree (SCS). */
       FHaybaHandlerResult SetComponentProperty(const TSharedPtr<FJsonObject>& P);
   ```
2. In `GetCommands()` and in `MutatingCommands`, add `TEXT("blueprint_set_component_property"),` after `TEXT("blueprint_remove_node"),`.
3. In `Handle`, after the `blueprint_remove_node` line, add:
   ```cpp
       if (Cmd == TEXT("blueprint_set_component_property")) return SetComponentProperty(P);
   ```
4. In `HaybaMCPCommandHandler.cpp`, add `TEXT("blueprint_set_component_property"),` to `DestructiveCommands` after `TEXT("blueprint_remove_node"),`.

- [ ] **Step 4: Implement `SetComponentProperty`**

Append this to the end of `HaybaMCPBlueprintHandler.cpp`:

```cpp
// ---------------------------------------------------------------------------
// Component template properties.
//
// A spec could add an AudioComponent but not give it its Sound or turn off
// bAutoActivate, so the title music needed a Python fix-up after every build.
// This sets one property on the SCS component template: the object every
// instance of the blueprint copies its component from.
// ---------------------------------------------------------------------------

FHaybaHandlerResult FHaybaMCPBlueprintHandler::SetComponentProperty(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader ParamR(P, TEXT("blueprint_set_component_property"));
    const FString Path = ParamR.RequiredString(TEXT("path"));
    const FString ComponentName = ParamR.RequiredString(TEXT("component_name"), 256);
    const FString PropertyName = ParamR.RequiredString(TEXT("property"), 256);
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    const TSharedPtr<FJsonValue> Value = P->TryGetField(TEXT("value"));
    if (!Value.IsValid() || Value->Type == EJson::Null)
        return FHaybaHandlerResult::Err(TEXT("blueprint_set_component_property: 'value' is required (a number, string, bool, or an object for a struct). Nothing was changed."));
    {
        int32 JsonNodes = 0;
        FString ShapeReason;
        if (!HaybaValidateMutationJsonShape(Value, 0, JsonNodes, ShapeReason))
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("blueprint_set_component_property: 'value' %s. Nothing was changed."), *ShapeReason));
    }

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(BlueprintNotFoundError(TEXT("blueprint_set_component_property"), Path));
    if (!BP->SimpleConstructionScript)
        return FHaybaHandlerResult::Err(TEXT("blueprint_set_component_property: this blueprint has no component tree. Nothing was changed."));

    USCS_Node* Found = nullptr;
    TArray<FString> Names;
    for (USCS_Node* Node : BP->SimpleConstructionScript->GetAllNodes())
    {
        if (!Node) continue;
        Names.Add(Node->GetVariableName().ToString());
        if (!Found && Node->GetVariableName().ToString().Equals(ComponentName, ESearchCase::IgnoreCase)) Found = Node;
    }
    if (!Found || !Found->ComponentTemplate)
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_set_component_property: no component '%s' in this blueprint's own component tree. Its components: %s. Components inherited from a parent class are not editable here. Nothing was changed."),
            *ComponentName, Names.Num() > 0 ? *FString::Join(Names, TEXT(", ")) : TEXT("(none)")));
    }

    UActorComponent* Template = Found->ComponentTemplate;
    FProperty* Prop = FindFProperty<FProperty>(Template->GetClass(), FName(*PropertyName));
    if (!Prop)
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_set_component_property: %s (%s) has no property '%s'. Nothing was changed."),
            *ComponentName, *Template->GetClass()->GetName(), *PropertyName));
    }

    // Stage on a scratch object first, so a value that cannot be applied
    // leaves the template untouched.
    UObject* Staged = NewObject<UObject>(GetTransientPackage(), Template->GetClass());
    Prop->CopyCompleteValue_InContainer(Staged, Template);
    if (!HaybaReflection::SetValueFromJson(Prop, Staged, Value, Staged))
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blueprint_set_component_property: that value cannot be applied to %s (%s). Nothing was changed."),
            *PropertyName, *Prop->GetCPPType()));
    }
    FString Expected;
    Prop->ExportTextItem_Direct(Expected, Prop->ContainerPtrToValuePtr<void>(Staged), nullptr, Staged, PPF_None);

    BP->Modify();
    Template->Modify();
    Prop->CopyCompleteValue_InContainer(Template, Staged);
    FBlueprintEditorUtils::MarkBlueprintAsModified(BP);

    FString Applied;
    Prop->ExportTextItem_Direct(Applied, Prop->ContainerPtrToValuePtr<void>(Template), nullptr, Template, PPF_None);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("component_name"), Found->GetVariableName().ToString());
    Out->SetStringField(TEXT("property"), Prop->GetName());
    Out->SetStringField(TEXT("applied"), Applied);
    Out->SetBoolField(TEXT("verified"), Applied == Expected);
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    Out->SetStringField(TEXT("note"), TEXT("Set on the component template. Call blueprint_compile to apply."));
    return FHaybaHandlerResult::Ok(Out);
}
```

- [ ] **Step 5: Write the automation test**

```cpp
// unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaMCPBlueprintComponentTest.cpp
#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS && WITH_EDITOR
#include "Tests/HaybaBlueprintTestScratch.h"
#include "handlers/HaybaMCPBlueprintHandler.h"
#include "Components/AudioComponent.h"
#include "Engine/SimpleConstructionScript.h"
#include "Engine/SCS_Node.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPBlueprintComponentPropertyTest,
    "Hayba.MCP.Blueprint.SetComponentProperty.SetsAndVerifiesTemplate",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPBlueprintComponentPropertyTest::RunTest(const FString&)
{
    FHaybaScratchBlueprint Scratch(TEXT("BP_ComponentProperty"));
    if (!TestNotNull(TEXT("scratch blueprint"), Scratch.Blueprint)) return false;
    FHaybaMCPBlueprintHandler Handler;

    TSharedPtr<FJsonObject> Add = MakeShared<FJsonObject>();
    Add->SetStringField(TEXT("path"), Scratch.Path());
    Add->SetStringField(TEXT("component_class_path"), TEXT("/Script/Engine.AudioComponent"));
    Add->SetStringField(TEXT("component_name"), TEXT("Music"));
    if (!TestTrue(TEXT("component added"), Handler.Handle(TEXT("blueprint_add_component"), Add).bOk)) return false;

    UAudioComponent* Template = nullptr;
    for (USCS_Node* Node : Scratch.Blueprint->SimpleConstructionScript->GetAllNodes())
        if (Node && Node->GetVariableName() == TEXT("Music")) Template = Cast<UAudioComponent>(Node->ComponentTemplate);
    if (!TestNotNull(TEXT("the template exists"), Template)) return false;

    auto Set = [&](const TCHAR* Property, const TSharedPtr<FJsonValue>& Value)
    {
        TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
        Params->SetStringField(TEXT("path"), Scratch.Path());
        Params->SetStringField(TEXT("component_name"), TEXT("music")); // case-insensitive
        Params->SetStringField(TEXT("property"), Property);
        Params->SetField(TEXT("value"), Value);
        return Handler.Handle(TEXT("blueprint_set_component_property"), Params);
    };

    const FHaybaHandlerResult Auto = Set(TEXT("bAutoActivate"), MakeShared<FJsonValueBoolean>(false));
    TestTrue(TEXT("a bool property verifies"), Auto.bOk && Auto.Data->GetBoolField(TEXT("verified")));
    TestFalse(TEXT("the template holds it"), Template->bAutoActivate);

    const FHaybaHandlerResult Volume = Set(TEXT("VolumeMultiplier"), MakeShared<FJsonValueNumber>(0.5));
    TestTrue(TEXT("a number property verifies"), Volume.bOk && Volume.Data->GetBoolField(TEXT("verified")));
    TestTrue(TEXT("the template holds it"), FMath::IsNearlyEqual(Template->VolumeMultiplier, 0.5f));

    const FHaybaHandlerResult Missing = Set(TEXT("NotAProperty"), MakeShared<FJsonValueNumber>(1));
    TestFalse(TEXT("an unknown property is refused"), Missing.bOk);
    TestTrue(TEXT("and named"), Missing.ErrorMessage.Contains(TEXT("has no property 'NotAProperty'")));

    TSharedPtr<FJsonObject> Wrong = MakeShared<FJsonObject>();
    Wrong->SetStringField(TEXT("path"), Scratch.Path());
    Wrong->SetStringField(TEXT("component_name"), TEXT("Nope"));
    Wrong->SetStringField(TEXT("property"), TEXT("bAutoActivate"));
    Wrong->SetBoolField(TEXT("value"), true);
    const FHaybaHandlerResult NoComponent = Handler.Handle(TEXT("blueprint_set_component_property"), Wrong);
    TestFalse(TEXT("an unknown component is refused"), NoComponent.bOk);
    TestTrue(TEXT("listing the components there are"), NoComponent.ErrorMessage.Contains(TEXT("Music")));
    return true;
}
#endif
```

- [ ] **Step 6: Run the contract test to verify it passes**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/blueprint-graph-handler-contract.test.ts`
Expected: PASS.

- [ ] **Step 7: Compile the plugin, then run the TS gate**

Run the C++ compile gate, then `cd mcp-tools/hayba-mcp && npx tsc --noEmit && npx vitest run`.
Expected: `BUILD SUCCESSFUL`, and only the known TS failure.

- [ ] **Step 8: Commit**

```bash
git add unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCommandHandler.cpp unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaMCPBlueprintComponentTest.cpp mcp-tools/hayba-mcp/src/tools/blueprint-graph-handler-contract.test.ts
git commit -m "feat(blueprint): set component template properties with staged readback"
```

---

### Task 7: `blueprint_apply_graph` — validate, apply, roll back

**Files:**
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPBlueprintHandler.h`
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPBlueprintHandler.cpp`
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCommandHandler.cpp` (`DestructiveCommands`)
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaMCPBlueprintApplyGraphTest.cpp`
- Test (source contract): `mcp-tools/hayba-mcp/src/tools/blueprint-graph-handler-contract.test.ts`

**Interfaces:**
- Consumes:
  - From Task 4: `ParseApplyGraphPayload`, `ResolvePinName`, `FPinInfo`, `PinLiteralMatches`.
  - From Task 5 and existing code: `HaybaPinLiteral`, `HaybaDescribeNode`, `HaybaFindNode`, `HaybaFindGraph`, `FHaybaScratchBlueprint`, `HaybaTestJson`.
- Produces:
  - The wire command `blueprint_apply_graph`. Params: `{path, graph_name?, nodes[], defaults?[], links?[]}`.
  - Success reply: `{ok:true, graph, node_ids:{key:guid}, pins:{key:[pin]}, links_resolved:[{from_node, from_pin, to_node, to_pin}], links_verified, defaults_verified, nodes_created, default_mismatches?:[{default, applied}], verified, dirty, note}`.
  - Failure reply, sent as transport-ok: `{ok:false, code:"apply_graph_rejected", phase:"parse"|"preflight"|"execute", mutation_status:"not_started"|"unknown", rolled_back, nodes_removed, errors[], error}`.
  - The command handler turns that failure into an error envelope carrying `data`, and cancels the transaction.
  - TS `executeCommand` then throws `UeToolError` with `uePayload.data`.
  - `HaybaBlueprintApplyGraphTestHooks::SetFailAfterLinks(int32)`, under `WITH_DEV_AUTOMATION_TESTS`.

- [ ] **Step 1: Write the failing contract test**

Append to `blueprint-graph-handler-contract.test.ts`:

```ts
describe('bulk graph authoring (blueprint_apply_graph)', () => {
  it('advertises, routes, compile-gates and plan-gates it', () => {
    expect(textLiterals(setLiteral(source, 'FHaybaMCPBlueprintHandler::GetCommands() const'))).toContain('blueprint_apply_graph');
    expect(source).toMatch(/if \(Cmd == TEXT\("blueprint_apply_graph"\)\)\s*return ApplyGraph\(P\);/);
    expect(textLiterals(setLiteral(source, 'static const TSet<FString> MutatingCommands'))).toContain('blueprint_apply_graph');
    expect(textLiterals(setLiteral(commandHandler, 'static const TSet<FString> DestructiveCommands'))).toContain('blueprint_apply_graph');
  });

  it('resolves everything before placing, and checks every link before making any', () => {
    const body = handlerBody('ApplyGraph');
    expect(body.indexOf('HaybaBlueprintOps::ParseApplyGraphPayload')).toBeLessThan(body.indexOf('HaybaResolveApplyNode'));
    expect(body.indexOf('HaybaResolveApplyNode')).toBeLessThan(body.indexOf('HaybaPlaceApplyNode'));
    expect(body.indexOf('Schema->CanCreateConnection')).toBeLessThan(body.indexOf('Schema->TryCreateConnection'));
    expect(body.indexOf('Schema->IsPinDefaultValid')).toBeLessThan(body.indexOf('Schema->TrySetDefaultValue'));
  });

  it('rolls back by removing what it placed, not by cancelling the transaction', () => {
    const start = source.indexOf('static bool HaybaRollbackApply(');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n}\n', start));
    expect(body).toContain('FBlueprintEditorUtils::RemoveNode');
    expect(body).toContain('MakeLinkTo');
    expect(body).toContain('SetEnabledState');
    expect(handlerBody('ApplyGraph')).not.toContain('CancelTransaction');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/blueprint-graph-handler-contract.test.ts`
Expected: FAIL.

- [ ] **Step 3: Declare, advertise, gate and route the command**

1. In `HaybaMCPBlueprintHandler.h`, after `SetComponentProperty`, add:

   ```cpp
       /** One graph's nodes, literals and links in one call; all or nothing. */
       FHaybaHandlerResult ApplyGraph(const TSharedPtr<FJsonObject>& P);
   ```

2. In the same header, below the class, add:

   ```cpp
   #if WITH_DEV_AUTOMATION_TESTS
   namespace HaybaBlueprintApplyGraphTestHooks
   {
       /** Make blueprint_apply_graph fail after this many links (-1 = never), to exercise rollback. Tests only. */
       void SetFailAfterLinks(int32 LinkCount);
   }
   #endif
   ```

3. Add `TEXT("blueprint_apply_graph"),` to `GetCommands()`, to `MutatingCommands`, and to the Blueprint authoring group of `DestructiveCommands`.
4. In `Handle`, add: `if (Cmd == TEXT("blueprint_apply_graph")) return ApplyGraph(P);`.

- [ ] **Step 4: Implement `ApplyGraph`**

Append this to the end of `HaybaMCPBlueprintHandler.cpp`:

```cpp
// ---------------------------------------------------------------------------
// blueprint_apply_graph — one graph's nodes, literals and links in one call,
// all or nothing.
//
// One command per node, pin and link cost ~700 round trips for two specs, and
// a failure halfway left a half-wired graph that PIE would compile. This call:
//   1. checks the payload against the blueprint before placing anything;
//   2. places the nodes;
//   3. checks every literal and connection against them before any link;
//   4. if anything fails from step 2 on, removes every node it placed and
//      restores the pins and enabled state it touched.
// The editor transaction around the command is NOT the rollback:
// CancelTransaction ends the undo record, it does not revert the graph.
// ---------------------------------------------------------------------------

#if WITH_DEV_AUTOMATION_TESTS
namespace HaybaBlueprintApplyGraphTestHooks
{
    static int32 GFailAfterLinks = -1;
    void SetFailAfterLinks(int32 LinkCount) { GFailAfterLinks = LinkCount; }
}
#endif

/** A payload node, resolved against the blueprint before anything changes. */
struct FHaybaApplyNode
{
    HaybaBlueprintOps::FApplyNodeRequest Request;
    UEdGraphNode* Existing = nullptr;
    UClass* Class = nullptr;
    UFunction* Function = nullptr;
    UEdGraphNode* Created = nullptr;
    UEdGraphNode* Node() const { return Existing ? Existing : Created; }
};

/** A pin by identity, not pointer: a node can reallocate its pins. */
struct FHaybaPinId
{
    FGuid Node;
    FName Pin;
    EEdGraphPinDirection Direction = EGPD_Input;
};

struct FHaybaPinSnapshot
{
    FHaybaPinId Id;
    FString DefaultValue;
    FText DefaultTextValue;
    UObject* DefaultObject = nullptr;
    TArray<FHaybaPinId> Links;
};

/** Linking a disabled "ghost" event enables it and the ghosts linked to it
 *  (UEdGraphPin::ConvertConnectedGhostNodesToRealNodes). Enabled state is
 *  therefore snapshotted for the whole graph. */
struct FHaybaNodeStateSnapshot
{
    FGuid Node;
    ENodeEnabledState State = ENodeEnabledState::Enabled;
    bool bUserSetState = false;
    FString Comment;
    bool bCommentBubbleVisible = false;
};

static FHaybaPinId HaybaPinIdOf(const UEdGraphPin* Pin)
{
    return { Pin->GetOwningNode()->NodeGuid, Pin->PinName, Pin->Direction };
}

static UEdGraphPin* HaybaFindPinById(UEdGraph* Graph, const FHaybaPinId& Id)
{
    for (UEdGraphNode* N : Graph->Nodes)
    {
        if (N && N->NodeGuid == Id.Node) return N->FindPin(Id.Pin, Id.Direction);
    }
    return nullptr;
}

static TArray<HaybaBlueprintOps::FPinInfo> HaybaPinInfos(const UEdGraphNode* Node)
{
    TArray<HaybaBlueprintOps::FPinInfo> Out;
    for (const UEdGraphPin* Pin : Node->Pins)
    {
        if (Pin) Out.Add({ Pin->PinName.ToString(), Pin->Direction == EGPD_Output });
    }
    return Out;
}

static UClass* HaybaLoadAnyClass(const FString& ClassPath)
{
    UClass* C = LoadObject<UClass>(nullptr, *ClassPath);
    return C ? C : LoadClass<UObject>(nullptr, *ClassPath);
}

/** Resolve what a node needs (class, function, variable, existing node)
 *  without changing anything. Mirrors AddNode's lookups. Returns an empty
 *  string when resolved. */
static FString HaybaResolveApplyNode(UBlueprint* BP, UEdGraph* Graph, FHaybaApplyNode& N)
{
    using HaybaBlueprintOps::EApplyNodeKind;
    const HaybaBlueprintOps::FApplyNodeRequest& R = N.Request;
    switch (R.Kind)
    {
    case EApplyNodeKind::Existing:
        N.Existing = HaybaFindNode(Graph, R.NodeId);
        return N.Existing ? FString()
            : FString::Printf(TEXT("node '%s': no node '%s' in graph '%s'"), *R.Key, *R.NodeId, *Graph->GetName());
    case EApplyNodeKind::Get:
    case EApplyNodeKind::Set:
    {
        UClass* VarScope = BP->SkeletonGeneratedClass ? BP->SkeletonGeneratedClass.Get() : BP->GeneratedClass.Get();
        return (VarScope && FindFProperty<FProperty>(VarScope, FName(*R.Variable))) ? FString()
            : FString::Printf(TEXT("node '%s': no variable '%s' on this blueprint"), *R.Key, *R.Variable);
    }
    case EApplyNodeKind::Cast:
        N.Class = HaybaLoadAnyClass(R.ClassPath);
        return N.Class ? FString() : FString::Printf(TEXT("node '%s': cast target not found: %s"), *R.Key, *R.ClassPath);
    case EApplyNodeKind::CreateWidget:
    {
        N.Class = HaybaLoadAnyClass(R.ClassPath);
        if (!N.Class || !N.Class->IsChildOf(UUserWidget::StaticClass()))
            return FString::Printf(TEXT("node '%s': create_widget class '%s' is not a loadable UserWidget class (a Widget Blueprint's class ends in _C)"), *R.Key, *R.ClassPath);
        UClass* NodeClass = LoadObject<UClass>(nullptr, TEXT("/Script/UMGEditor.K2Node_CreateWidget"));
        return (NodeClass && NodeClass->IsChildOf(UK2Node::StaticClass())) ? FString()
            : FString::Printf(TEXT("node '%s': the Create Widget node class (UMGEditor) is not loaded"), *R.Key);
    }
    case EApplyNodeKind::Timer:
        N.Function = UKismetSystemLibrary::StaticClass()->FindFunctionByName(TEXT("K2_SetTimer"));
        return N.Function ? FString() : FString::Printf(TEXT("node '%s': K2_SetTimer not found"), *R.Key);
    case EApplyNodeKind::Call:
    {
        UClass* Owner = nullptr;
        if (!R.ClassPath.IsEmpty())
        {
            Owner = HaybaLoadAnyClass(R.ClassPath);
            if (!Owner) return FString::Printf(TEXT("node '%s': class not found: %s"), *R.Key, *R.ClassPath);
        }
        else
        {
            Owner = BP->GeneratedClass ? BP->GeneratedClass.Get() : BP->ParentClass.Get();
        }
        N.Function = Owner ? Owner->FindFunctionByName(FName(*R.Function)) : nullptr;
        return N.Function ? FString()
            : FString::Printf(TEXT("node '%s': no function '%s' on %s. Pass class to call one on another class."),
                *R.Key, *R.Function, Owner ? *Owner->GetName() : TEXT("<null>"));
    }
    default:
        return FString(); // branch, sequence, select, self need nothing resolved
    }
}

/** Place one resolved node exactly as AddNode would, and grow its pins. */
static UEdGraphNode* HaybaPlaceApplyNode(UEdGraph* Graph, FHaybaApplyNode& N)
{
    using HaybaBlueprintOps::EApplyNodeKind;
    const HaybaBlueprintOps::FApplyNodeRequest& R = N.Request;
    UK2Node* Node = nullptr;
    switch (R.Kind)
    {
    case EApplyNodeKind::Branch:   Node = NewObject<UK2Node_IfThenElse>(Graph); break;
    case EApplyNodeKind::Select:   Node = NewObject<UK2Node_Select>(Graph); break;
    case EApplyNodeKind::Sequence: Node = NewObject<UK2Node_ExecutionSequence>(Graph); break;
    case EApplyNodeKind::Self:     Node = NewObject<UK2Node_Self>(Graph); break;
    case EApplyNodeKind::Get:
    {
        UK2Node_VariableGet* V = NewObject<UK2Node_VariableGet>(Graph);
        V->VariableReference.SetSelfMember(FName(*R.Variable));
        Node = V;
        break;
    }
    case EApplyNodeKind::Set:
    {
        UK2Node_VariableSet* V = NewObject<UK2Node_VariableSet>(Graph);
        V->VariableReference.SetSelfMember(FName(*R.Variable));
        Node = V;
        break;
    }
    case EApplyNodeKind::Cast:
    {
        UK2Node_DynamicCast* C = NewObject<UK2Node_DynamicCast>(Graph);
        C->TargetType = N.Class;
        C->SetPurity(false);
        Node = C;
        break;
    }
    case EApplyNodeKind::CreateWidget:
        Node = NewObject<UK2Node>(Graph, LoadObject<UClass>(nullptr, TEXT("/Script/UMGEditor.K2Node_CreateWidget")));
        break;
    case EApplyNodeKind::Call:
    case EApplyNodeKind::Timer:
    {
        UK2Node_CallFunction* F = NewObject<UK2Node_CallFunction>(Graph);
        F->SetFromFunction(N.Function);
        Node = F;
        break;
    }
    default:
        return nullptr;
    }
    Node->CreateNewGuid();
    Node->NodePosX = R.X;
    Node->NodePosY = R.Y;
    Graph->AddNode(Node, false, false);
    Node->PostPlacedNewNode();
    Node->AllocateDefaultPins();
    if (R.Kind == EApplyNodeKind::Select)
    {
        UK2Node_Select* Select = CastChecked<UK2Node_Select>(Node);
        for (int32 I = 2; I < R.Count && Select->CanAddPin(); ++I) Select->AddInputPin();
    }
    else if (R.Kind == EApplyNodeKind::Sequence)
    {
        if (IK2Node_AddPinInterface* AddPins = Cast<IK2Node_AddPinInterface>(Node))
        {
            for (int32 I = 2; I < R.Count && AddPins->CanAddPin(); ++I) AddPins->AddInputPin();
        }
    }
    else if (R.Kind == EApplyNodeKind::CreateWidget)
    {
        if (UEdGraphPin* ClassPin = Node->FindPin(TEXT("Class"), EGPD_Input))
            GetDefault<UEdGraphSchema_K2>()->TrySetDefaultObject(*ClassPin, N.Class);
        UEdGraphPin* ReturnPin = Node->FindPin(UEdGraphSchema_K2::PN_ReturnValue, EGPD_Output);
        if (ReturnPin && ReturnPin->PinType.PinSubCategoryObject != N.Class) Node->ReconstructNode();
    }
    N.Created = Node;
    return Node;
}

/** Remove every node this call placed and restore what it changed on nodes
 *  that were already there. Returns false when something could not be restored. */
static bool HaybaRollbackApply(UBlueprint* BP, UEdGraph* Graph, TArray<FHaybaApplyNode>& Nodes,
    const TArray<FHaybaPinSnapshot>& Pins, const TArray<FHaybaNodeStateSnapshot>& States, int32& OutRemoved)
{
    bool bComplete = true;
    OutRemoved = 0;
    for (FHaybaApplyNode& N : Nodes)
    {
        if (!N.Created) continue;
        UEdGraphNode* Placed = N.Created;
        FBlueprintEditorUtils::RemoveNode(BP, Placed, /*bDontRecompile*/ true);
        if (Graph->Nodes.Contains(Placed)) bComplete = false;
        else ++OutRemoved;
        N.Created = nullptr;
    }
    for (const FHaybaPinSnapshot& S : Pins)
    {
        UEdGraphPin* Pin = HaybaFindPinById(Graph, S.Id);
        if (!Pin) { bComplete = false; continue; }
        Pin->BreakAllPinLinks();
        Pin->DefaultValue = S.DefaultValue;
        Pin->DefaultTextValue = S.DefaultTextValue;
        Pin->DefaultObject = S.DefaultObject;
    }
    for (const FHaybaPinSnapshot& S : Pins)
    {
        UEdGraphPin* Pin = HaybaFindPinById(Graph, S.Id);
        if (!Pin) continue;
        for (const FHaybaPinId& L : S.Links)
        {
            UEdGraphPin* Other = HaybaFindPinById(Graph, L);
            if (!Other) { bComplete = false; continue; }
            if (!Pin->LinkedTo.Contains(Other)) Pin->MakeLinkTo(Other);
        }
    }
    // Restore enabled state after the links: re-linking converts ghosts again.
    for (const FHaybaNodeStateSnapshot& S : States)
    {
        for (UEdGraphNode* N : Graph->Nodes)
        {
            if (!N || N->NodeGuid != S.Node) continue;
            N->SetEnabledState(S.State, S.bUserSetState);
            N->NodeComment = S.Comment;
            N->bCommentBubbleVisible = S.bCommentBubbleVisible;
        }
    }
    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);
    return bComplete;
}

/** The refusal reply. It is transport-ok with ok:false so the per-item errors
 *  reach the caller; the command handler turns it into an error envelope and
 *  cancels the transaction. */
static FHaybaHandlerResult HaybaApplyGraphRejected(const TCHAR* Phase, const TArray<FString>& Errors, int32 NodesRemoved, bool bRestored)
{
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    TArray<TSharedPtr<FJsonValue>> ErrorJson;
    for (const FString& E : Errors) ErrorJson.Add(MakeShared<FJsonValueString>(E));
    Out->SetBoolField(TEXT("ok"), false);
    Out->SetStringField(TEXT("code"), TEXT("apply_graph_rejected"));
    Out->SetStringField(TEXT("phase"), Phase);
    Out->SetStringField(TEXT("mutation_status"), bRestored ? TEXT("not_started") : TEXT("unknown"));
    Out->SetBoolField(TEXT("rolled_back"), bRestored);
    Out->SetNumberField(TEXT("nodes_removed"), NodesRemoved);
    Out->SetArrayField(TEXT("errors"), ErrorJson);
    Out->SetStringField(TEXT("error"), FString::Printf(TEXT("blueprint_apply_graph: %s%s %s"),
        Errors.Num() > 0 ? *Errors[0] : TEXT("rejected"),
        Errors.Num() > 1 ? *FString::Printf(TEXT(" (and %d more)"), Errors.Num() - 1) : TEXT(""),
        bRestored ? TEXT("The graph is as it was before the call.") : TEXT("Rollback was incomplete; inspect the graph before retrying.")));
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBlueprintHandler::ApplyGraph(const TSharedPtr<FJsonObject>& P)
{
    using HaybaBlueprintOps::EApplyNodeKind;
    FHaybaParamReader ParamR(P, TEXT("blueprint_apply_graph"));
    const FString Path = ParamR.RequiredString(TEXT("path"));
    const FString GraphName = ParamR.OptionalString(TEXT("graph_name"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    // 1. Shape. Nothing is loaded yet.
    HaybaBlueprintOps::FApplyGraphRequest Request;
    const TArray<FString> ShapeErrors = HaybaBlueprintOps::ParseApplyGraphPayload(P, Request);
    if (ShapeErrors.Num() > 0) return HaybaApplyGraphRejected(TEXT("parse"), ShapeErrors, 0, true);

    UBlueprint* BP = LoadBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(BlueprintNotFoundError(TEXT("blueprint_apply_graph"), Path));
    UEdGraph* Graph = HaybaFindGraph(BP, GraphName);
    if (!Graph) return FHaybaHandlerResult::Err(TEXT("blueprint_apply_graph: graph not found"));

    // 2. Resolve every node. Still nothing changed.
    TArray<FHaybaApplyNode> Nodes;
    TMap<FString, int32> ByKey;
    TArray<FString> Errors;
    for (const HaybaBlueprintOps::FApplyNodeRequest& R : Request.Nodes)
    {
        FHaybaApplyNode N;
        N.Request = R;
        const FString Problem = HaybaResolveApplyNode(BP, Graph, N);
        if (!Problem.IsEmpty()) Errors.Add(Problem);
        ByKey.Add(R.Key, Nodes.Add(N));
    }
    if (Errors.Num() > 0) return HaybaApplyGraphRejected(TEXT("preflight"), Errors, 0, true);

    // 3. Snapshot what placing and linking can change on nodes already there.
    TArray<FHaybaPinSnapshot> PinSnapshots;
    for (const FHaybaApplyNode& N : Nodes)
    {
        if (!N.Existing) continue;
        for (UEdGraphPin* Pin : N.Existing->Pins)
        {
            if (!Pin) continue;
            FHaybaPinSnapshot S;
            S.Id = HaybaPinIdOf(Pin);
            S.DefaultValue = Pin->DefaultValue;
            S.DefaultTextValue = Pin->DefaultTextValue;
            S.DefaultObject = Pin->DefaultObject;
            for (UEdGraphPin* L : Pin->LinkedTo)
            {
                if (L && L->GetOwningNode()) S.Links.Add(HaybaPinIdOf(L));
            }
            PinSnapshots.Add(MoveTemp(S));
        }
    }
    TArray<FHaybaNodeStateSnapshot> StateSnapshots;
    for (UEdGraphNode* N : Graph->Nodes)
    {
        if (!N) continue;
        StateSnapshots.Add({ N->NodeGuid, N->GetDesiredEnabledState(), N->HasUserSetTheEnabledState(), N->NodeComment, N->bCommentBubbleVisible != 0 });
    }

    int32 Removed = 0;
    auto Fail = [&](const TCHAR* Phase) -> FHaybaHandlerResult
    {
        const bool bRestored = HaybaRollbackApply(BP, Graph, Nodes, PinSnapshots, StateSnapshots, Removed);
        return HaybaApplyGraphRejected(Phase, Errors, Removed, bRestored);
    };

    // 4. Place the nodes.
    BP->Modify();
    Graph->Modify();
    int32 Created = 0;
    for (FHaybaApplyNode& N : Nodes)
    {
        if (N.Existing) continue;
        if (!HaybaPlaceApplyNode(Graph, N))
        {
            Errors.Add(FString::Printf(TEXT("node '%s': could not be placed"), *N.Request.Key));
            return Fail(TEXT("execute"));
        }
        ++Created;
    }

    // 5. Check every literal and connection against the placed nodes, before
    //    setting or linking anything.
    const UEdGraphSchema_K2* Schema = GetDefault<UEdGraphSchema_K2>();
    struct FResolvedDefault { int32 Node; FName Pin; FString Value; UObject* Object; bool bObjectPin; FString Label; };
    struct FResolvedLink { int32 From; FName FromPin; int32 To; FName ToPin; FString Label; };
    TArray<FResolvedDefault> Defaults;
    TArray<FResolvedLink> Links;
    for (const HaybaBlueprintOps::FApplyDefaultRequest& D : Request.Defaults)
    {
        const int32 Index = ByKey[D.Node];
        FHaybaApplyNode& N = Nodes[Index];
        const FString Label = FString::Printf(TEXT("default %s.%s = '%s'"), *D.Node, *D.Pin, *D.Value);
        const HaybaBlueprintOps::FPinResolution Res = HaybaBlueprintOps::ResolvePinName(
            HaybaPinInfos(N.Node()), D.Pin, /*bOutput*/ false, N.Request.Kind == EApplyNodeKind::Cast);
        if (!Res.IsValid()) { Errors.Add(FString::Printf(TEXT("%s: %s"), *Label, *Res.Error)); continue; }
        UEdGraphPin* Pin = N.Node()->FindPin(FName(*Res.Name), EGPD_Input);
        if (Pin->LinkedTo.Num() > 0)
        {
            Errors.Add(FString::Printf(TEXT("%s: the pin is connected; a literal there would be ignored"), *Label));
            continue;
        }
        const bool bHard = Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Object || Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Class;
        const bool bSoft = Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_SoftObject || Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_SoftClass;
        UObject* Object = nullptr;
        if (bHard || bSoft)
        {
            Object = LoadObject<UObject>(nullptr, *D.Value);
            if (!Object) Object = LoadClass<UObject>(nullptr, *D.Value);
            if (!Object) { Errors.Add(FString::Printf(TEXT("%s: could not load '%s' for an object/class pin"), *Label, *D.Value)); continue; }
        }
        const FString Invalid = Schema->IsPinDefaultValid(Pin, bHard ? FString() : D.Value, bHard ? Object : nullptr, FText::GetEmpty());
        if (!Invalid.IsEmpty()) { Errors.Add(FString::Printf(TEXT("%s: %s"), *Label, *Invalid)); continue; }
        Defaults.Add({ Index, Pin->PinName, D.Value, Object, bHard, Label });
    }
    for (const HaybaBlueprintOps::FApplyLinkRequest& L : Request.Links)
    {
        const int32 FromIndex = ByKey[L.FromNode];
        const int32 ToIndex = ByKey[L.ToNode];
        FHaybaApplyNode& From = Nodes[FromIndex];
        FHaybaApplyNode& To = Nodes[ToIndex];
        const FString Label = FString::Printf(TEXT("link %s.%s -> %s.%s"), *L.FromNode, *L.FromPin, *L.ToNode, *L.ToPin);
        const HaybaBlueprintOps::FPinResolution FR = HaybaBlueprintOps::ResolvePinName(HaybaPinInfos(From.Node()), L.FromPin, true, From.Request.Kind == EApplyNodeKind::Cast);
        const HaybaBlueprintOps::FPinResolution TR = HaybaBlueprintOps::ResolvePinName(HaybaPinInfos(To.Node()), L.ToPin, false, To.Request.Kind == EApplyNodeKind::Cast);
        if (!FR.IsValid() || !TR.IsValid())
        {
            TArray<FString> Why;
            if (!FR.IsValid()) Why.Add(FString::Printf(TEXT("%s: %s"), *L.FromNode, *FR.Error));
            if (!TR.IsValid()) Why.Add(FString::Printf(TEXT("%s: %s"), *L.ToNode, *TR.Error));
            Errors.Add(FString::Printf(TEXT("%s: %s"), *Label, *FString::Join(Why, TEXT("; "))));
            continue;
        }
        UEdGraphPin* OutPin = From.Node()->FindPin(FName(*FR.Name), EGPD_Output);
        UEdGraphPin* InPin = To.Node()->FindPin(FName(*TR.Name), EGPD_Input);
        if (!OutPin->LinkedTo.Contains(InPin)) // an existing link (a function's entry->result) is already satisfied
        {
            const FPinConnectionResponse Response = Schema->CanCreateConnection(OutPin, InPin);
            if (Response.Response == CONNECT_RESPONSE_DISALLOW)
            {
                Errors.Add(FString::Printf(TEXT("%s: the schema refused the connection: %s"), *Label, *Response.Message.ToString()));
                continue;
            }
        }
        Links.Add({ FromIndex, OutPin->PinName, ToIndex, InPin->PinName, Label });
    }
    if (Errors.Num() > 0) return Fail(TEXT("preflight"));

    // 6. Literals, then links. Pins are looked up by name each time, because
    //    a connection can make a node rebuild its pins.
    TArray<TSharedPtr<FJsonValue>> Mismatches;
    int32 DefaultsVerified = 0;
    for (const FResolvedDefault& D : Defaults)
    {
        UEdGraphPin* Pin = Nodes[D.Node].Node()->FindPin(D.Pin, EGPD_Input);
        if (!Pin) { Errors.Add(FString::Printf(TEXT("%s: the pin disappeared while literals were set"), *D.Label)); return Fail(TEXT("execute")); }
        if (D.bObjectPin) Schema->TrySetDefaultObject(*Pin, D.Object);
        else Schema->TrySetDefaultValue(*Pin, D.Value);
        const FString Applied = HaybaPinLiteral(Pin);
        if (D.bObjectPin ? Pin->DefaultObject == D.Object : HaybaBlueprintOps::PinLiteralMatches(Applied, D.Value))
        {
            ++DefaultsVerified;
        }
        else
        {
            TSharedPtr<FJsonObject> M = MakeShared<FJsonObject>();
            M->SetStringField(TEXT("default"), D.Label);
            M->SetStringField(TEXT("applied"), Applied);
            Mismatches.Add(MakeShared<FJsonValueObject>(M.ToSharedRef()));
        }
    }
    TArray<TSharedPtr<FJsonValue>> Resolved;
    int32 LinksVerified = 0;
    for (const FResolvedLink& L : Links)
    {
        UEdGraphPin* OutPin = Nodes[L.From].Node()->FindPin(L.FromPin, EGPD_Output);
        UEdGraphPin* InPin = Nodes[L.To].Node()->FindPin(L.ToPin, EGPD_Input);
        if (!OutPin || !InPin) { Errors.Add(FString::Printf(TEXT("%s: a pin disappeared while earlier links were made"), *L.Label)); return Fail(TEXT("execute")); }
        if (!OutPin->LinkedTo.Contains(InPin) && !Schema->TryCreateConnection(OutPin, InPin))
        {
            Errors.Add(FString::Printf(TEXT("%s: TryCreateConnection failed"), *L.Label));
            return Fail(TEXT("execute"));
        }
        if (!(OutPin->LinkedTo.Contains(InPin) && InPin->LinkedTo.Contains(OutPin)))
        {
            Errors.Add(FString::Printf(TEXT("%s: not linked on readback"), *L.Label));
            return Fail(TEXT("execute"));
        }
        ++LinksVerified;
        TSharedPtr<FJsonObject> Edge = MakeShared<FJsonObject>();
        Edge->SetStringField(TEXT("from_node"), Nodes[L.From].Node()->NodeGuid.ToString());
        Edge->SetStringField(TEXT("from_pin"), OutPin->PinName.ToString());
        Edge->SetStringField(TEXT("to_node"), Nodes[L.To].Node()->NodeGuid.ToString());
        Edge->SetStringField(TEXT("to_pin"), InPin->PinName.ToString());
        Resolved.Add(MakeShared<FJsonValueObject>(Edge.ToSharedRef()));
#if WITH_DEV_AUTOMATION_TESTS
        if (HaybaBlueprintApplyGraphTestHooks::GFailAfterLinks >= 0 && LinksVerified >= HaybaBlueprintApplyGraphTestHooks::GFailAfterLinks)
        {
            Errors.Add(FString::Printf(TEXT("%s: injected failure after %d link(s) (automation test hook)"), *L.Label, LinksVerified));
            return Fail(TEXT("execute"));
        }
#endif
    }

    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);

    TSharedPtr<FJsonObject> NodeIds = MakeShared<FJsonObject>();
    TSharedPtr<FJsonObject> PinsByKey = MakeShared<FJsonObject>();
    for (const FHaybaApplyNode& N : Nodes)
    {
        NodeIds->SetStringField(N.Request.Key, N.Node()->NodeGuid.ToString());
        PinsByKey->SetArrayField(N.Request.Key, HaybaDescribeNode(N.Node())->GetArrayField(TEXT("pins")));
    }
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("ok"), true);
    Out->SetStringField(TEXT("graph"), Graph->GetName());
    Out->SetObjectField(TEXT("node_ids"), NodeIds);
    Out->SetObjectField(TEXT("pins"), PinsByKey);
    Out->SetArrayField(TEXT("links_resolved"), Resolved);
    Out->SetNumberField(TEXT("links_verified"), LinksVerified);
    Out->SetNumberField(TEXT("defaults_verified"), DefaultsVerified);
    Out->SetNumberField(TEXT("nodes_created"), Created);
    if (Mismatches.Num() > 0) Out->SetArrayField(TEXT("default_mismatches"), Mismatches);
    Out->SetBoolField(TEXT("verified"), LinksVerified == Links.Num() && Mismatches.Num() == 0);
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    Out->SetStringField(TEXT("note"), TEXT("Staged. Call blueprint_compile to apply."));
    return FHaybaHandlerResult::Ok(Out);
}
```

- [ ] **Step 5: Write the automation tests**

```cpp
// unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaMCPBlueprintApplyGraphTest.cpp
// blueprint_apply_graph: a whole graph body in one call, and nothing left
// behind when it fails.
#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS && WITH_EDITOR
#include "Tests/HaybaBlueprintTestScratch.h"
#include "handlers/HaybaMCPBlueprintHandler.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphPin.h"
#include "EdGraphSchema_K2.h"

namespace
{
    struct FTwiceFixture
    {
        FHaybaScratchBlueprint Scratch{ TEXT("BP_ApplyGraph") };
        FHaybaMCPBlueprintHandler Handler;
        FString EntryId;
        FString ResultId;
        UEdGraph* Graph = nullptr;

        /** Twice(In: float) -> Out: float. Its entry.then is already linked to result.execute. */
        bool Make(FAutomationTestBase& Test)
        {
            if (!Test.TestNotNull(TEXT("scratch blueprint"), Scratch.Blueprint)) return false;
            TSharedPtr<FJsonObject> Fn = HaybaTestJson(TEXT(R"({"function_name": "Twice", "inputs": [{"name": "In", "type": "float"}], "outputs": [{"name": "Out", "type": "float"}]})"));
            Fn->SetStringField(TEXT("path"), Scratch.Path());
            const FHaybaHandlerResult Added = Handler.Handle(TEXT("blueprint_add_function"), Fn);
            if (!Test.TestTrue(TEXT("function added"), Added.bOk && Added.Data.IsValid())) return false;
            EntryId = Added.Data->GetStringField(TEXT("entry_node_id"));
            ResultId = Added.Data->GetStringField(TEXT("result_node_id"));
            for (UEdGraph* G : Scratch.Blueprint->FunctionGraphs)
                if (G && G->GetName() == TEXT("Twice")) Graph = G;
            return Test.TestNotNull(TEXT("function graph"), Graph);
        }

        UEdGraphNode* Find(const FString& Id) const
        {
            for (UEdGraphNode* N : Graph->Nodes) if (N && N->NodeGuid.ToString() == Id) return N;
            return nullptr;
        }

        /** BodyTemplate uses {E} and {R} for the entry and result node ids. */
        FHaybaHandlerResult Apply(const FString& BodyTemplate)
        {
            const FString Body = BodyTemplate.Replace(TEXT("{E}"), *EntryId).Replace(TEXT("{R}"), *ResultId);
            TSharedPtr<FJsonObject> Params = HaybaTestJson(Body);
            Params->SetStringField(TEXT("path"), Scratch.Path());
            Params->SetStringField(TEXT("graph_name"), TEXT("Twice"));
            return Handler.Handle(TEXT("blueprint_apply_graph"), Params);
        }

        bool EntryLinkedToResult() const
        {
            UEdGraphPin* Then = Find(EntryId)->FindPin(UEdGraphSchema_K2::PN_Then, EGPD_Output);
            UEdGraphPin* Exec = Find(ResultId)->FindPin(UEdGraphSchema_K2::PN_Execute, EGPD_Input);
            return Then && Exec && Then->LinkedTo.Contains(Exec);
        }
    };

    struct FFailAfterLinksScope
    {
        explicit FFailAfterLinksScope(int32 N) { HaybaBlueprintApplyGraphTestHooks::SetFailAfterLinks(N); }
        ~FFailAfterLinksScope() { HaybaBlueprintApplyGraphTestHooks::SetFailAfterLinks(-1); }
    };
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPBlueprintApplyGraphAppliesTest,
    "Hayba.MCP.Blueprint.ApplyGraph.AppliesAndVerifies",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPBlueprintApplyGraphAppliesTest::RunTest(const FString&)
{
    FFailAfterLinksScope NoInjection(-1);
    FTwiceFixture F;
    if (!F.Make(*this)) return false;
    const int32 Before = F.Graph->Nodes.Num();
    const FHaybaHandlerResult R = F.Apply(TEXT(R"({
        "nodes": [
            {"key": "entry", "kind": "existing", "node_id": "{E}"},
            {"key": "result", "kind": "existing", "node_id": "{R}"},
            {"key": "mul", "kind": "call", "function": "Multiply_DoubleDouble", "class": "/Script/Engine.KismetMathLibrary", "x": 300}
        ],
        "defaults": [{"node": "mul", "pin": "B", "value": "2"}],
        "links": [
            {"from_node": "entry", "from_pin": "then", "to_node": "result", "to_pin": "execute"},
            {"from_node": "entry", "from_pin": "In", "to_node": "mul", "to_pin": "A"},
            {"from_node": "mul", "from_pin": "returnvalue", "to_node": "result", "to_pin": "Out"}
        ]
    })"));
    if (!TestTrue(TEXT("apply answers"), R.bOk && R.Data.IsValid())) return false;
    TestTrue(TEXT("ok"), R.Data->GetBoolField(TEXT("ok")));
    TestEqual(TEXT("one node placed"), F.Graph->Nodes.Num(), Before + 1);
    TestEqual(TEXT("every link verified, the pre-existing one included"), (int32)R.Data->GetNumberField(TEXT("links_verified")), 3);
    TestEqual(TEXT("the literal verified in its stored spelling"), (int32)R.Data->GetNumberField(TEXT("defaults_verified")), 1);
    TestTrue(TEXT("ids for every key"), R.Data->GetObjectField(TEXT("node_ids"))->HasField(TEXT("mul")));
    const TArray<TSharedPtr<FJsonValue>>& Resolved = R.Data->GetArrayField(TEXT("links_resolved"));
    TestTrue(TEXT("a loose pin name resolves to the real one"),
        Resolved.Num() == 3 && Resolved[2]->AsObject()->GetStringField(TEXT("from_pin")) == TEXT("ReturnValue"));
    TestTrue(TEXT("the automatic entry->result link is untouched"), F.EntryLinkedToResult());
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPBlueprintApplyGraphRejectsTest,
    "Hayba.MCP.Blueprint.ApplyGraph.RejectsBeforeLinking",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPBlueprintApplyGraphRejectsTest::RunTest(const FString&)
{
    FFailAfterLinksScope NoInjection(-1);
    FTwiceFixture F;
    if (!F.Make(*this)) return false;
    const int32 Before = F.Graph->Nodes.Num();

    const FHaybaHandlerResult Unknown = F.Apply(TEXT(R"({"nodes": [{"key": "x", "kind": "call", "function": "NotAFunction", "class": "/Script/Engine.KismetMathLibrary"}]})"));
    TestFalse(TEXT("an unknown function is refused"), Unknown.Data->GetBoolField(TEXT("ok")));
    TestEqual(TEXT("before anything was placed"), Unknown.Data->GetStringField(TEXT("phase")), FString(TEXT("preflight")));
    TestTrue(TEXT("naming it"), Unknown.Data->GetStringField(TEXT("error")).Contains(TEXT("no function 'NotAFunction'")));
    TestEqual(TEXT("graph unchanged"), F.Graph->Nodes.Num(), Before);

    const FHaybaHandlerResult BadPin = F.Apply(TEXT(R"({
        "nodes": [
            {"key": "entry", "kind": "existing", "node_id": "{E}"},
            {"key": "mul", "kind": "call", "function": "Multiply_DoubleDouble", "class": "/Script/Engine.KismetMathLibrary"}
        ],
        "links": [{"from_node": "entry", "from_pin": "In", "to_node": "mul", "to_pin": "Nope"}]
    })"));
    TestFalse(TEXT("a pin the placed node lacks is refused"), BadPin.Data->GetBoolField(TEXT("ok")));
    TestTrue(TEXT("naming the pin"), BadPin.Data->GetStringField(TEXT("error")).Contains(TEXT("no input pin \"Nope\"")));
    TestTrue(TEXT("rolled back"), BadPin.Data->GetBoolField(TEXT("rolled_back")));
    TestEqual(TEXT("the placed node was removed"), F.Graph->Nodes.Num(), Before);
    TestTrue(TEXT("existing links untouched"), F.EntryLinkedToResult());
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPBlueprintApplyGraphRollbackTest,
    "Hayba.MCP.Blueprint.ApplyGraph.RollsBackMidApply",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPBlueprintApplyGraphRollbackTest::RunTest(const FString&)
{
    FTwiceFixture F;
    if (!F.Make(*this)) return false;
    const int32 Before = F.Graph->Nodes.Num();
    const FString OutBefore = F.Find(F.ResultId)->FindPin(TEXT("Out"), EGPD_Input)->DefaultValue;

    FFailAfterLinksScope FailAfterFirstLink(1);
    const FHaybaHandlerResult R = F.Apply(TEXT(R"({
        "nodes": [
            {"key": "entry", "kind": "existing", "node_id": "{E}"},
            {"key": "result", "kind": "existing", "node_id": "{R}"},
            {"key": "br", "kind": "branch"}
        ],
        "defaults": [{"node": "result", "pin": "Out", "value": "5"}],
        "links": [
            {"from_node": "entry", "from_pin": "then", "to_node": "br", "to_pin": "execute"},
            {"from_node": "br", "from_pin": "then", "to_node": "result", "to_pin": "execute"}
        ]
    })"));
    // By the time the hook fires, the literal is set on an existing node and
    // the first link has broken the automatic entry->result link.
    TestFalse(TEXT("the failure is reported"), R.Data->GetBoolField(TEXT("ok")));
    TestTrue(TEXT("as the injected failure"), R.Data->GetStringField(TEXT("error")).Contains(TEXT("injected failure")));
    TestTrue(TEXT("rolled back completely"), R.Data->GetBoolField(TEXT("rolled_back")));
    TestEqual(TEXT("the branch was removed"), F.Graph->Nodes.Num(), Before);
    TestTrue(TEXT("the broken entry->result link is back"), F.EntryLinkedToResult());
    TestEqual(TEXT("the existing node's literal is back"), F.Find(F.ResultId)->FindPin(TEXT("Out"), EGPD_Input)->DefaultValue, OutBefore);
    return true;
}
#endif
```

- [ ] **Step 6: Run the contract tests to verify they pass**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/blueprint-graph-handler-contract.test.ts src/tools/__tests__/plan-mode-gate.test.ts`
Expected: PASS.

- [ ] **Step 7: Compile the plugin, then run the TS gate**

Run the C++ compile gate, then `cd mcp-tools/hayba-mcp && npx tsc --noEmit && npx vitest run`.
Expected: `BUILD SUCCESSFUL`, and only the known TS failure.

- [ ] **Step 8: Commit**

```bash
git add unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCommandHandler.cpp unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaMCPBlueprintApplyGraphTest.cpp mcp-tools/hayba-mcp/src/tools/blueprint-graph-handler-contract.test.ts
git commit -m "feat(blueprint): apply a whole graph in one all-or-nothing call"
```

---

### Task 8: TS wiring (sidecar, retry policy, heavy tier, plan gate, catalogue)

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/legacy-commands/sidecar.json`
- Modify: `mcp-tools/hayba-mcp/src/tools/tool-executor.ts` (`NON_IDEMPOTENT`, Blueprint authoring group)
- Modify: `mcp-tools/hayba-mcp/src/tools/heavy-ops.ts` (`HEAVY_OPS`)
- Modify: `mcp-tools/hayba-mcp/src/chat/agent-loop.ts` (`EXTRA_DESTRUCTIVE`)
- Modify: `mcp-tools/hayba-mcp/src/tools/code-mode/list-tool-categories.ts` (blueprint domain, ~:102-121)
- Test: `mcp-tools/hayba-mcp/src/tools/blueprint-graph-handler-contract.test.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/code-mode/list-tool-categories.test.ts`

**Interfaces:**
- Consumes: the wire commands from Tasks 5–7.
- Produces:
  - `NON_IDEMPOTENT.has('blueprint_apply_graph')` and `isHeavyOp('blueprint_apply_graph')` are both true, so the command gets the 300 s timeout and is never retried.
  - `isDestructiveToolName('blueprint_build_from_spec')` and `isDestructiveToolName('blueprint_set_component_property')` are true.
  - The sidecar has entries for `blueprint_apply_graph` and `blueprint_set_component_property`, and `blueprint_inspect_graph` gains `offset`/`limit`.

- [ ] **Step 1: Write the failing tests**

Add to the imports at the top of `blueprint-graph-handler-contract.test.ts`:

```ts
import { NON_IDEMPOTENT } from './tool-executor.js';
import { isHeavyOp } from './heavy-ops.js';
import { isDestructiveToolName } from '../chat/agent-loop.js';
```

Then append:

```ts
describe('bulk graph authoring on the TS side', () => {
  it('never retries blueprint_apply_graph and gives it the heavy timeout', () => {
    expect(NON_IDEMPOTENT.has('blueprint_apply_graph')).toBe(true);
    expect(isHeavyOp('blueprint_apply_graph')).toBe(true);
  });

  it('plan-gates the spec build and the component setter in the agent loop, not the offline check', () => {
    expect(isDestructiveToolName('blueprint_build_from_spec')).toBe(true);
    expect(isDestructiveToolName('blueprint_set_component_property')).toBe(true);
    expect(isDestructiveToolName('blueprint_spec_check')).toBe(false);
  });

  it('describes the new and changed commands in the sidecar', () => {
    const cmds = getSidecar().commands;
    const params = (name: string) => cmds[name]?.params.map((p) => p.name) ?? [];
    expect(params('blueprint_apply_graph')).toEqual(['path', 'graph_name', 'nodes', 'defaults', 'links']);
    expect(params('blueprint_set_component_property')).toEqual(['path', 'component_name', 'property', 'value']);
    expect(params('blueprint_inspect_graph')).toEqual(['path', 'graph_name', 'offset', 'limit']);
    expect(cmds['blueprint_apply_graph']?.handler_cpp).toBe('FHaybaMCPBlueprintHandler::ApplyGraph');
  });
});
```

Append to `list-tool-categories.test.ts`, inside the first `describe`:

```ts
  it('lists the event, removal and bulk commands in the blueprint domain', async () => {
    const out = await parsedOutput();
    const bp = (out.domains as Array<{ domain: string; callable: string[]; unavailable: string[] }>).find((d) => d.domain === 'blueprint');
    const all = [...(bp?.callable ?? []), ...(bp?.unavailable ?? [])];
    for (const cmd of ['blueprint_add_event', 'blueprint_add_custom_event', 'blueprint_remove_node', 'blueprint_apply_graph', 'blueprint_set_component_property']) {
      expect(all, cmd).toContain(cmd);
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/blueprint-graph-handler-contract.test.ts src/tools/code-mode/list-tool-categories.test.ts`
Expected: FAIL.

- [ ] **Step 3: Register the retry policy, heavy tier and plan gate**

`tool-executor.ts`: in `NON_IDEMPOTENT`, after `'blueprint_remove_node',`, add:

```ts
  // One call places a whole graph. A lost reply may mean it landed; a retry
  // would place every node a second time. Recovery is a rebuild with reset_graphs.
  'blueprint_apply_graph',
```

`heavy-ops.ts`: in `HEAVY_OPS`, after `'ui_mutate_tree',`, add:

```ts
  // Places and wires a whole Blueprint graph (70+ nodes) in one game-thread
  // call. It must not pre-time-out at the medium tier while the editor is
  // still working, and must never be retried.
  'blueprint_apply_graph',
```

`agent-loop.ts`: in `EXTRA_DESTRUCTIVE`, after `'blueprint_set_defaults',`, add:

```ts
  // Set-to-value, so retry-safe, but it changes an asset.
  'blueprint_set_component_property',
  // TS tool that drives many mutating commands; its name matches no verb pattern.
  'blueprint_build_from_spec',
```

- [ ] **Step 4: Update the catalogue**

In `list-tool-categories.ts`, delete the stale three-line comment above the blueprint domain ("blueprint_add_node / blueprint_connect_nodes / blueprint_add_event are C++ stubs …"). Replace that domain entry with:

```ts
  {
    domain: 'blueprint',
    command_count: 19,
    commands: [
      'blueprint_create',
      'blueprint_get_info',
      'blueprint_add_component',
      'blueprint_add_variable',
      'blueprint_add_function',
      'blueprint_add_node',
      'blueprint_connect_nodes',
      'blueprint_set_pin_default',
      'blueprint_compile',
      'blueprint_document',
      'blueprint_inspect_graph',
      'blueprint_set_defaults',
      'blueprint_add_event',
      'blueprint_add_custom_event',
      'blueprint_add_bound_event',
      'blueprint_remove_node',
      'blueprint_apply_graph',
      'blueprint_set_component_property',
      'blueprint_build_from_spec',
    ],
  },
```

- [ ] **Step 5: Update the sidecar**

In `sidecar.json` under `commands`, replace the `blueprint_inspect_graph` entry with the one below. Then add the two new entries next to the other `blueprint_*` entries. Keep the file's key order alphabetical and indentation consistent.

```json
"blueprint_inspect_graph": {
  "aliases": [],
  "handler_cpp": "FHaybaMCPBlueprintHandler::InspectGraph",
  "params": [
    { "name": "path", "type": "string", "required": true },
    { "name": "graph_name", "type": "string", "required": false },
    { "name": "offset", "type": "integer", "required": false, "description": "First node/edge of the page (default 0); pass next_offset to continue" },
    { "name": "limit", "type": "integer", "required": false, "description": "Nodes and edges per page, 1-200 (default 100)" }
  ],
  "returns": { "shape": "object", "fields": [
    { "name": "nodes", "type": "array", "description": "[{node_id, title, enabled, pins:[{name, direction, type, default}]}] for this page" },
    { "name": "edges", "type": "array" },
    { "name": "node_count", "type": "number", "description": "Whole graph, not this page" },
    { "name": "edge_count", "type": "number", "description": "Whole graph, not this page" },
    { "name": "has_more", "type": "boolean" },
    { "name": "next_offset", "type": "number" },
    { "name": "dirty", "type": "boolean" }
  ] },
  "agent_callable": true,
  "has_ts_wrapper": false,
  "notes": "Read-only exact graph export, paged: stable node GUIDs, pin names/directions/types/literals, whether each node is enabled (a new blueprint's BeginPlay/Tick are disabled ghosts), and every edge. Keep reading with next_offset while has_more is true; node_count and edge_count are totals for the whole graph."
},
"blueprint_apply_graph": {
  "aliases": [],
  "handler_cpp": "FHaybaMCPBlueprintHandler::ApplyGraph",
  "params": [
    { "name": "path", "type": "string", "required": true },
    { "name": "graph_name", "type": "string", "required": false, "description": "EventGraph or a function name; omit for the main event graph" },
    { "name": "nodes", "type": "array", "required": true, "description": "[{key, kind, ...}] where kind is existing (node_id), call (function, class?), get or set (variable), branch, sequence or select (count 2-32), self, cast (class), create_widget (class) or timer; x/y optional" },
    { "name": "defaults", "type": "array", "required": false, "description": "[{node: key, pin, value}] literals on unconnected input pins" },
    { "name": "links", "type": "array", "required": false, "description": "[{from_node: key, from_pin, to_node: key, to_pin}] output to input; pin names match exactly, then ignoring case and spaces, then a cast's 'As'" }
  ],
  "returns": { "shape": "object", "fields": [
    { "name": "ok", "type": "boolean" },
    { "name": "node_ids", "type": "object", "description": "key -> node GUID" },
    { "name": "pins", "type": "object", "description": "key -> that node's pins" },
    { "name": "links_resolved", "type": "array", "description": "Each link with the real pin names it resolved to" },
    { "name": "links_verified", "type": "number" },
    { "name": "defaults_verified", "type": "number" },
    { "name": "default_mismatches", "type": "array", "description": "Literals that read back differently than written" },
    { "name": "rolled_back", "type": "boolean", "description": "On failure: every node this call placed was removed and the pins it touched restored" },
    { "name": "errors", "type": "array" }
  ] },
  "agent_callable": true,
  "has_ts_wrapper": false,
  "notes": "Places one Blueprint graph's nodes, pin literals and links in a single all-or-nothing call instead of one command per node, pin and link. Everything is checked (functions, variables, classes, every pin name, every connection) before any link is made; if anything fails, every node it placed is removed and the pins it touched are restored, and the error names the node, pin or link. Never retry after a lost reply: rebuild with blueprint_build_from_spec reset_graphs. Staged until blueprint_compile."
},
"blueprint_set_component_property": {
  "aliases": [],
  "handler_cpp": "FHaybaMCPBlueprintHandler::SetComponentProperty",
  "params": [
    { "name": "path", "type": "string", "required": true },
    { "name": "component_name", "type": "string", "required": true, "description": "A component in this blueprint's own component tree (see blueprint_get_info)" },
    { "name": "property", "type": "string", "required": true, "description": "Property on the component, e.g. Sound, bAutoActivate, VolumeMultiplier" },
    { "name": "value", "type": "any", "required": true, "description": "Number, string, bool, an asset path for an object property, or an object for a struct" }
  ],
  "returns": { "shape": "object", "fields": [
    { "name": "applied", "type": "string", "description": "The value as stored on the template" },
    { "name": "verified", "type": "boolean" }
  ] },
  "agent_callable": true,
  "has_ts_wrapper": false,
  "notes": "Sets a property on a Blueprint component's template (the SCS node every instance copies), e.g. an AudioComponent's Sound or bAutoActivate, which blueprint_set_defaults cannot reach because it only edits the class defaults. The value is staged first, so a value that cannot be applied changes nothing; the stored value is read back. Staged until blueprint_compile."
}
```

Also append this sentence to the `notes` of `blueprint_set_pin_default`: ` Text pins are verified against the text literal itself.`

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/blueprint-graph-handler-contract.test.ts src/tools/code-mode/list-tool-categories.test.ts src/tools/__tests__/plan-mode-gate.test.ts src/tools/__tests__/wire-command-names.test.ts src/legacy-commands src/tools/legacy-tool-factory.test.ts src/tools/tool-executor.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the TS gate**

Run: `cd mcp-tools/hayba-mcp && npx tsc --noEmit && npx vitest run`
Expected: only the known pre-existing failure. If the list-tool-categories coverage test now flags `blueprint_build_from_spec` as advertised-but-unwrapped, that is correct until Task 10 lands: it is reported as `unavailable`, and no test asserts otherwise.

- [ ] **Step 8: Commit**

```bash
git add mcp-tools/hayba-mcp/src/legacy-commands/sidecar.json mcp-tools/hayba-mcp/src/tools/tool-executor.ts mcp-tools/hayba-mcp/src/tools/heavy-ops.ts mcp-tools/hayba-mcp/src/chat/agent-loop.ts mcp-tools/hayba-mcp/src/tools/code-mode/list-tool-categories.ts mcp-tools/hayba-mcp/src/tools/code-mode/list-tool-categories.test.ts mcp-tools/hayba-mcp/src/tools/blueprint-graph-handler-contract.test.ts
git commit -m "feat(blueprint): wire bulk graph commands into retry, timeout, plan gate and catalogue"
```

---

### Task 9: The four-pass build (`spec-build.ts`) with a stateful fake editor

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/testing/fake-blueprint-editor.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-build.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-build.test.ts`

**Interfaces:**
- Consumes:
  - From Task 3: `planBuild`, `applyGraphPayload`, `findTerminals`, `signatureProblems`, `resolvePin`, and the types `InspectedGraph`, `InspectedNode`, `InspectedEdge`, `PlannedAsset`, `PlannedGraph`, `BuildPlan`.
  - From Task 1: `parseType`, `CATEGORY_OF_KIND`.
  - Existing: `executeCommand`, `UeToolError`, `Sender`.
- Produces:
  - `interface BuildOptions { resetGraphs?: boolean; dryRun?: boolean; targetRoot?: string; allowLivePaths?: boolean; sender?: Sender; now?: () => number }`
  - `interface GraphReport { graph: string; nodes_created: number; nodes_expected: number; links_verified: number; links_expected: number; missing_links: string[]; ghost_events: string[] }`
  - `interface AssetReport { asset: string; compiled: boolean; graphs: GraphReport[] }`
  - `interface PlanSummary { assets: number; graphs: number; nodes: number; links: number; defaults: number; operations: string[] }`
  - `interface BuildReport { ok: boolean; duration_ms: number; dry_run: boolean; assets: AssetReport[]; warnings: string[]; errors: string[]; planned?: PlanSummary }`
  - `readGraphComplete(path: string, graph: string, sender?: Sender): Promise<InspectedGraph>`
  - `buildFromSpecs(entries: SpecEntry[], opts?: BuildOptions): Promise<BuildReport>`
  - `class FakeBlueprintEditor` (test helper): `send: Sender`; `seed(path, init)`; `graph(path, name)`; `count(cmd)`; fields `calls`, `pieRunning`, `pageCap`, `rejectApplyFor`, `dropAfterApplying`, `ghostsStayDisabled`, `truncateInspect`, `ignoreOffset`, `hideVariablesFromInfo`.

- [ ] **Step 1: Write the fake editor**

```ts
// mcp-tools/hayba-mcp/src/tools/testing/fake-blueprint-editor.ts
//
// A stateful stand-in for the blueprint half of the Hayba plugin, for driving
// blueprint_build_from_spec end to end without an editor. ScriptedUe answers
// each command with a canned reply; a four-pass build needs a graph that
// remembers what earlier commands did. Each knob models a failure the real
// editor produces.

import type { Sender } from '../tool-executor.js';
import type { TcpResponse } from '../../tcp-client.js';
import { CATEGORY_OF_KIND, parseType } from '../blueprint/spec-builder/spec-parse.js';

export interface FakePin { name: string; direction: 'input' | 'output'; type: string; default: string }
export interface FakeNode { node_id: string; title: string; enabled: boolean; pins: FakePin[]; event?: string; terminal?: 'entry' | 'result' }
export interface FakeEdge { from_node: string; from_pin: string; to_node: string; to_pin: string }
export interface FakeGraph { nodes: FakeNode[]; edges: FakeEdge[] }
export interface FakeBlueprint {
  parent: string;
  variables: Map<string, { type: string; default?: unknown }>;
  components: Map<string, { class: string; properties: Record<string, unknown> }>;
  functions: Map<string, { inputs: string[]; outputs: string[] }>;
  graphs: Map<string, FakeGraph>;
  cdo: Record<string, unknown>;
}

type Reply = Omit<TcpResponse, 'id'>;
const ok = (data: Record<string, unknown>): Reply => ({ ok: true, data });
const refuse = (error: string, data?: Record<string, unknown>): Reply => ({ ok: false, error, ...(data ? { data } : {}) });
const categoryOf = (type: string): string => {
  const t = parseType(type);
  return 'error' in t ? 'unknown' : CATEGORY_OF_KIND[t.kind];
};

export class FakeBlueprintEditor {
  readonly assets = new Map<string, FakeBlueprint>();
  readonly calls: Array<{ cmd: string; params: Record<string, unknown> }> = [];
  /** level_get_info reports a running PIE session. */
  pieRunning = false;
  /** Server-side cap on one inspect page, like a response cap. */
  pageCap = 200;
  /** blueprint_apply_graph for this graph is refused and reported rolled back. */
  rejectApplyFor?: string;
  /** This command lands, then its reply is lost (the transport throws) — once. */
  dropAfterApplying?: string;
  /** Ghost events stay disabled even after they are wired. */
  ghostsStayDisabled = false;
  /** Every inspect page carries `_truncated` (an old plugin under the 50-item cap). */
  truncateInspect = false;
  /** inspect ignores `offset` (a server that does not page). */
  ignoreOffset = false;
  /** blueprint_get_info lists no variables (the old 50-item cap on long lists). */
  hideVariablesFromInfo = false;
  private seq = 0;

  seed(path: string, init: {
    parent?: string;
    variables?: Record<string, { type: string; default?: unknown }>;
    functions?: Record<string, { inputs?: string[]; outputs?: string[] }>;
    eventGraphNodes?: number;
  } = {}): FakeBlueprint {
    const bp = this.newBlueprint(init.parent ?? '/Script/Engine.Actor');
    for (const [name, v] of Object.entries(init.variables ?? {})) bp.variables.set(name, v);
    for (const [name, f] of Object.entries(init.functions ?? {})) this.addFunction(bp, name, f.inputs ?? [], f.outputs ?? []);
    const eg = bp.graphs.get('EventGraph');
    for (let i = 0; i < (init.eventGraphNodes ?? 0); i++) {
      eg?.nodes.push(this.node(`Print ${i}`, [{ name: 'execute', direction: 'input' }, { name: 'then', direction: 'output' }]));
    }
    this.assets.set(path, bp);
    return bp;
  }

  graph(path: string, name: string): FakeGraph {
    const g = this.assets.get(path)?.graphs.get(name);
    if (!g) throw new Error(`fake: no graph ${path}:${name}`);
    return g;
  }

  count(cmd: string, match: (p: Record<string, unknown>) => boolean = () => true): number {
    return this.calls.filter((c) => c.cmd === cmd && match(c.params)).length;
  }

  send: Sender = async (cmd, params) => {
    this.calls.push({ cmd, params });
    const reply = this.handle(cmd, params);
    if (this.dropAfterApplying === cmd) {
      this.dropAfterApplying = undefined;
      throw new Error('socket closed');
    }
    return { id: 'fake', ...reply };
  };

  private node(title: string, pins: Array<{ name: string; direction: 'input' | 'output' }>, extra: Partial<FakeNode> = {}): FakeNode {
    return { node_id: `N${String(++this.seq).padStart(4, '0')}`, title, enabled: true, pins: pins.map((p) => ({ ...p, type: 'exec', default: '' })), ...extra };
  }

  private newBlueprint(parent: string): FakeBlueprint {
    const bp: FakeBlueprint = { parent, variables: new Map(), components: new Map(), functions: new Map(), graphs: new Map(), cdo: {} };
    if (!/FunctionLibrary/.test(parent)) {
      // A new Blueprint's automatic, disabled BeginPlay: a "ghost" until wired.
      bp.graphs.set('EventGraph', { nodes: [this.node('Event BeginPlay', [{ name: 'then', direction: 'output' }], { enabled: false, event: 'ReceiveBeginPlay' })], edges: [] });
    }
    return bp;
  }

  private addFunction(bp: FakeBlueprint, name: string, inputs: string[], outputs: string[]): { entry: FakeNode; result?: FakeNode } {
    const entry = this.node(name, [{ name: 'then', direction: 'output' }, ...inputs.map((n) => ({ name: n, direction: 'output' as const }))], { terminal: 'entry' });
    const g: FakeGraph = { nodes: [entry], edges: [] };
    let result: FakeNode | undefined;
    if (outputs.length > 0) {
      result = this.node('Return Node', [{ name: 'execute', direction: 'input' }, ...outputs.map((n) => ({ name: n, direction: 'input' as const }))], { terminal: 'result' });
      g.nodes.push(result);
      g.edges.push({ from_node: entry.node_id, from_pin: 'then', to_node: result.node_id, to_pin: 'execute' });
    }
    bp.functions.set(name, { inputs, outputs });
    bp.graphs.set(name, g);
    return { entry, result };
  }

  private ensurePin(n: FakeNode, name: string, direction: 'input' | 'output'): FakePin {
    let pin = n.pins.find((p) => p.name === name && p.direction === direction);
    if (!pin) {
      pin = { name, direction, type: 'wildcard', default: '' };
      n.pins.push(pin);
    }
    return pin;
  }

  private eventGraph(bp: FakeBlueprint, p: Record<string, unknown>): FakeGraph {
    const name = String(p.graph_name ?? 'EventGraph');
    let g = bp.graphs.get(name);
    if (!g) { g = { nodes: [], edges: [] }; bp.graphs.set(name, g); }
    return g;
  }

  private handle(cmd: string, p: Record<string, unknown>): Reply {
    const path = String(p.path ?? '');
    const bp = this.assets.get(path);
    const need = (): FakeBlueprint => {
      if (!bp) throw new Error(`fake: ${cmd} on missing ${path}`);
      return bp;
    };
    switch (cmd) {
      case 'level_get_info':
        return ok({ map_name: 'Fake', actor_count: 0, is_pie_running: this.pieRunning });
      case 'blueprint_get_info':
        if (!bp) return refuse(`blueprint_get_info: no blueprint at '${path}'`);
        return ok({
          name: path.slice(path.lastIndexOf('/') + 1),
          parent_class: bp.parent,
          variables: this.hideVariablesFromInfo ? [] : [...bp.variables].map(([name, v]) => ({ name, type: categoryOf(v.type) })),
          functions: [...bp.functions.keys()],
          components: [...bp.components].map(([name, c]) => ({ name, class: c.class })),
        });
      case 'blueprint_create': {
        const target = String(p.package_path);
        if (this.assets.has(target)) return refuse('blueprint_create: name taken');
        this.assets.set(target, this.newBlueprint(String(p.parent_class_path)));
        return ok({ path: `${target}.${String(p.name)}`, saved: true });
      }
      case 'asset_duplicate': {
        const src = this.assets.get(String(p.source_path));
        if (!src) return refuse('asset_duplicate: DuplicateAsset failed');
        this.assets.set(String(p.destination_path), structuredClone(src));
        return ok({ new_path: String(p.destination_path) });
      }
      case 'blueprint_add_variable': {
        const b = need();
        const name = String(p.variable_name);
        if ([...b.variables.keys()].some((k) => k.toLowerCase() === name.toLowerCase())) {
          return refuse(`blueprint_add_variable: variable '${name}' already exists; nothing was changed`);
        }
        b.variables.set(name, { type: String(p.variable_type), default: p.default_value });
        return ok({ variable_name: name, verified: true, compiled_clean: true });
      }
      case 'blueprint_add_component': {
        need().components.set(String(p.component_name), { class: String(p.component_class_path), properties: {} });
        return ok({ component_name: String(p.component_name), verified: true, compiled_clean: true });
      }
      case 'blueprint_add_function': {
        const b = need();
        const name = String(p.function_name);
        if (b.graphs.has(name)) return refuse(`blueprint_add_function: '${name}' already exists on this blueprint`);
        const names = (list: unknown): string[] => (Array.isArray(list) ? list : []).map((x) => String((x as { name: unknown }).name));
        const t = this.addFunction(b, name, names(p.inputs), names(p.outputs));
        return ok({ function_name: name, verified: true, compiled_clean: true, entry_node_id: t.entry.node_id, ...(t.result ? { result_node_id: t.result.node_id } : {}) });
      }
      case 'blueprint_compile':
        need();
        return ok({ ok: true, compiled: true, errors: [], warnings: [], ...(p.save === false ? { save_requested: false } : { saved: true }) });
      case 'blueprint_set_defaults': {
        const b = need();
        const props = p.properties as Record<string, unknown>;
        for (const [k, v] of Object.entries(props)) {
          const variable = b.variables.get(k);
          if (variable) variable.default = v;
          else b.cdo[k] = v;
        }
        return ok({ set: Object.keys(props), succeeded: Object.keys(props).length, failed: 0, skipped: [], verification_failed: [], verified: true });
      }
      case 'blueprint_set_component_property': {
        const c = need().components.get(String(p.component_name));
        if (!c) return refuse(`blueprint_set_component_property: no component '${String(p.component_name)}'`);
        c.properties[String(p.property)] = p.value;
        return ok({ component_name: String(p.component_name), property: String(p.property), applied: String(p.value), verified: true });
      }
      case 'blueprint_inspect_graph':
        return this.inspect(need(), p);
      case 'blueprint_remove_node': {
        const g = need().graphs.get(String(p.graph_name));
        const n = g?.nodes.find((x) => x.node_id === p.node_id);
        if (!g || !n) return refuse('blueprint_remove_node: no node');
        if (n.terminal) return refuse("blueprint_remove_node: refusing to remove the function's entry/result node");
        g.nodes = g.nodes.filter((x) => x !== n);
        g.edges = g.edges.filter((e) => e.from_node !== n.node_id && e.to_node !== n.node_id);
        return ok({ removed_node_id: n.node_id, verified: true });
      }
      case 'blueprint_add_event': {
        const g = this.eventGraph(need(), p);
        const name = String(p.event_name);
        const existing = g.nodes.find((n) => n.event === name);
        if (existing) return ok({ node_id: existing.node_id, pins: existing.pins, already_existed: true, enabled: existing.enabled, verified: true });
        const n = this.node(`Event ${name.replace(/^Receive/, '')}`, [{ name: 'then', direction: 'output' }], { event: name });
        g.nodes.push(n);
        return ok({ node_id: n.node_id, pins: n.pins, already_existed: false, enabled: true, verified: true });
      }
      case 'blueprint_add_custom_event':
      case 'blueprint_add_bound_event': {
        const g = this.eventGraph(need(), p);
        const n = this.node(String(p.event_name), [{ name: 'then', direction: 'output' }]);
        g.nodes.push(n);
        return ok({ node_id: n.node_id, pins: n.pins, verified: true });
      }
      case 'blueprint_apply_graph':
        return this.apply(need(), p);
      default:
        throw new Error(`fake editor: no command "${cmd}"`);
    }
  }

  private inspect(bp: FakeBlueprint, p: Record<string, unknown>): Reply {
    const g = bp.graphs.get(String(p.graph_name));
    if (!g) return refuse('blueprint_inspect_graph: graph not found');
    const limit = Math.min(Number(p.limit ?? 100), this.pageCap);
    const offset = this.ignoreOffset ? 0 : Number(p.offset ?? 0);
    const end = offset + limit;
    const hasMore = end < Math.max(g.nodes.length, g.edges.length);
    return ok({
      nodes: g.nodes.slice(offset, end),
      edges: g.edges.slice(offset, end),
      node_count: g.nodes.length,
      edge_count: g.edges.length,
      offset,
      limit,
      has_more: hasMore,
      ...(hasMore ? { next_offset: end } : {}),
      ...(this.truncateInspect ? { _truncated: [{ path: 'edges', kind: 'array', removed: 13 }] } : {}),
    });
  }

  private apply(bp: FakeBlueprint, p: Record<string, unknown>): Reply {
    const graphName = String(p.graph_name);
    const g = bp.graphs.get(graphName);
    if (!g) return refuse('blueprint_apply_graph: graph not found');
    if (this.rejectApplyFor === graphName) {
      return refuse('blueprint_apply_graph: link 0: injected failure. The graph is as it was before the call.', {
        ok: false, code: 'apply_graph_rejected', rolled_back: true, mutation_status: 'not_started', errors: ['link 0: injected failure'],
      });
    }
    const nodes = p.nodes as Array<{ key: string; kind: string; node_id?: string }>;
    const links = (p.links ?? []) as Array<{ from_node: string; from_pin: string; to_node: string; to_pin: string }>;
    const defaults = (p.defaults ?? []) as Array<{ node: string; pin: string; value: string }>;
    const byKey = new Map<string, FakeNode>();
    for (const n of nodes) {
      if (n.kind !== 'existing') continue;
      const found = g.nodes.find((x) => x.node_id === n.node_id);
      if (!found) return refuse(`blueprint_apply_graph: node '${n.key}': no node '${String(n.node_id)}'`, { ok: false, rolled_back: true, errors: [`node '${n.key}': no node`] });
      byKey.set(n.key, found);
    }
    const created: FakeNode[] = [];
    for (const n of nodes) {
      if (n.kind === 'existing') continue;
      const made = this.node(`${n.kind} ${n.key}`, [{ name: 'execute', direction: 'input' }, { name: 'then', direction: 'output' }]);
      created.push(made);
      byKey.set(n.key, made);
    }
    for (const l of links) {
      this.ensurePin(byKey.get(l.from_node)!, l.from_pin, 'output');
      this.ensurePin(byKey.get(l.to_node)!, l.to_pin, 'input');
    }
    for (const d of defaults) this.ensurePin(byKey.get(d.node)!, d.pin, 'input').default = d.value;
    g.nodes.push(...created);
    for (const l of links) {
      const from = byKey.get(l.from_node)!;
      const to = byKey.get(l.to_node)!;
      const exists = g.edges.some((e) => e.from_node === from.node_id && e.from_pin === l.from_pin && e.to_node === to.node_id && e.to_pin === l.to_pin);
      if (!exists) g.edges.push({ from_node: from.node_id, from_pin: l.from_pin, to_node: to.node_id, to_pin: l.to_pin });
      if (!from.enabled && !this.ghostsStayDisabled) from.enabled = true;
    }
    return ok({
      ok: true,
      node_ids: Object.fromEntries([...byKey].map(([k, n]) => [k, n.node_id])),
      links_verified: links.length,
      defaults_verified: defaults.length,
      nodes_created: created.length,
      verified: true,
    });
  }
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-build.test.ts
import { describe, expect, it, vi } from 'vitest';
import { FakeBlueprintEditor } from '../../testing/fake-blueprint-editor.js';
import { buildFromSpecs, readGraphComplete } from './spec-build.js';
import type { BlueprintSpec, SpecEntry } from './spec-types.js';

// apply_graph is a heavy op; its transport-failure path probes for the editor process.
vi.mock('../../heavy-op-probe.js', () => ({ probeEditorProcess: async () => null }));

const LIB: BlueprintSpec = {
  asset: '/Game/Test/Flow/BFL_Math',
  create: { parent: '/Script/Engine.BlueprintFunctionLibrary' },
  functions: [{ name: 'Twice', inputs: [{ name: 'In', type: 'float' }], outputs: [{ name: 'Out', type: 'float' }], pure: true }],
  graphs: [{
    graph: 'Twice',
    nodes: { entry: { entry: true }, result: { result: true }, mul: { call: 'Multiply_DoubleDouble', class: '/Script/Engine.KismetMathLibrary' } },
    links: [['entry.then', 'result.execute'], ['entry.In', 'mul.A'], ['mul.ReturnValue', 'result.Out']],
    defaults: { 'mul.B': 2 },
  }],
};
const ACTOR: BlueprintSpec = {
  asset: '/Game/Test/Flow/BP_Flow',
  create: { parent: '/Script/Engine.Actor' },
  variables: [{ name: 'Glow', type: 'name', default: 'Dim' }, { name: 'Rate', type: 'float', default: 0.2 }],
  components: [{ name: 'Music', class: '/Script/Engine.AudioComponent', properties: { bAutoActivate: false } }],
  functions: [{ name: 'Step' }],
  graphs: [
    { graph: 'Step', nodes: { entry: { entry: true }, s: { set: 'Glow' } }, links: [['entry.then', 's.execute']], defaults: { 's.Glow': 'Bright' } },
    {
      graph: 'EventGraph',
      nodes: { bp: { event: 'ReceiveBeginPlay' }, tick: { custom_event: 'OnTick' }, step: { call: 'Step' }, step2: { call: 'Step' } },
      links: [['bp.then', 'step.execute'], ['tick.then', 'step2.execute']],
    },
  ],
  cdo_defaults: { Rate: 0.5 },
};
const entries = (...specs: BlueprintSpec[]): SpecEntry[] => specs.map((spec, i) => ({ file: `spec${i}.json`, spec: structuredClone(spec) }));

describe('buildFromSpecs — the happy path', () => {
  it('builds, compiles, verifies and reports every count', async () => {
    const ue = new FakeBlueprintEditor();
    const report = await buildFromSpecs(entries(LIB, ACTOR), { sender: ue.send });
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.assets.map((a) => a.compiled)).toEqual([true, true]);
    const eg = report.assets[1]!.graphs.find((g) => g.graph === 'EventGraph')!;
    expect(eg).toEqual({ graph: 'EventGraph', nodes_created: 4, nodes_expected: 4, links_verified: 2, links_expected: 2, missing_links: [], ghost_events: [] });
    expect(ue.count('blueprint_apply_graph')).toBe(3);
    expect(ue.count('blueprint_connect_nodes')).toBe(0);
    expect(ue.assets.get(ACTOR.asset)!.components.get('Music')!.properties).toEqual({ bAutoActivate: false });
    // cdo_defaults ran after the variable's own default, so the CDO value wins.
    expect(ue.assets.get(ACTOR.asset)!.variables.get('Rate')!.default).toBe(0.5);
  });

  it('places a custom event and compiles before anything calls it', async () => {
    const ue = new FakeBlueprintEditor();
    await buildFromSpecs(entries(ACTOR), { sender: ue.send });
    const order = ue.calls.map((c) => c.cmd);
    const customAt = order.indexOf('blueprint_add_custom_event');
    const eventCompile = ue.calls.findIndex((c, i) => i > customAt && c.cmd === 'blueprint_compile' && c.params.save === false);
    const applyEg = ue.calls.findIndex((c) => c.cmd === 'blueprint_apply_graph' && c.params.graph_name === 'EventGraph');
    expect(customAt).toBeGreaterThan(-1);
    expect(eventCompile).toBeGreaterThan(customAt);
    expect(applyEg).toBeGreaterThan(eventCompile);
  });
});

describe('buildFromSpecs — refusals that change nothing', () => {
  it('a dry run plans and sends nothing', async () => {
    const ue = new FakeBlueprintEditor();
    const report = await buildFromSpecs(entries(LIB, ACTOR), { sender: ue.send, dryRun: true });
    expect(ue.calls).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.planned).toMatchObject({ assets: 2, graphs: 3, nodes: 9, links: 6, defaults: 2 });
    expect(report.planned!.operations.some((o) => /apply_graph .*BP_Flow EventGraph: 2 node\(s\), 2 link\(s\)/.test(o))).toBe(true);
  });

  it('refuses a live asset path before any editor call', async () => {
    const ue = new FakeBlueprintEditor();
    const live = { ...structuredClone(LIB), asset: '/Game/Live/Flow/BFL_Math' };
    const report = await buildFromSpecs(entries(live), { sender: ue.send });
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toMatch(/is under \/Game\/Live\/Flow/);
    expect(ue.calls).toEqual([]);
  });

  it('refuses while PIE is running, after one read', async () => {
    const ue = new FakeBlueprintEditor();
    ue.pieRunning = true;
    const report = await buildFromSpecs(entries(LIB), { sender: ue.send });
    expect(report.errors[0]).toMatch(/Play-In-Editor is running/);
    expect(ue.calls.map((c) => c.cmd)).toEqual(['level_get_info']);
  });

  it('refuses an existing function whose signature differs, before compiling', async () => {
    const ue = new FakeBlueprintEditor();
    ue.seed(LIB.asset, { parent: '/Script/Engine.BlueprintFunctionLibrary', functions: { Twice: { inputs: ['X'], outputs: ['Out'] } } });
    const report = await buildFromSpecs(entries(LIB), { sender: ue.send });
    expect(report.errors.join('\n')).toMatch(/function Twice exists with inputs \[x\], spec says \[in\]; Hayba cannot change a signature/);
    expect(ue.count('blueprint_compile')).toBe(0);
  });

  it('refuses a graph that already has a build unless reset_graphs', async () => {
    const ue = new FakeBlueprintEditor();
    await buildFromSpecs(entries(LIB), { sender: ue.send });
    const again = await buildFromSpecs(entries(LIB), { sender: ue.send });
    expect(again.errors.join('\n')).toMatch(/graph Twice already has 1 node\(s\) and 2 link\(s\); run again with reset_graphs/);
    const reset = await buildFromSpecs(entries(LIB), { sender: ue.send, resetGraphs: true });
    expect(reset.ok).toBe(true);
    expect(ue.graph(LIB.asset, 'Twice').nodes).toHaveLength(3);
  });
});

describe('buildFromSpecs — failures mid-build', () => {
  it('stops after a rolled-back apply: earlier graphs stay, nothing further is saved', async () => {
    const ue = new FakeBlueprintEditor();
    ue.rejectApplyFor = 'EventGraph';
    const report = await buildFromSpecs(entries(LIB, ACTOR), { sender: ue.send });
    expect(report.ok).toBe(false);
    expect(report.errors.join('\n')).toMatch(/graph EventGraph: blueprint_apply_graph failed \(rolled back; the graph is as it was before the call\): link 0: injected failure/);
    expect(ue.count('blueprint_apply_graph')).toBe(3);
    expect(ue.count('blueprint_compile', (p) => p.save === true)).toBe(2); // skeleton only
    expect(ue.graph(LIB.asset, 'Twice').nodes.some((n) => n.title === 'call mul')).toBe(true);
  });

  it('a dropped apply is never retried, and a re-run refuses or resets the half-built graph', async () => {
    const ue = new FakeBlueprintEditor();
    ue.dropAfterApplying = 'blueprint_apply_graph';
    const first = await buildFromSpecs(entries(LIB), { sender: ue.send });
    expect(first.ok).toBe(false);
    expect(first.errors.join('\n')).toMatch(/the connection dropped, so whether it applied is unknown — do not retry blindly; run the build again with reset_graphs/);
    expect(ue.count('blueprint_apply_graph')).toBe(1);

    const rerun = await buildFromSpecs(entries(LIB), { sender: ue.send });
    expect(rerun.errors.join('\n')).toMatch(/graph Twice already has/);

    const reset = await buildFromSpecs(entries(LIB), { sender: ue.send, resetGraphs: true });
    expect(reset.ok).toBe(true);
    expect(ue.graph(LIB.asset, 'Twice').nodes.filter((n) => n.title === 'call mul')).toHaveLength(1);
  });

  it('reports a ghost event that stayed disabled', async () => {
    const ue = new FakeBlueprintEditor();
    ue.ghostsStayDisabled = true;
    const report = await buildFromSpecs(entries(ACTOR), { sender: ue.send });
    expect(report.ok).toBe(false);
    expect(report.assets[0]!.graphs.find((g) => g.graph === 'EventGraph')!.ghost_events).toEqual(['bp (disabled)']);
  });
});

describe('buildFromSpecs — addendum gaps and bpgraph patches', () => {
  it('updates the default of a variable that already exists (addendum gap a)', async () => {
    const ue = new FakeBlueprintEditor();
    ue.seed(ACTOR.asset, { variables: { Glow: { type: 'name', default: 'Old' } } });
    await buildFromSpecs(entries(ACTOR), { sender: ue.send, resetGraphs: true });
    const zone = ue.calls.find((c) => c.cmd === 'blueprint_add_variable' && c.params.variable_name === 'Glow');
    expect(zone).toBeUndefined();
    expect(ue.calls.some((c) => c.cmd === 'blueprint_set_defaults' && (c.params.properties as Record<string, unknown>).Glow === 'Dim')).toBe(true);
    expect(ue.assets.get(ACTOR.asset)!.variables.get('Glow')!.default).toBe('Dim');
  });

  it('treats "already exists" from add_variable as existing, with a warning (patch 4)', async () => {
    const ue = new FakeBlueprintEditor();
    ue.seed(ACTOR.asset, { variables: { Glow: { type: 'name', default: 'Old' } } });
    ue.hideVariablesFromInfo = true;
    const report = await buildFromSpecs(entries(ACTOR), { sender: ue.send, resetGraphs: true });
    expect(report.ok).toBe(true);
    expect(report.warnings.join('\n')).toMatch(/variable Glow already exists/);
  });

  it('sets component template properties (addendum gap b)', async () => {
    const ue = new FakeBlueprintEditor();
    await buildFromSpecs(entries(ACTOR), { sender: ue.send });
    expect(ue.calls.find((c) => c.cmd === 'blueprint_set_component_property')!.params)
      .toEqual({ path: ACTOR.asset, component_name: 'Music', property: 'bAutoActivate', value: false });
  });

  it('resets a graph larger than one page, reading it in pages (patch 2)', async () => {
    const ue = new FakeBlueprintEditor();
    ue.pageCap = 50;
    ue.seed(ACTOR.asset, { eventGraphNodes: 60 });
    const report = await buildFromSpecs(entries(ACTOR), { sender: ue.send, resetGraphs: true });
    expect(report.ok).toBe(true);
    expect(ue.count('blueprint_remove_node')).toBe(61); // 60 plus the ghost BeginPlay
  });

  it('verifies a graph with more than 50 edges from complete paged reads (patches 1 and 3)', async () => {
    const ue = new FakeBlueprintEditor();
    ue.pageCap = 50;
    const nodes: Record<string, Record<string, unknown>> = { go: { custom_event: 'Go' } };
    const links: Array<[string, string]> = [['go.then', 'c0.execute']];
    for (let i = 0; i < 60; i++) {
      nodes[`c${i}`] = { call: 'PrintString', class: '/Script/Engine.KismetSystemLibrary' };
      if (i > 0) links.push([`c${i - 1}.then`, `c${i}.execute`]);
    }
    const chain: BlueprintSpec = { asset: '/Game/Test/Flow/BP_Chain', create: { parent: '/Script/Engine.Actor' }, graphs: [{ graph: 'EventGraph', nodes, links }] };
    const report = await buildFromSpecs(entries(chain), { sender: ue.send });
    expect(report.ok).toBe(true);
    const g = report.assets[0]!.graphs[0]!;
    expect(g.links_verified).toBe(60);
    expect(g.links_expected).toBe(60);
    expect(ue.count('blueprint_inspect_graph', (p) => p.offset === 50)).toBeGreaterThan(0);
  });

  it('refuses to build on a truncated read', async () => {
    const ue = new FakeBlueprintEditor();
    ue.truncateInspect = true;
    const report = await buildFromSpecs(entries(LIB), { sender: ue.send });
    expect(report.ok).toBe(false);
    expect(report.errors.join('\n')).toMatch(/truncated a page of Twice/);
    expect(ue.count('blueprint_apply_graph')).toBe(0);
  });

  it('copies a spec without "create" from its live source under target_root, and resets its graphs', async () => {
    const ue = new FakeBlueprintEditor();
    const live = '/Game/Live/Flow/UI/WBP_Sub';
    ue.seed(live, { parent: '/Script/UMG.UserWidget', functions: { SetOpen: { inputs: ['bOpen'] } } });
    ue.graph(live, 'SetOpen').nodes.push({ node_id: 'OLD1', title: 'old', enabled: true, pins: [] });
    const spec: BlueprintSpec = {
      asset: live,
      functions: [{ name: 'SetOpen', inputs: [{ name: 'bOpen', type: 'bool' }] }],
      graphs: [{ graph: 'SetOpen', nodes: { entry: { entry: true }, b: { branch: true } }, links: [['entry.then', 'b.execute'], ['entry.bOpen', 'b.Condition']] }],
    };
    const report = await buildFromSpecs(entries(spec), { sender: ue.send, targetRoot: '/Game/HaybaMCPAutomation/SpecBuild' });
    expect(report.ok).toBe(true);
    const copy = '/Game/HaybaMCPAutomation/SpecBuild/WBP_Sub';
    expect(ue.calls.find((c) => c.cmd === 'asset_duplicate')!.params).toEqual({ source_path: live, destination_path: copy });
    expect(ue.graph(copy, 'SetOpen').nodes.some((n) => n.node_id === 'OLD1')).toBe(false);
    expect(ue.graph(live, 'SetOpen').nodes.some((n) => n.node_id === 'OLD1')).toBe(true);
    expect(ue.calls.every((c) => c.cmd === 'asset_duplicate' || c.cmd === 'level_get_info' || c.params.path !== live)).toBe(true);
  });
});

describe('readGraphComplete', () => {
  const seeded = (): FakeBlueprintEditor => {
    const ue = new FakeBlueprintEditor();
    ue.pageCap = 50;
    ue.seed('/Game/T/BP', { eventGraphNodes: 59 });
    return ue;
  };

  it('reads every page', async () => {
    const ue = seeded();
    const g = await readGraphComplete('/Game/T/BP', 'EventGraph', ue.send);
    expect(g.nodes).toHaveLength(60);
    expect(g.node_count).toBe(60);
  });

  it('refuses a server that ignores offset', async () => {
    const ue = seeded();
    ue.ignoreOffset = true;
    await expect(readGraphComplete('/Game/T/BP', 'EventGraph', ue.send)).rejects.toThrow(/did not advance past offset/);
  });

  it('refuses a plugin that does not page', async () => {
    const sender = async () => ({ id: 'x', ok: true, data: { nodes: [], edges: [], node_count: 0, edge_count: 0 } });
    await expect(readGraphComplete('/Game/T/BP', 'EventGraph', sender)).rejects.toThrow(/predates paged inspect/);
  });

  it('refuses a graph that changes between pages', async () => {
    const ue = seeded();
    const inner = ue.send;
    let page = 0;
    const sender: typeof inner = async (cmd, params, t) => {
      const r = await inner(cmd, params, t);
      if (cmd === 'blueprint_inspect_graph' && page++ === 1) (r.data as Record<string, unknown>).node_count = 61;
      return r;
    };
    await expect(readGraphComplete('/Game/T/BP', 'EventGraph', sender)).rejects.toThrow(/changed while it was being read/);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/blueprint/spec-builder/spec-build.test.ts`
Expected: FAIL with "Failed to resolve import './spec-build.js'".

- [ ] **Step 4: Write `spec-build.ts`**

```ts
// Builds checked Blueprint specs in the live editor, in four passes:
//
//   1 skeleton  create (or copy) each asset; add variables, components and
//               functions; check the signatures of existing functions; update
//               existing variables' defaults; compile and save.
//   2 graphs    refuse (or, with reset_graphs, clear) graphs that already hold
//               a build; place events; compile so custom events are callable;
//               then one blueprint_apply_graph per graph, all or nothing.
//   3 finish    component template properties, CDO defaults, compile and save.
//   4 verify    complete paged reads: every spec link is a real edge, and every
//               event a link leaves from is enabled.
//
// Each command goes through executeCommand with a literal name (see
// wire-command-names.test.ts). The build never starts PIE and saves only the
// assets it builds (blueprint_compile saves its own package).

import { executeCommand, UeToolError, type Sender } from '../../tool-executor.js';
import { CATEGORY_OF_KIND, parseType } from './spec-parse.js';
import {
  applyGraphPayload, findTerminals, planBuild, resolvePin, signatureProblems,
  type BuildPlan, type InspectedEdge, type InspectedGraph, type InspectedNode, type PlannedAsset, type PlannedGraph,
} from './spec-plan.js';
import type { SpecEntry } from './spec-types.js';

export interface BuildOptions {
  resetGraphs?: boolean;
  dryRun?: boolean;
  targetRoot?: string;
  allowLivePaths?: boolean;
  sender?: Sender;
  now?: () => number;
}
export interface GraphReport { graph: string; nodes_created: number; nodes_expected: number; links_verified: number; links_expected: number; missing_links: string[]; ghost_events: string[] }
export interface AssetReport { asset: string; compiled: boolean; graphs: GraphReport[] }
export interface PlanSummary { assets: number; graphs: number; nodes: number; links: number; defaults: number; operations: string[] }
export interface BuildReport { ok: boolean; duration_ms: number; dry_run: boolean; assets: AssetReport[]; warnings: string[]; errors: string[]; planned?: PlanSummary }

const INSPECT_PAGE = 200;
const DEFAULTS_CHUNK = 100;

type Outcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; data?: Record<string, unknown>; transport: boolean };

/** One command's outcome, never thrown. A reply the plugin's broken-blueprint
 *  gate short-circuited (status bp_compile_required) is a failure. */
async function attempt(p: Promise<Record<string, unknown>>): Promise<Outcome> {
  try {
    const data = await p;
    if (data.status === 'bp_compile_required') {
      return { ok: false, error: `blocked: ${String(data.hint ?? 'the blueprint failed its last compile')}`, data, transport: false };
    }
    return { ok: true, data };
  } catch (err) {
    if (err instanceof UeToolError) {
      const payload = err.uePayload as { data?: Record<string, unknown> } | undefined;
      return { ok: false, error: err.message, data: payload?.data, transport: err.code === 'transport' || err.code === 'editor_busy' };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err), transport: true };
  }
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
/** Compare class paths spelled differently: drop _C and the .Name of /Game paths. */
const normClass = (p: string): string => {
  let s = p.replace(/_C$/, '');
  if (s.startsWith('/Game/') && s.includes('.')) s = s.slice(0, s.indexOf('.'));
  return s.toLowerCase();
};
const defaultText = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined;

/**
 * Read a whole graph through paged blueprint_inspect_graph. Refuses anything
 * that could undercount: a trimmed page, a plugin without paging, a server that
 * does not advance, totals that change between pages, or a final count that
 * does not match the totals.
 */
export async function readGraphComplete(path: string, graph: string, sender?: Sender): Promise<InspectedGraph> {
  const nodes: InspectedNode[] = [];
  const edges: InspectedEdge[] = [];
  const seen = new Set<string>();
  let totals: { nodes: number; edges: number } | undefined;
  let offset = 0;
  for (let page = 0; page < 100; page++) {
    const r = await executeCommand('blueprint_inspect_graph', { path, graph_name: graph, offset, limit: INSPECT_PAGE }, { sender });
    if (r._truncated !== undefined) {
      throw new Error(`blueprint_inspect_graph truncated a page of ${graph} (${JSON.stringify(r._truncated)}); refusing to judge an incomplete graph`);
    }
    if (typeof r.offset !== 'number' || typeof r.node_count !== 'number' || typeof r.edge_count !== 'number') {
      throw new Error(`blueprint_inspect_graph did not report paging for ${graph}; the plugin predates paged inspect — rebuild it`);
    }
    if (totals && (totals.nodes !== r.node_count || totals.edges !== r.edge_count)) {
      throw new Error(`graph ${graph} changed while it was being read (${totals.nodes}/${totals.edges} -> ${r.node_count}/${r.edge_count})`);
    }
    totals = { nodes: r.node_count, edges: r.edge_count };
    for (const n of asArray(r.nodes) as InspectedNode[]) {
      if (!seen.has(n.node_id)) { seen.add(n.node_id); nodes.push(n); }
    }
    edges.push(...(asArray(r.edges) as InspectedEdge[]));
    if (r.has_more !== true) break;
    const next = r.next_offset;
    if (typeof next !== 'number' || next <= offset) {
      throw new Error(`blueprint_inspect_graph did not advance past offset ${offset} for ${graph}; refusing an incomplete read`);
    }
    offset = next;
  }
  if (!totals || nodes.length !== totals.nodes || edges.length !== totals.edges) {
    throw new Error(`incomplete read of ${graph}: ${nodes.length}/${totals?.nodes ?? '?'} nodes, ${edges.length}/${totals?.edges ?? '?'} edges`);
  }
  return { nodes, edges, node_count: totals.nodes, edge_count: totals.edges };
}

interface AssetState {
  plan: PlannedAsset;
  report: AssetReport;
  duplicated: boolean;
  terminals: Map<string, { entry?: string; result?: string }>;
  ids: Map<string, Record<string, string>>;
  pendingDefaults: Record<string, unknown>;
  placedCustomEvents: boolean;
}

interface Ctx {
  report: BuildReport;
  opts: BuildOptions;
  sender?: Sender;
  fail: (s: AssetState, message: string) => void;
  warn: (s: AssetState, message: string) => void;
}

const emptyGraphReport = (g: PlannedGraph): GraphReport => ({
  graph: g.graph, nodes_created: 0, nodes_expected: Object.keys(g.nodeKinds).length,
  links_verified: 0, links_expected: g.specLinks.length, missing_links: [], ghost_events: [],
});

const assetComplete = (a: AssetReport): boolean =>
  a.compiled && a.graphs.every((g) => g.nodes_created === g.nodes_expected && g.links_verified === g.links_expected
    && g.missing_links.length === 0 && g.ghost_events.length === 0);

function summarizePlan(plan: BuildPlan): PlanSummary {
  const operations: string[] = [];
  for (const a of plan.assets) {
    if (a.create) operations.push(`create ${a.asset} (parent ${a.create.parent}) if missing`);
    if (a.duplicateFrom) operations.push(`copy ${a.duplicateFrom} -> ${a.asset} if missing`);
    operations.push(`skeleton ${a.asset}: ${a.variables.length} variable(s), ${a.components.length} component(s), ${a.functions.length} function(s)`);
    for (const g of a.graphs) {
      if (g.eventNodes.length) operations.push(`events ${a.asset} ${g.graph}: ${g.eventNodes.map((e) => e.key).join(', ')}`);
      operations.push(`apply_graph ${a.asset} ${g.graph}: ${g.applyNodes.length} node(s), ${g.applyLinks.length} link(s), ${g.applyDefaults.length} literal(s)`);
    }
    const props = a.components.reduce((n, c) => n + Object.keys(c.properties ?? {}).length, 0);
    if (props) operations.push(`component properties ${a.asset}: ${props}`);
    if (a.cdoDefaults) operations.push(`cdo_defaults ${a.asset}: ${Object.keys(a.cdoDefaults).join(', ')}`);
  }
  return { ...plan.totals, operations };
}

/** Build checked specs. Never throws for editor-side failures; read `ok` and `errors`. */
export async function buildFromSpecs(entries: SpecEntry[], opts: BuildOptions = {}): Promise<BuildReport> {
  const now = opts.now ?? Date.now;
  const started = now();
  const plan = planBuild(entries, { targetRoot: opts.targetRoot, allowLivePaths: opts.allowLivePaths });
  const report: BuildReport = {
    ok: false, duration_ms: 0, dry_run: opts.dryRun === true, warnings: [...plan.warnings], errors: [],
    assets: plan.assets.map((a) => ({ asset: a.asset, compiled: false, graphs: a.graphs.map(emptyGraphReport) })),
  };
  const done = (): BuildReport => {
    report.duration_ms = now() - started;
    report.ok = report.errors.length === 0 && (report.dry_run || report.assets.every(assetComplete));
    return report;
  };
  if (plan.errors.length > 0) { report.errors.push(...plan.errors); return done(); }
  if (opts.dryRun) { report.planned = summarizePlan(plan); return done(); }

  const ctx: Ctx = {
    report, opts, sender: opts.sender,
    fail: (s, m) => { report.errors.push(`${s.plan.asset}: ${m}`); },
    warn: (s, m) => { report.warnings.push(`${s.plan.asset}: ${m}`); },
  };

  const level = await attempt(executeCommand('level_get_info', {}, { sender: opts.sender }));
  if (!level.ok) { report.errors.push(`editor unreachable: ${level.error}. Nothing was changed.`); return done(); }
  if (level.data.is_pie_running === true) {
    report.errors.push('Play-In-Editor is running; the build never starts or stops PIE. Stop it and run the build again. Nothing was changed.');
    return done();
  }

  const states: AssetState[] = plan.assets.map((a, i) => ({
    plan: a, report: report.assets[i]!, duplicated: false, terminals: new Map(), ids: new Map(), pendingDefaults: {}, placedCustomEvents: false,
  }));
  if (!(await skeletonPass(states, ctx))) return done();
  if (!(await graphPass(states, ctx))) return done();
  if (!(await finishPass(states, ctx))) return done();
  await verifyPass(states, ctx);
  return done();
}

async function skeletonPass(states: AssetState[], ctx: Ctx): Promise<boolean> {
  const { sender, fail, warn } = ctx;
  const infos = new Map<AssetState, Record<string, unknown>>();
  for (const s of states) {
    const a = s.plan;
    let info = await attempt(executeCommand('blueprint_get_info', { path: a.asset }, { sender }));
    if (!info.ok) {
      if (a.create) {
        const r = await attempt(executeCommand('blueprint_create', { name: a.name, package_path: a.asset, parent_class_path: a.create.parent }, { sender }));
        if (!r.ok) { fail(s, `blueprint_create failed: ${r.error}`); return false; }
        if (r.data.saved !== true) warn(s, `created but not saved: ${String(r.data.save_error ?? 'saved=false')}`);
      } else if (a.duplicateFrom) {
        const r = await attempt(executeCommand('asset_duplicate', { source_path: a.duplicateFrom, destination_path: a.asset }, { sender }));
        if (!r.ok) { fail(s, `asset_duplicate from ${a.duplicateFrom} failed: ${r.error}`); return false; }
        s.duplicated = true;
      } else {
        fail(s, `does not exist and the spec has no "create": ${info.error}`);
        return false;
      }
      info = await attempt(executeCommand('blueprint_get_info', { path: a.asset }, { sender }));
      if (!info.ok) { fail(s, `created but cannot be read back: ${info.error}`); return false; }
    } else if (a.create && normClass(String(info.data.parent_class ?? '')) !== normClass(a.create.parent)) {
      warn(s, `exists with parent ${String(info.data.parent_class)}, spec says ${a.create.parent} (not reparented)`);
    }
    infos.set(s, info.data);
  }

  for (const s of states) {
    const a = s.plan;
    const info = infos.get(s)!;
    const haveVars = new Map((asArray(info.variables) as Array<{ name: string; type: string }>).map((v) => [v.name.toLowerCase(), v]));
    for (const v of a.variables) {
      const hasDefault = v.default !== undefined;
      const existing = haveVars.get(v.name.toLowerCase());
      if (existing) {
        const t = parseType(v.type);
        const wanted = 'error' in t ? undefined : CATEGORY_OF_KIND[t.kind];
        if (wanted && existing.type.toLowerCase() !== wanted) { fail(s, `variable ${v.name} exists as ${existing.type}, spec says ${v.type}`); continue; }
        if (hasDefault) s.pendingDefaults[v.name] = v.default; // update existing defaults (addendum gap a)
        continue;
      }
      const text = defaultText(v.default);
      const params: Record<string, unknown> = { path: a.asset, variable_name: v.name, variable_type: v.type };
      if (text !== undefined && text !== '') params.default_value = text;
      const r = await attempt(executeCommand('blueprint_add_variable', params, { sender }));
      if (!r.ok) {
        if (/already exists/.test(r.error)) {
          warn(s, `variable ${v.name} already exists (not listed by blueprint_get_info); its default is set from the spec`);
          if (hasDefault) s.pendingDefaults[v.name] = v.default;
        } else fail(s, `add variable ${v.name}: ${r.error}`);
        continue;
      }
      if (r.data.verified === true && (text !== undefined || !hasDefault)) continue;
      if (hasDefault) s.pendingDefaults[v.name] = v.default;
      else fail(s, `add variable ${v.name}: not verified (${JSON.stringify(r.data)})`);
    }

    const haveComps = new Set(asArray(info.components).map((c) => String((c as { name: unknown }).name).toLowerCase()));
    for (const c of a.components) {
      if (haveComps.has(c.name.toLowerCase())) continue;
      const r = await attempt(executeCommand('blueprint_add_component', { path: a.asset, component_class_path: c.class, component_name: c.name }, { sender }));
      if (!r.ok || r.data.verified !== true) fail(s, `add component ${c.name}: ${r.ok ? JSON.stringify(r.data) : r.error}`);
    }

    const haveFns = new Set(asArray(info.functions).map((f) => String(f).toLowerCase()));
    for (const f of a.functions) {
      if (!haveFns.has(f.name.toLowerCase())) {
        const r = await attempt(executeCommand('blueprint_add_function', {
          path: a.asset, function_name: f.name, inputs: f.inputs ?? [], outputs: f.outputs ?? [], pure: f.pure === true,
        }, { sender }));
        if (r.ok && r.data.verified === true) {
          s.terminals.set(f.name.toLowerCase(), { entry: str(r.data.entry_node_id), result: str(r.data.result_node_id) });
          continue;
        }
        if (r.ok || !/already exists/.test(r.error)) { fail(s, `add function ${f.name}: ${r.ok ? JSON.stringify(r.data) : r.error}`); continue; }
      }
      // Hayba cannot edit a signature, so an existing function must already match.
      let graph: InspectedGraph;
      try { graph = await readGraphComplete(a.asset, f.name, sender); }
      catch (err) { fail(s, `function ${f.name} exists but its graph cannot be read: ${(err as Error).message}`); continue; }
      const t = findTerminals(graph.nodes, f.name);
      for (const problem of signatureProblems(t, f)) fail(s, problem);
      s.terminals.set(f.name.toLowerCase(), { entry: t.entry?.node_id, result: t.result?.node_id });
    }
  }
  if (ctx.report.errors.length > 0) return false;

  for (const s of states) {
    const r = await attempt(executeCommand('blueprint_compile', { path: s.plan.asset, save: true }, { sender }));
    if (!r.ok || r.data.ok !== true) {
      // The plugin refuses every further edit (remove_node included) to a
      // blueprint whose last compile failed, so even reset_graphs cannot help.
      fail(s, `skeleton compile failed: ${r.ok ? asArray(r.data.errors).join(' | ') : r.error}`);
      return false;
    }
    const names = Object.keys(s.pendingDefaults);
    for (let i = 0; i < names.length; i += DEFAULTS_CHUNK) {
      const chunk = Object.fromEntries(names.slice(i, i + DEFAULTS_CHUNK).map((n) => [n, s.pendingDefaults[n]]));
      const d = await attempt(executeCommand('blueprint_set_defaults', { path: s.plan.asset, properties: chunk }, { sender }));
      if (!d.ok || d.data.verified !== true || Number(d.data.failed ?? 0) > 0) {
        fail(s, `variable defaults ${Object.keys(chunk).join(', ')}: ${d.ok ? `skipped=${JSON.stringify(d.data.skipped)} verification_failed=${JSON.stringify(d.data.verification_failed)}` : d.error}`);
      }
    }
  }
  return ctx.report.errors.length === 0;
}

async function clearGraph(path: string, graph: string, first: InspectedGraph, keep: Set<string>, sender?: Sender): Promise<string | undefined> {
  let current = first;
  for (let round = 0; round < 3; round++) {
    const doomed = current.nodes.filter((n) => !keep.has(n.node_id));
    if (doomed.length === 0) return undefined;
    for (const n of doomed) {
      await attempt(executeCommand('blueprint_remove_node', { path, graph_name: graph, node_id: n.node_id }, { sender }));
    }
    current = await readGraphComplete(path, graph, sender);
  }
  const left = current.nodes.filter((n) => !keep.has(n.node_id));
  return left.length === 0 ? undefined : `${left.length} node(s) could not be removed: ${left.slice(0, 5).map((n) => `"${n.title}"`).join(', ')}`;
}

async function graphPass(states: AssetState[], ctx: Ctx): Promise<boolean> {
  const { sender, fail, warn, opts } = ctx;
  for (const s of states) {
    for (const g of s.plan.graphs) {
      const ids: Record<string, string> = {};
      s.ids.set(g.graph, ids);
      try {
        const read = await readGraphComplete(s.plan.asset, g.graph, sender);
        const known = g.isEvent ? {} : s.terminals.get(g.graph.toLowerCase()) ?? {};
        const t = g.isEvent ? { entry: undefined, result: undefined, resultCount: 0 } : findTerminals(read.nodes, g.graph, known);
        if (!g.isEvent && t.resultCount > 1) warn(s, `graph ${g.graph} has ${t.resultCount} return nodes; using ${t.result?.node_id}`);
        const keep = new Set([t.entry?.node_id, t.result?.node_id].filter((x): x is string => Boolean(x)));
        if (opts.resetGraphs || s.duplicated) {
          const problem = await clearGraph(s.plan.asset, g.graph, read, keep, sender);
          if (problem) { fail(s, `graph ${g.graph}: ${problem}`); return false; }
        } else {
          const autoLink = (e: InspectedEdge) => e.from_node === t.entry?.node_id && e.to_node === t.result?.node_id && e.from_pin === 'then';
          const touched = new Set(read.edges.filter((e) => !autoLink(e)).flatMap((e) => [e.from_node, e.to_node]));
          const ghost = (n: InspectedNode) => /^Event /.test(n.title) && !touched.has(n.node_id);
          const extra = read.nodes.filter((n) => !keep.has(n.node_id) && !ghost(n));
          const edges = read.edges.filter((e) => !autoLink(e));
          if (extra.length > 0 || edges.length > 0) {
            fail(s, `graph ${g.graph} already has ${extra.length} node(s) and ${edges.length} link(s); run again with reset_graphs to rebuild it`);
            return false;
          }
        }
        for (const kind of ['entry', 'result'] as const) {
          const key = g.terminalKeys[kind];
          if (!key) continue;
          const node = t[kind];
          if (!node) { fail(s, `graph ${g.graph}: no function ${kind} node found for "${key}"`); return false; }
          ids[key] = node.node_id;
        }
      } catch (err) {
        fail(s, `graph ${g.graph}: ${(err as Error).message}`);
        return false;
      }
    }
  }

  // Events first: a custom event is only callable by name once compiled.
  for (const s of states) {
    for (const g of s.plan.graphs) {
      for (const ev of g.eventNodes) {
        const base = { path: s.plan.asset, graph_name: g.graph, x: ev.x, y: ev.y };
        const r = ev.kind === 'event'
          ? await attempt(executeCommand('blueprint_add_event', { ...base, event_name: ev.event }, { sender }))
          : ev.kind === 'custom_event'
            ? await attempt(executeCommand('blueprint_add_custom_event', { ...base, event_name: ev.event, inputs: ev.inputs ?? [] }, { sender }))
            : await attempt(executeCommand('blueprint_add_bound_event', { ...base, target: ev.target, event_name: ev.event }, { sender }));
        if (!r.ok || r.data.verified !== true || typeof r.data.node_id !== 'string') {
          fail(s, `graph ${g.graph}: node "${ev.key}" (${ev.kind}): ${r.ok ? JSON.stringify(r.data) : r.error}`);
          return false;
        }
        s.ids.get(g.graph)![ev.key] = r.data.node_id;
        if (ev.kind === 'custom_event') s.placedCustomEvents = true;
      }
    }
  }
  for (const s of states.filter((x) => x.placedCustomEvents)) {
    const r = await attempt(executeCommand('blueprint_compile', { path: s.plan.asset, save: false }, { sender }));
    if (!r.ok || r.data.ok !== true) {
      fail(s, `compile after placing events failed: ${r.ok ? asArray(r.data.errors).join(' | ') : r.error}`);
      return false;
    }
  }

  for (const s of states) {
    for (const g of s.plan.graphs) {
      if (g.applyNodes.length === 0 && g.applyLinks.length === 0 && g.applyDefaults.length === 0) continue;
      let payload;
      try { payload = applyGraphPayload(s.plan.asset, g, s.ids.get(g.graph)!); }
      catch (err) { fail(s, (err as Error).message); return false; }
      const r = await attempt(executeCommand('blueprint_apply_graph', payload as unknown as Record<string, unknown>, { sender }));
      if (!r.ok) {
        const detail = asArray(r.data?.errors).map(String);
        const state = r.transport
          ? 'the connection dropped, so whether it applied is unknown — do not retry blindly; run the build again with reset_graphs'
          : r.data?.rolled_back === true ? 'rolled back; the graph is as it was before the call' : 'rollback was not confirmed; inspect the graph';
        fail(s, `graph ${g.graph}: blueprint_apply_graph failed (${state}): ${detail.length > 0 ? detail.join(' | ') : r.error}`);
        return false;
      }
      Object.assign(s.ids.get(g.graph)!, r.data.node_ids as Record<string, string>);
      for (const m of asArray(r.data.default_mismatches)) {
        warn(s, `graph ${g.graph}: literal read back differently than written: ${JSON.stringify(m)}`);
      }
    }
  }
  return ctx.report.errors.length === 0;
}

async function finishPass(states: AssetState[], ctx: Ctx): Promise<boolean> {
  const { sender, fail } = ctx;
  for (const s of states) {
    for (const c of s.plan.components) {
      for (const [property, value] of Object.entries(c.properties ?? {})) {
        const r = await attempt(executeCommand('blueprint_set_component_property', { path: s.plan.asset, component_name: c.name, property, value }, { sender }));
        if (!r.ok || r.data.verified !== true) fail(s, `component ${c.name}.${property}: ${r.ok ? `applied=${JSON.stringify(r.data.applied)}` : r.error}`);
      }
    }
    if (s.plan.cdoDefaults) {
      const r = await attempt(executeCommand('blueprint_set_defaults', { path: s.plan.asset, properties: s.plan.cdoDefaults }, { sender }));
      if (!r.ok || r.data.verified !== true || Number(r.data.failed ?? 0) > 0) {
        fail(s, `cdo_defaults: ${r.ok ? `skipped=${JSON.stringify(r.data.skipped)} verification_failed=${JSON.stringify(r.data.verification_failed)}` : r.error}`);
      }
    }
  }
  if (ctx.report.errors.length > 0) return false;
  for (const s of states) {
    const r = await attempt(executeCommand('blueprint_compile', { path: s.plan.asset, save: true }, { sender }));
    if (!r.ok || r.data.ok !== true) {
      fail(s, `compile failed: ${r.ok ? asArray(r.data.errors).join(' | ') : r.error}`);
      return false; // nothing further is compiled or saved
    }
    if (r.data.saved !== true) fail(s, `compiled but not saved: ${String(r.data.save_error ?? 'saved=false')}`);
    s.report.compiled = r.data.saved === true;
  }
  return ctx.report.errors.length === 0;
}

async function verifyPass(states: AssetState[], ctx: Ctx): Promise<void> {
  for (const s of states) {
    for (let gi = 0; gi < s.plan.graphs.length; gi++) {
      const g = s.plan.graphs[gi]!;
      const gr = s.report.graphs[gi]!;
      const ids = s.ids.get(g.graph) ?? {};
      let read: InspectedGraph;
      try { read = await readGraphComplete(s.plan.asset, g.graph, ctx.sender); }
      catch (err) { gr.missing_links = g.specLinks.map((l) => `${l.text} (graph unreadable: ${(err as Error).message})`); continue; }
      const byId = new Map(read.nodes.map((n) => [n.node_id, n]));
      gr.nodes_created = Object.keys(g.nodeKinds).filter((k) => ids[k] !== undefined && byId.has(ids[k]!)).length;
      const edges = new Set(read.edges.map((e) => `${e.from_node}|${e.from_pin}|${e.to_node}|${e.to_pin}`));
      gr.links_verified = 0;
      for (const l of g.specLinks) {
        const from = byId.get(ids[l.from.node] ?? '');
        const to = byId.get(ids[l.to.node] ?? '');
        if (!from || !to) { gr.missing_links.push(`${l.text} (node ${!from ? l.from.node : l.to.node} is not in the graph)`); continue; }
        const fp = resolvePin(from.pins, l.from.pin, 'output', { cast: l.fromKind === 'cast' });
        const tp = resolvePin(to.pins, l.to.pin, 'input', { cast: l.toKind === 'cast' });
        if ('error' in fp || 'error' in tp) {
          gr.missing_links.push(`${l.text} (${['error' in fp ? fp.error : '', 'error' in tp ? tp.error : ''].filter(Boolean).join('; ')})`);
          continue;
        }
        if (edges.has(`${from.node_id}|${fp.name}|${to.node_id}|${tp.name}`)) gr.links_verified++;
        else gr.missing_links.push(l.text);
      }
      for (const key of g.linkedEventKeys) {
        const n = byId.get(ids[key] ?? '');
        if (!n || n.enabled !== true) gr.ghost_events.push(`${key} (${n ? 'disabled' : 'missing'})`);
      }
    }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/blueprint/spec-builder/spec-build.test.ts`
Expected: PASS (21 tests).

- [ ] **Step 6: Run the TS gate**

Run: `cd mcp-tools/hayba-mcp && npx tsc --noEmit && npx vitest run`
Expected: only the known pre-existing failure. `wire-command-names.test.ts` now also covers every `executeCommand('…'` in `spec-build.ts`; all of them exist in C++ or in the sidecar.

- [ ] **Step 7: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/testing/fake-blueprint-editor.ts mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-build.ts mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-build.test.ts
git commit -m "feat(blueprint): four-pass spec build over apply_graph with paged verification"
```

---

### Task 10: The two tools, search-quality cases, changelog

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-builder-tools.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-builder-tools.test.ts`
- Modify: `mcp-tools/hayba-mcp/src/tools/index.ts` (imports, and both lists inside `STANDARD_DESCRIPTORS`, ~:3712-3730)
- Modify: `mcp-tools/hayba-mcp/src/tools/routing/search-quality.test.ts` (`CASES`)
- Modify: `mcp-tools/hayba-mcp/CHANGELOG.md` (under `## Unreleased`)

**Interfaces:**
- Consumes:
  - From Task 9: `buildFromSpecs`, `BuildReport`.
  - From Task 2: `check`, `checkAcross`, `byRefLiteralWarnings`, `countSpec`.
  - From Task 1: `parseSpecText`.
- Produces:
  - `loadSpecs(input: {specs?: unknown[]; spec_paths?: string[]}): {entries: SpecEntry[]; errors: string[]; warnings: string[]}`
  - `specCheckHandler(args)` and `buildFromSpecHandler(args)`
  - `BLUEPRINT_SPEC_DESCRIPTORS: ToolDescriptor[]`, which adds the tools `blueprint_spec_check` and `blueprint_build_from_spec`.

- [ ] **Step 1: Write the failing tests**

```ts
// mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-builder-tools.test.ts
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLUEPRINT_SPEC_DESCRIPTORS, buildFromSpecHandler, loadSpecs, specCheckHandler } from './spec-builder-tools.js';
import { sample } from './__fixtures__/sample-spec.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'synthetic');
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

describe('loadSpecs', () => {
  it('reads spec files and inline specs, and names what cannot be read', () => {
    const r = loadSpecs({ spec_paths: [join(FIXTURES, 'GM_LanternPuzzle.json'), join(FIXTURES, 'nope.json')], specs: [sample()] });
    expect(r.entries.map((e) => e.spec.asset)).toEqual(['/Game/LanternPuzzle/Core/GM_LanternPuzzle', '/Game/LanternPuzzle/Core/BPC_Sample']);
    expect(r.errors).toEqual([expect.stringMatching(/nope\.json: cannot read \(ENOENT\)/)]);
  });

  it('asks for a spec when given none', () => {
    expect(loadSpecs({}).errors).toEqual(['pass at least one spec in "specs" or "spec_paths"']);
  });
});

describe('blueprint_spec_check', () => {
  it('reports ok with per-spec counts', async () => {
    const out = body(await specCheckHandler({ spec_paths: [join(FIXTURES, 'BFL_BeamMath.json')] }));
    expect(out).toEqual({ ok: true, errors: [], warnings: [], per_spec: [{ asset: '/Game/LanternPuzzle/Core/BFL_BeamMath', nodes: 33, links: 47 }] });
  });

  it('reports every problem with where it came from', async () => {
    const bad = { ...sample(), variabels: [] };
    const out = body(await specCheckHandler({ specs: [bad] }));
    expect(out.ok).toBe(false);
    expect(out.errors).toContain('specs[0]: unknown top-level key "variabels"');
  });
});

describe('blueprint_build_from_spec', () => {
  it('dry-runs fixture specs under target_root with no editor', async () => {
    const r = await buildFromSpecHandler({ spec_paths: [join(FIXTURES, 'GM_LanternPuzzle.json'), join(FIXTURES, 'PC_Lantern.json')], dry_run: true, target_root: '/Game/HaybaMCPAutomation/SpecBuild' });
    const out = body(r);
    expect(r.isError).toBe(false);
    expect(out.ok).toBe(true);
    expect(out.planned).toMatchObject({ assets: 2, nodes: 71, links: 76 });
  });

  it('refuses the live folder without target_root, as an error result', async () => {
    const r = await buildFromSpecHandler({ specs: [{ ...sample(), asset: '/Game/Live/Flow/BPC_Sample' }], dry_run: true });
    expect(r.isError).toBe(true);
    expect(String((body(r).errors as string[])[0])).toMatch(/is under \/Game\/Live\/Flow/);
  });

  it('publishes both tools with their guidance', () => {
    expect(BLUEPRINT_SPEC_DESCRIPTORS.map((d) => d.name)).toEqual(['blueprint_spec_check', 'blueprint_build_from_spec']);
    for (const d of BLUEPRINT_SPEC_DESCRIPTORS) {
      expect(d.meta.when.length).toBeGreaterThan(30);
      expect(d.meta.not_when.length).toBeGreaterThan(30);
    }
  });
});
```

Append to `CASES` in `search-quality.test.ts`:

```ts
  // Whole-Blueprint authoring from a JSON spec, and its offline check.
  { query: 'build a blueprint from a json spec', expect: ['blueprint_build_from_spec'] },
  { query: 'validate a blueprint graph spec file without the editor', expect: ['blueprint_spec_check'] },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/blueprint/spec-builder/spec-builder-tools.test.ts src/tools/routing/search-quality.test.ts`
Expected: FAIL. `spec-builder-tools.js` does not exist yet, and search-quality reports "benchmark expects tools absent from the corpus".

- [ ] **Step 3: Write `spec-builder-tools.ts`**

```ts
// The two tools over the spec builder: an offline check and the build.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { ToolDescriptor } from '../../register-tool.js';
import type { HaybaToolMeta } from '../../hayba-tool-meta.js';
import type { ToolResult } from '../../types.js';
import { errorResult, okResult } from '../../tool-result.js';
import { parseSpecText } from './spec-parse.js';
import { byRefLiteralWarnings, check, checkAcross, countSpec } from './spec-check.js';
import { buildFromSpecs } from './spec-build.js';
import type { BlueprintSpec, SpecEntry } from './spec-types.js';

export interface LoadedSpecs { entries: SpecEntry[]; errors: string[]; warnings: string[] }

/** Read and check specs from files and inline objects. Every problem is
 *  prefixed with where the spec came from. */
export function loadSpecs(input: { specs?: unknown[]; spec_paths?: string[] }): LoadedSpecs {
  const entries: SpecEntry[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const accept = (file: string, value: unknown, problems: string[]): void => {
    if (problems.length > 0) { errors.push(...problems.map((p) => `${file}: ${p}`)); return; }
    const spec = value as BlueprintSpec;
    entries.push({ file, spec });
    warnings.push(...byRefLiteralWarnings(spec).map((w) => `${file}: ${w}`));
  };
  for (const file of input.spec_paths ?? []) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      errors.push(`${file}: cannot read (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
      continue;
    }
    const problems = check(text);
    accept(file, problems.length === 0 ? parseSpecText(text).value : undefined, problems);
  }
  (input.specs ?? []).forEach((spec, i) => accept(`specs[${i}]`, spec, check(spec)));
  if (entries.length === 0 && errors.length === 0) errors.push('pass at least one spec in "specs" or "spec_paths"');
  errors.push(...checkAcross(entries));
  return { entries, errors, warnings };
}

const specInputShape = {
  specs: z.array(z.record(z.string(), z.unknown())).optional()
    .describe('Blueprint specs as JSON objects: {asset, create?, variables?, components?, functions?, graphs?, cdo_defaults?}'),
  spec_paths: z.array(z.string().min(1)).optional()
    .describe('Paths of spec .json files; // and /* */ comments are allowed and duplicate keys are reported'),
};
export const specCheckSchema = z.object(specInputShape);
export const buildSchema = z.object({
  ...specInputShape,
  reset_graphs: z.boolean().optional().default(false)
    .describe('Clear each graph the specs describe before building it (a function keeps its entry/result nodes). Needed to rebuild a graph that already has nodes.'),
  dry_run: z.boolean().optional().default(false)
    .describe('Check and plan only: returns the planned operations and counts and sends nothing to the editor'),
  target_root: z.string().optional()
    .describe('Build copies under this /Game folder instead of the specs\' own paths; references between the specs are rewritten to the copies, and specs without "create" are copied from their source first'),
  allow_live_paths: z.boolean().optional().default(false)
    .describe('Allow building into protected live folders (/Game/Live/Flow). Off by default.'),
});

export async function specCheckHandler(args: Record<string, unknown>): Promise<ToolResult> {
  const parsed = specCheckSchema.safeParse(args);
  if (!parsed.success) return errorResult(`Validation error: ${parsed.error.message}`);
  const loaded = loadSpecs(parsed.data);
  return okResult({
    ok: loaded.errors.length === 0,
    errors: loaded.errors,
    warnings: loaded.warnings,
    per_spec: loaded.entries.map((e) => ({ asset: e.spec.asset, ...countSpec(e.spec) })),
  });
}

export async function buildFromSpecHandler(args: Record<string, unknown>): Promise<ToolResult> {
  const parsed = buildSchema.safeParse(args);
  if (!parsed.success) return errorResult(`Validation error: ${parsed.error.message}`);
  const { reset_graphs, dry_run, target_root, allow_live_paths, ...input } = parsed.data;
  const loaded = loadSpecs(input);
  if (loaded.errors.length > 0) {
    const refused = { ok: false, duration_ms: 0, dry_run, assets: [], warnings: loaded.warnings, errors: loaded.errors };
    return { content: [{ type: 'text', text: JSON.stringify(refused, null, 2) }], isError: true };
  }
  const report = await buildFromSpecs(loaded.entries, { resetGraphs: reset_graphs, dryRun: dry_run, targetRoot: target_root, allowLivePaths: allow_live_paths });
  report.warnings.unshift(...loaded.warnings);
  return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }], isError: !report.ok };
}

const specCheckMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  pack: 'blueprint',
  when: 'checking Blueprint JSON specs (variables, functions, graph nodes, links, pin literals) before building them — offline, no editor needed',
  not_when: 'you want the Blueprint built (use blueprint_build_from_spec) or want to read a live graph (use blueprint_inspect_graph)',
};
const buildMeta: HaybaToolMeta = {
  cost: 'high',
  effects: ['modifies_asset', 'creates_asset'],
  pack: 'blueprint',
  when: 'building or rebuilding whole Blueprints — variables, components, functions, event graphs, class defaults — from JSON specs in one verified run',
  not_when: 'adding a single node or link (use blueprint_add_node / blueprint_connect_nodes) or only validating a spec (use blueprint_spec_check)',
};

export const BLUEPRINT_SPEC_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: 'blueprint_spec_check',
    description:
      'Validate Blueprint JSON specs offline, with no editor running. Checks the spec format (node kinds entry/result/event/custom_event/bound_event/call/get/set/branch/sequence/select/self/cast/create_widget/timer, "node.Pin" links, pin literals, variable and parameter types, class paths, duplicate names and duplicate JSON keys) and warns about literals on by-reference inputs.',
    meta: specCheckMeta,
    handler: specCheckHandler,
    cost: 'low',
    returns: '{ok, errors[], warnings[], per_spec:[{asset, nodes, links}]}',
    schema: specCheckSchema.shape,
  },
  {
    name: 'blueprint_build_from_spec',
    description:
      'Build whole Blueprints from JSON specs in one call: creates or copies each asset, adds variables, components and functions, places every graph with one all-or-nothing blueprint_apply_graph per graph, sets component properties and class defaults, compiles and saves, then reads every graph back and confirms each spec link is a real edge and each wired event is enabled. Specs can reference each other. A graph that already holds nodes is refused unless reset_graphs is set; dry_run plans without touching the editor; target_root builds copies elsewhere.',
    meta: buildMeta,
    handler: buildFromSpecHandler,
    cost: 'high',
    returns: '{ok, duration_ms, dry_run, assets:[{asset, compiled, graphs:[{graph, nodes_created, nodes_expected, links_verified, links_expected, missing_links[], ghost_events[]}]}], warnings[], errors[], planned?:{assets, graphs, nodes, links, defaults, operations[]}}',
    schema: buildSchema.shape,
  },
];
```

- [ ] **Step 4: Register the tools in `index.ts`**

Add the import next to the `AUDIO_DESCRIPTORS` import:

```ts
import { BLUEPRINT_SPEC_DESCRIPTORS } from './blueprint/spec-builder/spec-builder-tools.js';
```

In `STANDARD_DESCRIPTORS`, add `...BLUEPRINT_SPEC_DESCRIPTORS,` after `...AUDIO_DESCRIPTORS,` in **both** places: the outer list, and the array passed to `generateLegacyDescriptors(new Set([...]))`.

- [ ] **Step 5: Add the changelog entry**

Under `## Unreleased` in `mcp-tools/hayba-mcp/CHANGELOG.md`, add:

```markdown
### Blueprint bulk builder (since 2026-09-27)

- New `blueprint_spec_check` (offline) and `blueprint_build_from_spec` tools. The build places whole Blueprints from JSON specs: skeleton, then graphs, then class defaults, then a verify pass that re-reads every graph. It supports `reset_graphs`, `dry_run` and `target_root`, and refuses live paths by default.
- New C++ `blueprint_apply_graph`: one graph's nodes, pin literals and links in one call. Everything is checked before any link is made, and a failure removes every node the call placed and restores the pins it touched. It is registered as non-idempotent, heavy and plan-gated.
- `blueprint_inspect_graph` pages with `offset`/`limit`/`next_offset`, reports `enabled` per node and `default` per pin, and is never trimmed at 50 items. The same override applies to `blueprint_get_info`.
- New `blueprint_set_component_property` for SCS component template properties.
- `blueprint_set_pin_default` verifies text pins against the text literal, fixing a false `verified:false`.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/blueprint/spec-builder src/tools/routing/search-quality.test.ts src/tools/code-mode/list-tool-categories.test.ts src/tools/legacy-tool-factory.test.ts src/tools/schema-single-source.test.ts`
Expected: PASS. If a search-quality case ranks below 3, improve the tool description; do not weaken the case. The benchmark measures descriptions.

- [ ] **Step 7: Run the TS gate**

Run: `cd mcp-tools/hayba-mcp && npx tsc --noEmit && npx vitest run`
Expected: only the known pre-existing failure.

- [ ] **Step 8: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-builder-tools.ts mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-builder-tools.test.ts mcp-tools/hayba-mcp/src/tools/index.ts mcp-tools/hayba-mcp/src/tools/routing/search-quality.test.ts mcp-tools/hayba-mcp/CHANGELOG.md
git commit -m "feat(blueprint): blueprint_spec_check and blueprint_build_from_spec tools"
```

---

### Task 11: Acceptance in the first consumer project's editor (coordination-gated)

These steps touch another team's editor and plugin copy. **Every step marked (USER) waits for the user's go-ahead.** Do not skip or reorder them.

**Files:** none committed. Scratch lives in `<scratch>`.

**Interfaces:**
- Consumes: the built `dist/` of this worktree (Tasks 1–10) and the plugin `Source/` (Tasks 4–7).
- Produces: an acceptance record, which is the report JSON of both runs plus the C++ test results.

- [ ] **Step 1 (USER): Coordinate the deploy window**

Ask the user to tell the consumer project's session that Hayba will:
1. replace `<project>/Plugins/HaybaMCPToolkit/Source`;
2. run a full UBT rebuild with the editor closed;
3. build copies of the 9 specs under `/Game/HaybaMCPAutomation/SpecBuild`, holding the editor gate for less than 20 minutes.

Wait for the agreed window, and for confirmation that the consumer project's editor is closed.

- [ ] **Step 2: Build the TS side**

Run: `cd mcp-tools/hayba-mcp && npm run build:server`
Expected: no tsc errors, and `dist/tools/blueprint/spec-builder/spec-builder-tools.js` exists. Use `build:server`, not `build`.

- [ ] **Step 3: Back up and deploy the C++ into the consumer project's plugin copy (editor closed)**

```powershell
$scratch = "<scratch>"
robocopy "<project>\Plugins\HaybaMCPToolkit" "$scratch\plugin-backup" /E /NFL /NDL
robocopy "<worktree>\unreal\HaybaMCPToolkit\Source" "<project>\Plugins\HaybaMCPToolkit\Source" /MIR /NFL /NDL
```

Expected: robocopy exit code below 8. The backup is how you restore the consumer project's copy if the build fails.

- [ ] **Step 4: Full UBT rebuild**

```powershell
& "C:\Program Files\Epic Games\UE_5.8\Engine\Build\BatchFiles\Build.bat" UnrealEditor Win64 Development -Project="<project>\<Project>.uproject" -WaitMutex
```

Expected: `Result: Succeeded`.

"Unable to build while Live Coding is active" means a stray `LiveCodingConsole` or `CrashReportClientEditor` process is still running. Ask before killing anything.

If the build fails, restore the backup: `robocopy "$scratch\plugin-backup" "<project>\Plugins\HaybaMCPToolkit" /MIR`. Then tell the user and stop.

- [ ] **Step 5 (USER): Editor start, then the gate**

Ask the user (or the consumer project's session) to start the consumer project's editor. Then run:

```bash
python <project>/Tools/GameFlow/wait_for_editor.py
python <project>/Tools/GameFlow/editor_gate.py acquire --owner hayba-specbuild --timeout-min 60 --ttl-min 20
```

Expected: the gate is acquired and PIE is not running. Hold the gate for less than 20 minutes from here to Step 9.

- [ ] **Step 6: Prove the new C++ tests exist and ran**

Create `$scratch/ue.mjs`:

```js
// Usage: node ue.mjs <command> '<json params>'   (from mcp-tools/hayba-mcp)
import { installLiveSender, executeCommand } from './dist/tools/tool-executor.js';
await installLiveSender();
const [cmd, params = '{}'] = process.argv.slice(2);
console.log(JSON.stringify(await executeCommand(cmd, JSON.parse(params), { timeout: 600000 }), null, 2));
process.exit(0);
```

Copy it into `mcp-tools/hayba-mcp/` for the run, and delete it afterwards. Then run:

```bash
cd mcp-tools/hayba-mcp
UE_TCP_PORT=52342 node ue.mjs test_list '{"filter_pattern":"Hayba"}' > "$SCRATCH/test_list.json"
for t in Hayba.MCP.BlueprintOps.ApplyGraphPayload Hayba.MCP.BlueprintOps.ResolvePinName Hayba.MCP.BlueprintOps.PageWindow Hayba.MCP.BlueprintOps.PinLiteral Hayba.MCP.Blueprint.InspectGraph.PagesEveryNodeAndEdge Hayba.MCP.Blueprint.SetPinDefault.TextPinVerifies Hayba.MCP.Blueprint.SetComponentProperty.SetsAndVerifiesTemplate Hayba.MCP.Blueprint.ApplyGraph.AppliesAndVerifies Hayba.MCP.Blueprint.ApplyGraph.RejectsBeforeLinking Hayba.MCP.Blueprint.ApplyGraph.RollsBackMidApply; do grep -q "$t" "$SCRATCH/test_list.json" && echo "listed $t" || echo "MISSING $t"; done
UE_TCP_PORT=52342 node ue.mjs test_run '{"test_names":["Hayba.MCP.BlueprintOps.ApplyGraphPayload","Hayba.MCP.BlueprintOps.ResolvePinName","Hayba.MCP.BlueprintOps.PageWindow","Hayba.MCP.BlueprintOps.PinLiteral","Hayba.MCP.Blueprint.InspectGraph.PagesEveryNodeAndEdge","Hayba.MCP.Blueprint.SetPinDefault.TextPinVerifies","Hayba.MCP.Blueprint.SetComponentProperty.SetsAndVerifiesTemplate","Hayba.MCP.Blueprint.ApplyGraph.AppliesAndVerifies","Hayba.MCP.Blueprint.ApplyGraph.RejectsBeforeLinking","Hayba.MCP.Blueprint.ApplyGraph.RollsBackMidApply"]}'
```

`$SCRATCH` is the scratchpad path above. `test_run` is async: poll `node ue.mjs build_status '{"job_id":"<id>"}'` until the job completes.

Expected:
- 10 `listed` lines and no `MISSING`. A missing name means UBT built a binary without that `.cpp`; rebuild before going on.
- All 10 tests pass, with **none reported skipped**. Treat a `skipped` as a failure.

- [ ] **Step 7: First build of the 9 specs as copies**

Create `$scratch/specbuild.mjs`:

```js
// Usage: node specbuild.mjs [reset]   (from mcp-tools/hayba-mcp)
import { installLiveSender } from './dist/tools/tool-executor.js';
import { BLUEPRINT_SPEC_DESCRIPTORS } from './dist/tools/blueprint/spec-builder/spec-builder-tools.js';
await installLiveSender();
const dir = '<project>/Tools/GameFlow/specs/';
// The 9 spec files of that folder, in build order: function libraries, components,
// the player controller, plain actors, the game mode, then the widgets.
const files = process.env.SPEC_FILES.split(',');
const tool = BLUEPRINT_SPEC_DESCRIPTORS.find((d) => d.name === 'blueprint_build_from_spec');
const r = await tool.handler({ spec_paths: files.map((f) => dir + f), target_root: '/Game/HaybaMCPAutomation/SpecBuild', reset_graphs: process.argv[2] === 'reset' }, {});
console.log(r.content[0].text);
process.exit(r.isError ? 1 : 0);
```

Copy it into `mcp-tools/hayba-mcp/` and run:

```bash
touch "$SCRATCH/before-build.stamp"
export SPEC_FILES="<the 9 file names, comma-separated, in build order>"
UE_TCP_PORT=52342 node specbuild.mjs > "$SCRATCH/specbuild-run1.json"; echo "exit $?"
```

Pass criteria. All must hold:
- `exit 0` and `"ok": true`.
- In every asset, `compiled` is true.
- In every graph, `nodes_created == nodes_expected`, `links_verified == links_expected`, `missing_links: []` and `ghost_events: []`. This includes the largest graph of the 9 specs (about 70 nodes and 80 links) and every graph with more than 50 edges.
- Summed over the report: the node and link totals that the corpus test prints for the same 9 files (`HAYBA_BLUEPRINT_SPEC_CORPUS`, run with `--reporter=verbose`; see `__fixtures__/synthetic/README.md`). The golden totals of Task 3 are those of the synthetic fixtures, not of this run.
- Record `duration_ms` next to bpgraph's 158 s for two specs.

If the run fails, keep the report, fix forward in the owning task, and re-run with `reset`. If it fails with `plan_gate`, Plan Mode is on in that editor: ask the user to approve or disable it. Do not bypass it.

- [ ] **Step 8: Prove nothing live was written**

```bash
find "<project>/Content/Live/Flow" -newer "$SCRATCH/before-build.stamp" -type f
ls "<project>/Content/HaybaMCPAutomation/SpecBuild" "<project>/Content/HaybaMCPAutomation/SpecBuild/UI"
```

Expected: the `find` prints nothing, and the listing shows the 9 SpecBuild `.uasset` files (6 at the root, 3 under `UI/`).

- [ ] **Step 9: Second run with reset_graphs, then release the gate**

```bash
UE_TCP_PORT=52342 node specbuild.mjs reset > "$SCRATCH/specbuild-run2.json"; echo "exit $?"
python <project>/Tools/GameFlow/editor_gate.py release --owner hayba-specbuild
```

Expected:
- `exit 0`, `"ok": true`, and the same counts as run 1. This proves the rebuild is idempotent.
- Re-run the Step 8 `find`; it prints nothing.
- The gate is released **even if the run failed**. Release it before investigating anything.

Delete `ue.mjs` and `specbuild.mjs` from `mcp-tools/hayba-mcp/`; they are not committed.

- [ ] **Step 10 (USER): Report and hand back**

Give the user:
- both run reports;
- the 10 C++ test results;
- the timing against 158 s;
- the Step 8 evidence.

Tell the consumer project's session the editor and gate are free. Ask whether to also copy `dist/` to wherever their Hayba MCP server runs from; that needs an MCP server restart only the user can do. Push nothing without asking.

---

## Spec coverage map

| Spec item | Task |
|---|---|
| §3 format ported, `components[].properties` | 1, 2 |
| §4.1 spec-parse / spec-check / spec-plan / spec-build / tools | 1, 2, 3, 9, 10 |
| §4.1 by-ref literal warning | 2 |
| §4.2 apply_graph validate→apply→rollback, gates, NON_IDEMPOTENT, heavy | 4, 7, 8 |
| §4.2 inspect paging, enabled, pin defaults, builder override | 4, 5 |
| §4.2 set_component_property | 6 |
| §4.2 text-pin compare | 4, 5 |
| §4.3 GetCommands/dispatch/gates, sidecar, EXTRA_DESTRUCTIVE, list-tool-categories, search cases | 5–8, 10 |
| §5.1 four passes, existing-variable defaults, signature abort, events-first compile, reset in rounds | 9 |
| §5.2 dry run | 9, 10 |
| §5.3 report and `ok` | 9 |
| §5.4 save only built packages, live-path refusal | 3, 9, 11 |
| §6 error table (unreachable/PIE, rollback-stop, compile stop, TCP drop, signature) | 9 |
| §7 TS ports, patch/gap regressions, golden counts, e2e, contract tests; UE tests and count check; acceptance | 1–11 |
| §8 constraints | Global Constraints, 11 |
