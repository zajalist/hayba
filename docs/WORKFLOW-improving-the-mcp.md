# Workflow: studying and improving the Hayba MCP toolset

**Read this before changing any MCP tool or plugin handler.** It exists because
the same bug keeps being rediscovered, expensively, by agents who had no way to
know it was a pattern.

---

## 0. The one thing to internalise

**Nearly every bug in this system already existed and appeared to work.**

Not crashes. Not exceptions. Tools that returned `ok: true` for work they did not
do. A partial list, all real, all found the hard way:

| Symptom | Reality |
|---|---|
| `asset_delete` → "34 deleted" | 34 `.uasset` files still on disk |
| `editor_pie_type_text` → `characters_sent: 7` | zero characters reached the field |
| `test_run` → everything "skipped" | zero tests had ever run, ever |
| `editor_pie_mouse` → `dispatched: true` | click landed 24px off, hit nothing |
| `save_asset` → `False` | the asset had in fact been saved |
| `hayba_search_tools` → no match | the tool existed; `dist/` was stale |

None threw. Each cost hours, and at least one produced a **wrong bug report
against innocent code** — an agent concluded the game was broken when the game
was fine.

So the working rule:

> **A response is a claim, not evidence. Verify the effect, not the reply.**

When you add or change a tool, the question is never "did it return ok". It is
"what could this return ok for, while having done nothing?" — then make that
case impossible to mistake for success.

---

## 1. The verification ladder

Five rungs. Each has been mistaken for the one above it in this codebase. State
which rung you reached; never imply a higher one.

1. **Written** — the code exists.
2. **Compiled** — the compiler accepted it. *Does not mean it is in the running
   editor.*
3. **Loaded** — the binary in the live process contains it. Check by grepping
   the Live Coding patch as UTF-16 (`TEXT()` literals are wide), not the base
   DLL, which stays stale by design.
4. **Routed** — a call reaches the handler. A domain error like
   "widget blueprint not found" proves this; `Unknown command` disproves it.
5. **Observed** — you looked at the effect. Screenshot, file on disk, readback,
   passing test.

Rung 4 → 5 is where the honesty lives. `dispatched: true` is rung 4 wearing a
rung 5 costume.

---

## 2. Staleness traps

Four independent caches. All four have silently served stale data. When
something "should work but doesn't", walk this list **before** debugging logic.

### 2a. Stale `dist/` — the MCP server
The server runs from `dist/`, not `src/`. `/mcp reconnect` restarts the process
and reloads the *same stale build*, so reconnecting "fixes" nothing.

- **Symptom:** tool returns `unknown_tool`; `hayba_search_tools` cannot find it.
- **Fix:** `npm run build:server` — **not** `npm run build`, which chains through
  `build:dashboard` whose nested install fails. Then `/mcp reconnect hayba-toolkit`.
- **Note:** a genuinely new tool needs the MCP server process restarted. Only
  the user can do that.

### 2b. Stale DLL / Live Coding patch
`Binaries/Win64/UnrealEditor-HaybaMCPToolkit.dll` stays old on purpose; Live
Coding writes `*.patch_N.exe` beside it.

- **Check the newest `patch_N.exe`**, decoded as UTF-16, for a string you just added.

### 2c. Stale dispatch map — *fixed, but know the shape*
`CommandToHandler` was built once at module load. Live Coding patches
`GetCommands()` but nothing rebuilt the map, so **any command added to an
existing handler was unreachable until restart**.

- Now self-healing: the router rebuilds on a miss and retries.
- **Still needs a restart:** a brand-new *handler class*. There is no instance to
  ask, and the error message says so.

### 2d. Automation tests register at module load
Live Coding will never register a new test. New C++ tests require a full build
and an editor restart. No exceptions.

---

## 3. Compiling

### Editor running → Live Coding
```
hayba_invoke { name: "editor_run_console_command", args: { command: "LiveCoding.Compile" } }
```
`hayba_invoke` takes **`args`**, not `params`.

`{executed: true}` means "the console command ran" — **not** "the compile
succeeded". Poll `D:\Projects\aphrosia\Saved\Logs\Aphrosia.log` for
`LogLiveCoding: Display: Live coding succeeded` or `LogLiveCoding: Error`. Match
on a **count** of terminal lines, not presence — earlier runs are still in the file.

**Compile errors are NOT in the editor log.** It only says "see Live console".
Read `C:\Users\Admin\AppData\Local\UnrealBuildTool\Log.txt`.

### Editor closed → full build
```
"C:\Program Files\Epic Games\UE_5.8\Engine\Build\BatchFiles\Build.bat" \
  AphrosiaEditor Win64 Development -Project="D:\Projects\aphrosia\Aphrosia.uproject"
```
Host project is **Aphrosia**, not geoforge (geoforge is stale and cannot build).

"Unable to build while Live Coding is active" after the editor has exited means a
stray `LiveCodingConsole` / `CrashReportClientEditor` survived. Kill those first.

### Closing the editor
Ask first unless told otherwise — another agent may be working in it.
`QUIT_EDITOR` via console is the graceful path. Check for dirty packages before
quitting so a save prompt cannot stall the shutdown. Shutdown can stall at
`~FD3D12DynamicRHI`; if the log has been silent there for minutes, the teardown
is done and a force-kill loses nothing.

---

## 4. Running the tests

### TypeScript (fast, no editor)
```
cd mcp-tools/hayba-mcp && npx tsc --noEmit && npm test
```
This is the authoritative gate. CI is unreliable — do not trust it, and do not
document it as broken in-repo.

### C++ (needs the editor)
```
test_list  { filter_pattern: "Hayba" }     ← filter_pattern, NOT filter
test_run   { test_names: [...] }           ← test_names, NOT filter
build_status { job_id }                    ← test_run is async
```

`test_run` accepts either the dotted name (`Hayba.MCP.Params.Reader`) or the
registered class name; it resolves between them. It did not always — passing the
dotted name used to start nothing and report **"skipped"**, which is why the
suite silently never ran. **Treat any `skipped` as suspicious**, not as a
decision.

Write new C++ tests in `Source/HaybaMCPToolkit/Private/Tests/`, using
`IMPLEMENT_SIMPLE_AUTOMATION_TEST` with `EditorContext | EngineFilter`.

---

## 5. The study loop

Repeatable, in priority order. Each step names what to look for.

### Step 1 — Find the silent liars
The highest-value bugs are tools whose success is unfalsifiable.

```
grep -rn "SetBoolField(TEXT(\"ok\"), true)" unreal/.../handlers/
grep -rn "return okResult" mcp-tools/hayba-mcp/src/tools/
```

For each hit ask: **if the underlying operation did nothing, would this response
differ?** If not, that is a bug even with no reproduction. Fix by reporting what
changed — `changed_keys`, `readback`, `coverage_percent`, `deleted_count`
verified on the filesystem.

The registrar enforces a floor automatically: a tool declaring any `effects`
whose response carries only bookkeeping keys gets an `UNVERIFIED` warning
appended (`src/tools/response-evidence.ts`). Do not fight that warning — fix the
response.

### Step 2 — Find the drifted duplicates
Two copies of one rule always diverge, and the divergence is the bug. Found this
way so far: three JSON→property converters with different capabilities; a Plan
Mode gate 26 commands behind its TS twin; two validation runners where one had
lost a fallback.

Where they hide: a constant list in C++ mirroring one in TS; a helper copied
rather than shared; the same loop in two handlers.

**Fix by deleting the copy, then add a test that parses the real source.**
`plan-mode-gate.test.ts` reads the `TSet` literal straight out of the `.cpp` —
asserting against a TS copy would only prove the copy matched itself.

### Step 3 — Find the unreachable
```
list_tool_categories       # commands the plugin has but no wrapper exposes
hayba_search_tools "..."   # does intent-based search find it?
```
A tool nobody can find does not exist. Descriptions must say **when to reach for
this** and **when not to** — `USE_WHEN` / `NOT_WHEN`.

There is a search benchmark: `src/tools/routing/search-quality.test.ts`. It
**will** catch a description that oversells. When it fails, the description is
usually wrong, not the benchmark — resist tuning for the test.

### Step 3b — Tool names and command names are different namespaces

`executeCommand(name, …)` puts `name` **on the TCP socket**. It must be a
command the **plugin** implements. It is *not* the place to call another MCP
tool, even though the two namespaces look identical.

`ui_copy_style` and `ui_set_default_font` both shipped doing
`executeCommand('ui_set_brush', …)` and `executeCommand('ui_set_text_style', …)`.
Those are TS-layer tools that translate onto `ui_set_widget_properties` before
anything reaches the wire, so the plugin answered **"Unknown command:
ui_set_brush"**. Both tools were dead on arrival.

**Their unit tests were green.** `ScriptedUe` maps arbitrary strings to
responses, so `scriptedUe().replies('ui_set_brush', …)` cheerfully scripts a
command that does not exist — the test confirmed the author's wrong model
instead of the system's actual contract. This is the sharpest form of the
"verify the effect, not the reply" rule: *a passing test is also just a claim,
if it asserts the wrong contract.*

- **To re-dispatch another tool, call its exported HANDLER** —
  `uiSetBrushHandler(args, session)` — never its name over the wire.
- **When you script a command in a test, ask whether the plugin implements it.**
  If you cannot point at the `TEXT("…")` in C++ or an entry in
  `legacy-commands/sidecar.json`, the test is fiction.
- `wire-command-names.test.ts` now enforces this statically. It also carries a
  `KNOWN_UNIMPLEMENTED` list of tools that dispatch commands the plugin has
  never had (the four `fab_*`, `plan_mark_step`, `hayba_request_input`,
  `hayba_get_user_response`). **Shrink that list; never grow it.**

### Step 4 — Close the seam bypasses
```
grep -rln "ensureConnected" mcp-tools/hayba-mcp/src/tools/ | grep -v test
```
Every tool goes through `executeCommand` (the ToolExecutor seam) so it inherits
timeout tier, retry policy and non-idempotent protection — **and so it can be
tested without an editor** via `ScriptedUe`.

Legitimate exceptions, do not "fix" these: `check-ue-status.ts` (a connectivity
probe — asking the transport whether it can connect *is* its job) and
`tool-stream-mirror.ts` (fire-and-forget UI mirroring, not a tool).

### Step 5 — Verify against a live editor
Cheapest real check available. Prefer it over reasoning.

---

## 6. Rules for the agent

**Report the rung you reached.** "Compiles" and "works" are different claims.
Say which. If you could not verify something, say that in the same breath as the
thing you did verify — not in a footnote.

**Never verify a delete with the asset registry.** The registry and the
filesystem disagree, and the registry is the one that lies. Check the file.

**Never read a click target off a screenshot.** `editor_pie_widget_tree` reports
**absolute desktop** pixels; a screenshot is window-relative. The difference is
the window's on-screen position. Pass tree coordinates through unchanged.

**The first click into an inactive PIE window activates the window** and does not
reach the UI. It looks exactly like a bug. Check `focused_widget_after`.

**Prefer `editor_pie_set_text` over `editor_pie_type_text` for forms.** Typed
characters go wherever focus happens to be and are lost if focus moves before the
widget commits. `set_text` reads the value back and reports `verified`.

**Leave the editor as you found it.** Stop PIE. Delete probe assets and
screenshots. Check dirty packages before quitting — but do not save another
agent's half-finished work without asking.

**One editor, possibly shared.** Another agent may be using it. Do not close or
force-kill without permission. Do not run two agents driving PIE at once.

**When a subagent contradicts your own measurement, re-measure.** An incoming
handoff diagnosed the coordinate bug on the reporting side; the numbers showed it
was the consuming side. Acting on the handoff's diagnosis would have moved the
error rather than removing it.

---

## 7. Definition of done

A change is done when **all** of these hold. Anything short, say so explicitly.

- [ ] `npx tsc --noEmit` clean, `npm test` green
- [ ] C++ compiled, and the compile **result** confirmed in the log — not just
      "the command executed"
- [ ] The new code is in the **running** binary (patch grep) or the editor was
      restarted
- [ ] A live call **routes** to it — a domain error counts, `Unknown command`
      does not
- [ ] The effect was **observed** — screenshot, file, readback, passing test
- [ ] A test exists that would fail without the change
- [ ] Editor left clean: PIE stopped, probes deleted, no dirty packages of yours
- [ ] Committed and pushed; working tree clean

---

## 8. Reference

| Thing | Where |
|---|---|
| MCP server | `mcp-tools/hayba-mcp` (build: `npm run build:server`) |
| Plugin source | `unreal/HaybaMCPToolkit` (symlinked into Aphrosia) |
| Host project | `D:\Projects\aphrosia\Aphrosia.uproject` |
| Editor log | `D:\Projects\aphrosia\Saved\Logs\Aphrosia.log` |
| Compile errors | `C:\Users\Admin\AppData\Local\UnrealBuildTool\Log.txt` |
| C++ tests | `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/` |
| Test harness | `mcp-tools/hayba-mcp/src/tools/testing/scripted-ue.ts` |
| Evidence contract | `mcp-tools/hayba-mcp/src/tools/response-evidence.ts` |
| Tool registrar | `mcp-tools/hayba-mcp/src/tools/register-tool.ts` |
| Param reader | `unreal/.../Public/HaybaMCPParams.h` |
| Reflection | `unreal/.../Public/HaybaMCPReflection.h` |
