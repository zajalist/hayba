# Critique — why Hayba does not feel finished

Every claim below is grounded in a file and line. Findings I could not verify
were dropped; three were dropped *after* investigation and are recorded at the
bottom so nobody re-derives them.

## A. The three systems that have no clear use case

### A1. PLUMB and the validator are the same idea, shipped twice, in two languages

`src/plumb/contracts.ts:5-8` states the intent plainly:

> "Mirrors D:/Hackathons/plumb/contracts.py … so the hayba validator can speak
> PLUMB's quantified, *directional* language: every check yields a signed
> value_m plus a FixVector telling the agent which way to move, **instead of the
> boolean severity findings the legacy validator emits**."

**The replacement was designed and never executed.** Both still ship:

| | PLUMB | Legacy validator |
|---|---|---|
| Asks | "is this object placed correctly?" | "did that tool call go wrong?" |
| Verdict | `GateResult`/`ConstraintResult` — signed `value_m` + `FixVector` | `ValidatorFinding` — severity + message + hint |
| Surface | `Slate/SHaybaValidatorPanel.cpp` | `HaybaMCPValidationPanel.cpp` (**47 lines**) |
| Config | constraint store | `validator/config.ts` (rules + strictness) |

Two panels, two verdict types, two stores, one job. Users cannot articulate
this, but they feel it as incoherence — because it *is* incoherence.

PLUMB itself is good: 13 closed primitives (`grounded`, `clearance`,
`support_margin`, `upright`, `scale_range`, `count_per_m2`, `proximity`,
`inside_outside`, `facing`, `affordance_clear`, `surface_contact`, `presence`,
`max_straight_run`), 9 `plumb_*` tools, a directional fix vector. It does not
feel bad because it is bad. **It feels bad because nothing consumes it.**

### A2. A quarter of the validator is decorative by design

11 rules. 6 wired at runtime via `attachEvaluator` inside `installToolHooks()`
(`validator/tool-hooks.ts`). 1 more (`dangling_lifetime_callback_in_python_run`)
enforced through a *different* path in `tools/python-run-validator-wrap.ts`.

That leaves **4 rules that never fire**: `pcg_surface_source_not_landscape`,
`unreal_landscape_placeholder`, `actor_position_drift_after_user_edit`,
`actor_spawn_class_not_found`.

`validator/rules.ts:56` says this is intentional:

> "present in the catalog so users see it in the Configure panel, but never
> auto-evaluated."

And `validator/__tests__/rules.test.ts:33-48` **pins that dead state as
correct.** A UI that lists checks it will never run is a UI that lies politely.
Users smell it before they can name it.

### A3. Slivers is a framework awaiting a product

- **2 specs.** `com.hayba.composition.frame_target`, `com.hayba.scatter.pcg_biome`.
- One of the two is **unproven**. `docs/RUNBOOK-reel-filming.md:51` documents a
  `TODO(live-validate)` on `pcg_biome`'s central write: whether `ImportText`
  imports the inline sub-object onto the instanced `MeshSelectorParameters` "is
  unproven", with `pcg_set_prop` as the untested fallback.
- Supporting it: **1,336 lines** of TS, **4 MCP tools**, and **10 Slate widgets**
  (`SSliverParam{Bool,Enum,Float,Int,String,Vector3,ActorRef}` + base + detail +
  panel).

A 10:2 infrastructure-to-payload ratio. And "sliver" is an invented word with no
referent in the user's world — nobody arrives at the editor wanting a sliver.

### A4. None of the three has a triggering moment

All three are pull-surfaces. Nothing in the workflow ever says *now open
Slivers* or *now run `plumb_validate`*. A feature the user must remember to go
find will always feel optional, and optional reads as unfinished.

**This, not the visuals, is the root cause.** The fix is not a better Rules tab.
The fix is that Rules stops being a tab you visit and becomes a verdict that
appears next to the edit that triggered it.

## B. The information architecture is named after the implementation

11 sidebar tabs. Sorted by what a user actually wants:

| The user's question | Tabs they must choose between |
|---|---|
| "what is the agent doing / did it?" | **Plan** + **Diff** + **Tool Stream** |
| "what must be true, and why?" | **Validation** + **Lessons** + PLUMB's Slate panel |
| "what can I use?" | **Library** + **Slivers** |
| "what is my world?" | **Scene Map** |
| "configure" | **MCP** + **Settings** |
| "ask" | **Chat** |

Six questions, eleven rooms. That is the whole UX problem in one table.

## C. The domain model has provably drifted — four naming systems

`HaybaMCPMainPanel.cpp:64-65`:

```cpp
case EHaybaPanel::Memory:   return TEXT("Hayba.Icon.Library"); // Library — custom icon
case EHaybaPanel::Lessons:  return TEXT("Hayba.Icon.Memory");
```

The enum says `Memory`. The tab label says "Library". It draws the *Library*
icon. And `Lessons` borrows the *Memory* icon. Three names for two concepts,
plus a code comment apologising for it.

Then `HaybaMCPOnboardingWidget.cpp:122` tells new users:

> "Window → Hayba opens any of the **7 panels**: Chat, Tool Stream, Scene Map,
> **Wireframe/Plan**, Diff, **Validation Report**, **Memory Inspector**."

Wrong count (11, not 7) and three more names that exist nowhere else. That is a
**fourth** naming system: enum / tab label / icon key / onboarding copy.

The same wizard's final step ships the words **"Coming soon."**
(`OnboardingWidget.cpp:128`, sample scene).

## D. Duplicate implementations

- **Two Scene Maps.** `HaybaMCPSceneMapPanel.cpp` (223 lines, native `SCanvas`)
  and `HaybaMCPSceneMapWebPanel.cpp` (126 lines, `SWebBrowser` + injected JS
  against `Resources/cognitive-map/index.html`). Two renderers, one feature.
- **Two validation panels.** See A1.

## E. The visual system

- **No shared grid.** Icon viewBoxes range `822` → `1331`, with ad-hoc offsets
  (`viewBox="0 -106.5 1331 1331"`). Nothing sits on a common keyline.
- **No shared weight.** All solid fills. `IconSettings.svg` is 3.7 KB of detail;
  `IconSetup.svg` is 329 bytes. Optical mass is accidental.
- **Density collapses at 28 px.** `IconSceneMap` is nine scattered circles plus a
  star — mush at render size. `IconChat` is a near-solid slab. Side by side they
  read as two different products.
- **No state system.** Every icon is flat `#FEE7C7`. The sidebar cannot express
  active / inactive / alert through the icon at all. This is why the tab strip
  feels inert.
- **Three palettes.** Logo cream `#DED4C3` + ochre `#B56A1D`; icons a *different*
  cream `#FEE7C7`; text styles cool blue-white `(0.95, 0.97, 1.00)` and
  blue-greys `(0.6, 0.65, 0.75)`. **The brand is warm and the UI is cold.**

## F. Things that do not work properly

### F1. Catalogue lookup is slow — two independent causes

**F1a — UE side (this is the one users hit).**
`handlers/HaybaMCPAssetHandler.cpp:222` calls `Registry.GetAllAssets(AssetData,
false)` — a full asset-registry enumeration. A grep of that handler for any
cache (`Cache`, `TMap<FString`) returns **nothing**. Combined with
`HaybaMCPTcpServer.cpp:133` marshalling every command to the **game thread**, a
catalogue lookup rescans every asset in the project *and* blocks the editor
while it does. It degrades as the project grows.

**F1b — TS side.** `catalog.ts:90-107`, `searchNodes()`: for every query, for
every node, it allocates a fresh array (spreading `common_patterns`, `.map`-ing
`inputs`, `outputs`, `key_properties`), `.join(' ')`s it, and `.toLowerCase()`s
the result — rebuilding and lowercasing the whole corpus on **every lookup**,
against a 654 KB `node_catalog.json`. `loadCatalog()` is memoised; the haystack
is not. Cheapest high-value fix in the repo.

### F2. The in-editor agent cannot author source

`src/chat/tool-dispatch.ts` dispatches UE commands only. Grepping `src/chat/`
and `src/agents/` for file read/write returns nothing but a manifest loader.
In Claude Code this is invisible (you inherit the host's file tools); in Hayba's
own Chat panel it is a hard wall. Aura's in-editor agent writes C++.

### F3. The fast compile loop is open-loop

`handlers/HaybaMCPEditorHandler.cpp:644-655` fires `LiveCoding.Compile` and
comments that the outcome "never comes back through this call", and that
**"Compile ERRORS are not in the editor log at all; they are in
`UnrealBuildTool\Log.txt`."** No tool reads that file.

The *slow* path is fine: `HaybaMCPBuildHandler.cpp` runs `build_project` /
`build_cook` / `build_generate_project_files` as non-blocking async jobs with
piped stdout, `exit_code`, journalling, and `build_status` polling — explicitly
written to avoid the old `Future.WaitFor(300s)` game-thread freeze. Good code.
It is minutes-scale, so it cannot carry iteration.

### F4. Chat sessions do not persist

`HaybaMCPChatPanel.cpp:791` — `// TODO: when persistence lands, save current
Session to disk before reset.` Plus TODOs at :384 and :837.

### F5. There is no single source of truth for "what can the agent do"

The surface is counted at least four incompatible ways:

- **225** commands declared in `GetCommands()` across 32 handler classes
- **154** commands described in `src/legacy-commands/sidecar.json`
- **~186** tool descriptors in `src/tools/index.ts` (`STANDARD_DESCRIPTORS` —
  the honest first-class surface, per the Phase 0/1 refactor), exposed through
  ~19 eager registrations plus the Code Mode meta-tools when Code Mode is on
- **130** files under `src/tools/`

No number is wrong; they measure different things. But nobody — not a user, not
a contributor, not the agent — can answer "what can this do?" from one place.
That ambiguity is upstream of half the "feels unfinished" feeling, and it is why
the README and marketing numbers keep drifting.

### F6. Stale config

`.codex/config.toml` points `HAYBA_NODE_CATALOG` and `HAYBA_PCGEX_DB` at
`D:/UnrealEngine/geoforge/...`. The host project is Aphrosia. Dead paths.

## G. What is genuinely good (do not break these)

- **Code Mode.** ~19 tools exposed, the rest behind three meta-tools. This is
  the same problem ChiR24 solved with a 23-tool gateway, and our answer is
  arguably better because the catalogue is queryable rather than fixed.
- **PLUMB's directional verdicts.** Signed margin + fix vector is strictly
  better than severity levels, and no competitor has anything like it.
- **The build handler.** Async jobs, piped stdout, no game-thread block.
- **Game-thread discipline.** `FHaybaGameThread::RunSync`, the job registry, and
  the `Future.WaitFor` postmortem — hard-won and correct.
- **The hash-only journal.** `HashParams()` + `SecretRedactionSummary` means the
  journal provably cannot leak secrets. Protect this invariant.
- **Plan Mode transactions.** Every destructive op inside
  `GEditor->BeginTransaction`, so Ctrl+Z works. A real trust primitive.

## H. Investigated and dismissed — do not re-derive

- **"GAS and MetaSound commands are described but not implemented."** False.
  They live in separate modules (`HaybaMCPGAS`, `HaybaMCPMetaSound`) whose
  handlers are not under a `handlers/` directory, so a naive glob misses them.
  All 12 are implemented.
- **"No validator rule has an evaluator."** False. Evaluators are attached at
  runtime by reference via `attachEvaluator`, so grepping `rules.ts` for
  `evaluate:` under-reports. 7 of 11 are live.
- **"`actor_spawn` / `actor_list` are unreachable because they are absent from
  `sidecar.json`."** False. They have first-class hand-written TS tools in
  `src/tools/actor/`.
