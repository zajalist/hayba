# HANDOFF — architecture cleanup / repo reorganisation

**Status:** in progress. Everything described here is committed and green on `main`.
**Started:** 2026-08-07 · **Last touched:** 2026-08-08
**Open issues:** [#319](https://github.com/zajalist/hayba/issues/319) (registration seam) ·
[#320](https://github.com/zajalist/hayba/issues/320) (C++ domain seam) ·
[#322](https://github.com/zajalist/hayba/issues/322) (`.default()` advertised as required)

Read [`docs/WORKFLOW-improving-the-mcp.md`](../WORKFLOW-improving-the-mcp.md) first if you have not.
Everything below assumes its verification ladder.

---

## 0. Read this part even if you read nothing else

**Five times in this work, something passed a clean build AND a fully green test
suite while being wrong.** Every one was caught by reading a diff or taking a
measurement — never by a green tick. In order:

1. A codemod hoisted a `HasErrors()` check into a conditional branch, so
   `blueprint_add_node` accumulated an error nobody read and failed later with a
   misleading message. Compiled, all tests green.
2. The next codemod could not *see* `static` free functions. It reported success
   having never looked at four files. Silence, not a skip line.
3. The zod 4 migration fixed all 26 type errors and silently emptied every
   tool's parameter documentation, because zod moved four things and **none of
   the old reads throw — they return `undefined`**.
4. A test I wrote asserted the wrong property (`server.tool` identity, which
   `installToolStreamMirror` legitimately changes).
5. A process kill raced a headless test run and produced "0 tests passed", which
   looked like a catastrophic regression and was a truncated log.

**Therefore: mutation-test anything you add.** Break the thing on purpose,
confirm the test goes red, revert, confirm green. Every test added in this work
was verified that way and the commits say so.

---

## 1. Verification commands

```bash
# TS gate — the authoritative one
cd mcp-tools/hayba-mcp && npx tsc --noEmit && npm test
npm run lint:legacy-wrappers        # SEPARATE from npm test. Easy to forget.

# C++ build (editor must be CLOSED)
"C:\Program Files\Epic Games\UE_5.8\Engine\Build\BatchFiles\Build.bat" \
  AphrosiaEditor Win64 Development -Project="D:\Projects\aphrosia\Aphrosia.uproject"

# C++ tests, headless
"C:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" \
  "D:\Projects\aphrosia\Aphrosia.uproject" \
  -ExecCmds="Automation RunTests Hayba.MCP; Quit" -unattended -nopause -nosplash -NullRHI -log
# results go to D:\Projects\aphrosia\Saved\Logs\Aphrosia.log, NOT stdout:
grep -E "Test Completed" /d/Projects/aphrosia/Saved/Logs/Aphrosia.log
```

Expected: **16 of 17 `Hayba.MCP` tests pass.** The one failure is
`Hayba.MCP.UI.RenderWidgetToPng`, which fails **only** under `-NullRHI` and
passes with a real RHI (drop the flag to confirm). It is not a regression.

### Two traps that will waste your time

- **`LNK1104: cannot open file ...UnrealEditor-HaybaMCPToolkit.dll`** — a
  headless run left `UnrealEditor.exe` alive holding the DLL. Not a code error.
  Kill `UnrealEditor|CrashReport|LiveCoding` and rebuild. Happens most builds.
- **"0 tests passed"** — you killed the editor too soon after the run and
  truncated the log mid-startup. Re-run and let it exit on its own.

---

## 2. Done (do not redo)

Repo/GitHub, all landed:

| | Before | After |
|---|---|---|
| `main` CI | red 26 days | green |
| Remote branches | 34 | 2 |
| Open PRs | 7 | 1 |
| Releases | 0 | v0.1.0 |
| `.git` | 3.6 GB | 2.4 GB (a `gc`, **not** a rewrite) |
| TS tests | 1340 | 1391 |
| C++ test files | 12 | 15 |
| Handlers using `FHaybaParamReader` | 1/33 | 15/33 |
| Typed seams | 0/33 | 4 |

Code work: `ueTool()` absorbed 93 duplicated wrapper bodies → 36 that differ for
a reason · `toMcpResponse` + `FrameDecoder` recovered from a branch stranded
since May · sidecar 7821 collision merged (ADR-0006) · zod 3→4 · registration
monkey-patch replaced with an explicit stand-in · retry-gate population made a
call rather than an import side effect · ADRs 0005/0006/0007 written, CONTEXT.md
glossary updated.

Six stranded branches were **archived as tags** before deletion — `archive/*` on
the remote. 27 commits preserved. Do not delete those tags.

---

## 3. What is actually left

### The headline numbers overstate it

"18 handlers without a param reader" and "29 domains without a seam" are
spellings, not problems. Checked individually:

- **Asset** — needs nothing. `asset_delete` is already the honest version
  (checks the file on disk before/after, distinguishes an orphaned `.uasset`,
  reports per-path). Zero multi-required functions.
- **PIE** — already seamed. `HaybaPieCoords::ToAbsolute` is in a public header,
  called by the real handler, covered by a regression test for the 24px click
  offset.
- **Material** — the earlier pass took its multi-required functions; nothing left.
- **Legacy** — yielded exactly one function. `Cmd_ValidateGraph` must NOT be
  converted: it returns `Ok` with `{valid:false, errors:[...]}` by design, which
  is its contract, not a bail.

**Before converting a handler, check whether it needs it.** Two of the four I
picked as "real candidates" needed nothing.

### Genuinely remaining

1. **#320 — typed domain seams.** 4 of 33 done (Actor, UI, PIE, Editor). Copy
   the pattern in `Public/HaybaActorOps.h`; its header comment explains why the
   Parse/Execute/Shape split falls where it does. **Only Execute needs an
   editor**, which is the entire point — parameter handling is where the bugs
   are and it previously required a live editor to exercise.
2. **#319 — registration.** The monkey-patch is gone. Still open: five ways a
   tool gets registered (descriptor list, ~30 hand-rolled `server.tool` sites
   that register no meta, py-tool factory, sidecar generator, `defer()`).
   Direction: make the catalogue a **value, not a side effect**.
   **Do not trust a green typecheck here** — this is the code that decides what
   an agent can see. Verify with `list_tool_categories`, `hayba_search_tools`,
   and `hayba_invoke` on a tool whose pack is *not* loaded.
3. **#322 — `.default()` params are advertised as `(required)`.** Pinned by a
   test literally named `PINS A KNOWN INACCURACY`; fixing it means flipping that
   test. Lives in two near-copies of the same unwrap loop
   (`schema-registry.ts`, `chat/agent-loop.ts`) — expect them to disagree.
4. **~510 raw `TryGet*Field` calls — NOT mechanizable.** Measured. They are
   optional reads that fuse validation/defaulting/another source object into the
   read (`if (P.IsValid())`, `&& D > 0.0`, `&& Arr->Num() >= 3`,
   `Entry.Value->TryGet...`). A sweep drops that logic. They move with their
   domain's extraction. The mechanizable subset is **finished** — do not restart it.

---

## 3b. The unreachable-command gap (2026-08-08)

`list_tool_categories` reports **415 plugin commands, 355 callable**. That gap is
mostly not missing features — it is C++ that shipped with nothing exposing it.
Whole domains sat at zero callable while their handlers worked perfectly.

A command becomes callable by adding a descriptor to
`mcp-tools/hayba-mcp/src/legacy-commands/sidecar.json`. No plugin rebuild, no TS
code: `agent_callable: true` plus `has_ts_wrapper: false` makes
`legacy-tool-factory` surface it. Two traps:

- If any TS file already calls `executeCommand('<name>')` — even internally —
  `has_ts_wrapper` must be `true`, and then the factory will NOT surface it. That
  is why `mesh_get_info` stays internal. `npm run lint:legacy-wrappers` catches it.
- A running MCP server reads the sidecar at startup. New entries are invisible
  until the user restarts it, so **you cannot verify a new descriptor through
  `hayba_invoke` in the session that wrote it.**

Talk to the plugin directly instead. 4-byte big-endian length prefix + a JSON
`{cmd, id, params}` payload on port 52342 (see `src/tcp-client.ts`). ~40 lines of
node. Every descriptor written in this sweep was produced by calling the command
first and describing what came back, which is how each of these was found:

- `project_set_settings` returned `ok:true` carrying an `error` field when it
  had written nothing.
- `net_set_replication` validated `net_dormancy` **after** applying
  `SetReplicates` — a rejected request left the actor changed.
- `data_create` discarded its save result, so creating into a folder that did
  not exist reported success and wrote nothing; `data_get`/`data_set` then could
  not see the asset at all, because `UEditorAssetLibrary::LoadAsset` only finds
  what is on disk.

Surfaced: project, audio, mesh_list/set_lod (#8), input, net (#21/#23), bt,
anim (#20/#17), physics, wp and the three stranded `editor_*` commands.

**The main plugin is done.** Every command `HaybaMCPToolkit` implements now has a
descriptor or is deliberately `agent_callable:false`. Two are the latter —
`level_get_spatial_index` (always `status:"deferred"`) and `wp_load_cell` (an
honest error, but never a success). The rule they follow is
`no-stub-wrappers.test.ts`: do not offer a command that can never succeed.

**What is left, precisely:**

- `gas`, `metasound`, and the stale `niagara_*` / `seq_*` names. These are NOT
  missing descriptors. `unreal/HaybaMCP{GAS,MetaSound,Niagara,Sequencer}/` are
  four complete plugins that are **absent from `Aphrosia/Plugins/`**, so their
  commands answer `Unknown command`. The `niagara_*` / `seq_*` surfaces agents
  use today come from the TS/python tool layer instead. Settle the packaging
  question before writing another line of code here: install and build them, or
  fold what is worth keeping into the toolkit and delete the rest. See #19.

**One caution learned the hard way.** Two people edited the same three handlers
in the same afternoon and independently made the *same* fix. A session holding
pre-commit file state will happily revert the other's committed work when it
writes. Diff against HEAD before committing anything in a file you did not open
in this session.

**Two traps found by writing descriptions, both still live:**

- `blueprint_create` / `material_create` take `package_path` as the FULL intended
  asset path and discard its trailing component. Passing a folder — the obvious
  reading — writes the asset one directory up and saves it there.
  `package_path:"/Game/Temp"` + `name:"BP_X"` produces `/Game/BP_X`.
- `blueprint_add_function` accepts a name the blueprint already has. It adds the
  function, the compile fails with "Found more than one function with the same
  name", the reply is `ok:true` with `compile_errors`, and nothing is rolled
  back. Read `compiled_clean`, not `ok`.

---

## 4. Recurring bug patterns found (look for these)

- **`TryGetArrayField` true ≠ well-formed.** Hit twice: `placement_validate`
  (2-element location silently became a zero) and `render_camera` (2-element
  location rendered **from the origin and reported success**). Check `Num()`
  and make a short array an error.
- **A command that changed nothing reporting `ok`.** `actor_transform` with no
  component used to succeed having done nothing — indistinguishable from a
  silent failure.
- **Silent tolerance teaches callers nothing.** `ui_set_widget_properties`
  accepts three spellings of the slot payload; it now reports
  `slot_props_read_from` so a caller can tell "I was right" from "I was
  forgiven". Same for `rotation_from` on `editor_set_camera`.
- **Two copies of one rule diverge.** ADR-0007. A grep-based check **fails
  open** — wrap a guarded call and the check goes quiet, not red. If you
  introduce a helper around `executeCommand`, update
  `src/tools/__tests__/wire-command-names.test.ts` **and**
  `scripts/check-legacy-wrappers.mjs` in the same commit.

### One difference that is NOT a bug

`render_camera` applies array roll; `editor_set_camera` ignores a third array
element so the horizon cannot tilt. Deliberate — a rendered shot may want a
dutch angle, the editor viewport is somewhere you keep working. Reasoning is
recorded at both sites. Do not "fix" one to match the other.

---

## 5. Suggested next step

Pick one domain, do it end-to-end, verify at rung 5, commit. Do not batch.

`ui_set_widget_properties` is **done** — Parse and Shape are in `HaybaUIOps`,
Execute stayed in the handler because applying properties needs UMG slot classes
and `FBlueprintEditorUtils`. That asymmetry is the point and is worth copying:
the pure halves are where the bugs were, so extract those and leave the engine
half alone. `FHaybaParamReader` gained `OptionalObject` and `Raw()` doing it.

`Blueprint` is **done** too — `HaybaBlueprintOps` holds the two rules that were
actually wrong (duplicate function names, and the `package_path` trailing
component), both mutation-tested. Five domains now have a seam: Actor, UI, PIE,
Editor, Blueprint.

Next candidate: the rest of the UI handler. `HandleMutateTree` is ~580 lines
across six sub-commands, each re-reading `widget_name` its own way.

Check first whether the domain needs it. Two of four did not.
