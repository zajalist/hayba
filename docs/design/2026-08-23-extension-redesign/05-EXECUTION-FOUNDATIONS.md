# Foundations — F14 / F8 / F7 (execution plan)

The three structural wins that are safe to land alongside the crash branch.
Ordered by value-per-effort. Each is independently shippable.

---

## F14 — Delete the orphans, unify registration

**Best value-per-effort item in either codebase** (01b §6).

### The problem
1. `unreal/HaybaMCPNiagara/` and `unreal/HaybaMCPSequencer/` contain **only**
   `Binaries/Win64/*.dll` and stale `Intermediate/` — **no `Source/`, no
   `.uplugin`**. They are orphaned build artefacts from deleted modules. A DLL
   with no source confuses packaging, `git clean`, and every future reader.
2. Two registration paths for one interface: the 33 core handlers are
   registered by a hand-maintained list (`HaybaMCPModule.cpp:159-205`) calling
   `CommandHandler->RegisterHandler` directly, while satellites use the clean
   exported `RegisterExternalHandler` seam (ADR-0008). One interface should
   have one registration path with one set of invariants.

### Work
- **Establish the fact first**: confirm via git history whether those two
  directories ever had source, and that nothing references the DLLs. If they
  are genuinely dead, delete both directories; if the binaries are build
  output that should never have been tracked, delete *and* gitignore.
  (Do not assume — a DLL might still be loaded by a `.uproject` somewhere.)
- Route the core list through `RegisterExternalHandler` so there is one code
  path. `UnregisterHandler` already removes both the handler and its
  command-map entries, and `RebuildCommandMap()` survives Live Coding — so
  the unified path inherits behaviour that is already correct.
- Keep the satellite seam **exactly as is**. It is the cleanest seam in the
  project: optionality in `.uplugin` dependencies, `LoadModuleChecked` for
  ordering, symmetric register/unregister, two exported symbols, zero
  preprocessor conditionals.

### Risk
Very low. Deletion is verifiable; the registration change is mechanical and
covered by the existing command-map behaviour.

---

## F8 — The `searchNodes` haystack

**An afternoon, 10–50× on the path your agent complained about.**

### The problem
`catalog.ts:90-107`: for **every query**, for **every node**, `searchNodes`
allocates a fresh array (spreading `common_patterns`, `.map`-ing over
`inputs`, `outputs`, `key_properties`), `.join(' ')`s it, and `.toLowerCase()`s
the result — rebuilding and lowercasing the entire corpus per lookup, against
a 654 KB `node_catalog.json`. `loadCatalog()` is memoised; the haystack is not.

### Work
1. Precompute `_haystack` (lowercased, joined) once per node inside the
   already-memoised `loadCatalog()`.
2. `searchNodes` becomes `terms.every(t => node._haystack.includes(t))` —
   zero allocation per query.
3. **Commit a benchmark** so it cannot regress. This matters more than the fix:
   the bug existed because nothing measured it.
4. Optional follow-up (only if the benchmark says it's needed): an inverted
   token index making multi-term queries O(matching set).

### Behaviour to preserve
Multi-word queries currently match when *every* term appears anywhere in the
node's text (the comment at `:85-89` documents a past bug where a joined
phrase never matched). Keep that semantics exactly — the fix is about
allocation, not matching.

### Risk
Low. Pure refactor behind an unchanged function signature, with a test.

---

## F7 — One source of truth for the capability surface

### The problem
The surface is counted four incompatible ways (225 `GetCommands()`
declarations / 154 sidecar descriptors / ~186 TS descriptors / 130 tool files),
and **82 implemented commands have no sidecar descriptor**. Nobody — user,
contributor, or agent — can answer "what can this do?" from one place. This is
upstream of the marketing/README numbers drifting all year.

### Work
1. **Generate `sidecar.json` from the plugin's `GetCommands()`** at build time
   instead of hand-maintaining it. The 82-command drift disappears by
   construction rather than by discipline.
   - The generator needs the plugin's declarations. Two routes: parse the
     `GetCommands()` bodies statically, or add an `mcp_describe_commands`
     command so the sidecar is generated *from the running plugin* — the
     roadmap's Phase 1.5 already proposed the latter, and it also closes
     field-level drift. Pick the static parse first (no rebuild needed);
     upgrade to the live route when a rebuild is happening anyway.
2. **Emit `CAPABILITIES.md`** from the same generator: every command, its
   domain, agent-callable or not, and which TS tool (if any) wraps it. This
   becomes the honest public answer to "what can Hayba do?".
3. **CI gate**: fail when a declared command has no descriptor, and when
   generated ≠ committed. Replace the existing existence-only lint.
4. Fix `.codex/config.toml` — it points `HAYBA_NODE_CATALOG` and
   `HAYBA_PCGEX_DB` at `D:/UnrealEngine/geoforge/...`; the host project is
   Aphrosia. Dead paths.

### Why it runs before P1
P1 deletes `ValidatorFinding` and four rules. Deleting safely requires an
honest inventory of what references what — that inventory is F7's output.

### Risk
Low-medium. The generator is new code, but it replaces hand-maintenance with
derivation; worst case the gate is noisy for a day while the first generated
file is reconciled against the committed one.

---

## Sequencing

```
F14  ──┐  (C++, tiny, independent)
F8   ──┼── all three land in parallel, no interdependency
F7   ──┘  (its output gates P1)
```

None touch `HaybaMCPCommandHandler.cpp`, handlers, or panels — so all three
are safe beside the crash branch and beside P3a.

## Definition of done

- No directory in `unreal/` contains binaries without source.
- One registration path for all handlers, core and satellite.
- A committed benchmark proving catalogue search is fast, and staying green.
- `CAPABILITIES.md` generated, committed, and CI-gated against drift.
- `.codex/config.toml` points at the real host project.
