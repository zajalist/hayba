# The lock-in plan — making every feature feel finished

## The decisions this plan implements (locked 2026-08-23)

1. **Position** — A + B, both deep, one product. Spatial world-building depth
   *and* a credible general in-editor agent.
2. **Spine** — *everything is an edit to one understood world.* Every capability,
   spatial or code, is an edit against a world model that is understood, checked,
   and reversible.
3. **Collapse** — PLUMB + validator + slivers become **one** system with **one**
   verdict language. Three domain nouns survive: **Profile**, **Rule**, **Recipe**.
   `ValidatorFinding` and the 4 dead rules are **deleted**, not migrated.
4. **Five nouns** — `World / Library / Rules / Activity / Chat`. Settings is a
   gear, not a peer.
5. **Name and logo unchanged.** Rebrand = icon set + noun system + visual language.
6. **Recipes** — captured from Activity (primary), plus ~6 first-party seeds
   offered as an explicit choice in the first-run wizard.
7. **Recipe capture** — a bounded, redaction-aware, in-memory ring buffer in the
   MCP server; human reviews the generated spec before anything is written.
   The hash-only journal invariant is untouched.
8. **Visual direction** — cool neutral chrome, ochre spent **only on meaning**,
   one 24 px keyline grid, and a **shared** three-mark state vocabulary
   (attention / pending / unsaved) composited over noun icons, rather than a
   per-icon badge. Tuned ochre `#C47A28`; logo untouched.
9. **The in-editor agent gets no write authority.** Read source, build, parse
   diagnostics, propose patches. See W7.

## The test for "finished"

A feature is finished when all five hold. Apply this to every workstream below.

1. **It has a triggering moment.** Something in the workflow surfaces it. If the
   only way to reach it is remembering it exists, it is not finished.
2. **It tells the truth.** Nothing is listed that will not run. No "coming soon".
3. **It has one name.** Enum, label, icon key, docs, and onboarding agree.
4. **It has a verdict.** The user can tell whether it worked without inferring.
5. **It is reversible.** Or it says clearly that it is not.

---

## Sequencing rationale

Six `priority: critical` crash issues are in flight on the plugin's C++
(#415, #411, #407, #406, #387, epic #373). **Do not fork Slate while that lands.**
So the order is: TypeScript-side and non-UI work first, Slate rewrite in one
concentrated pass afterwards.

| Phase | Workstreams | Touches | Can run alongside crash work? |
|---|---|---|---|
| 1 | W0, W1 | TS + one UE handler | Yes |
| 2 | W2 | TS only | Yes |
| 3 | W3, W4 | Slate (heavy) | **No** — land crash P0s first |
| 4 | W5, W6 | TS + Slate (light) | After phase 3 |
| 5 | W7 | TS + UE | Independent |

---

## W0 — One source of truth for the capability surface

**Problem:** F5. The surface is counted four incompatible ways (225 / 154 / ~19 /
130). Nobody can answer "what can this do?" from one place.

**Do:**
- Generate `sidecar.json` from the plugin's `GetCommands()` declarations at build
  time instead of hand-maintaining it. The 82-command drift disappears by
  construction.
- Emit one `CAPABILITIES.md` from the same generator: every command, its domain,
  whether it is agent-callable, and which TS tool (if any) wraps it.
- Add a CI check that fails when a declared command has no descriptor.
- Fix `.codex/config.toml` (F6) — `geoforge` → the real host project path.

**Done when:** one command, one number, and a CI gate that keeps it true.

**Why first:** every later workstream needs an honest inventory, and the
marketing/README numbers stop drifting the day this lands.

---

## W1 — Catalogue performance

**Problem:** F1. Reported live: *"Hayba is connected but its catalogue lookup is
currently slow."*

**W1a — UE asset registry (the one users feel).**
- Replace `Registry.GetAllAssets()` at `HaybaMCPAssetHandler.cpp:222` with a
  cached index, invalidated by `IAssetRegistry::OnAssetAdded / OnAssetRemoved /
  OnAssetRenamed`.
- Narrow every query that has a path or class to `GetAssetsByPath` /
  `GetAssetsByClass` instead of enumerate-then-filter.
- Since handlers run on the game thread, the cache build must be incremental or
  off-thread with a game-thread publish — do not trade a slow lookup for a hitch.

**W1b — TS node catalogue.**
- Precompute a lowercased `_haystack` per node inside the already-memoised
  `loadCatalog()`; `searchNodes` then does `terms.every(t => haystack.includes(t))`
  with zero per-query allocation.
- Optional second step: an inverted token index for multi-term queries.

**Done when:** a catalogue lookup on a project the size of Aphrosia returns in
well under a second, with a benchmark committed so it cannot regress.

**Effort:** W1b is an afternoon. W1a is the larger half.

---

## W2 — The collapse: Profile / Rule / Recipe, one verdict language

**Problem:** A1, A2. The system PLUMB was written to replace is still shipping
next to it.

**Do:**
1. **One verdict type.** `ConstraintResult` / `GateResult` (signed `value_m` +
   `FixVector`) becomes the only verdict in the product. **Delete
   `ValidatorFinding`.**
2. **Migrate the 7 live checks** to bound constraints where they express a
   spatial predicate; keep the genuinely non-spatial ones (the two `python_run`
   safety gates) as pre-execution guards, which is what they already are — they
   are not validation, they are refusal, and they should be named that way.
3. **Delete the 4 catalog-only rules** and **delete the test that pins them**
   (`__tests__/rules.test.ts:33-48`).
4. **Delete one of the two validation panels.**
5. **Rename slivers → Recipes** throughout: MCP tools (`hayba_sliver_*` →
   `hayba_recipe_*`, with the old names aliased for one release), spec schema,
   Slate widgets, docs. "Sliver" leaves the vocabulary entirely.
6. **Make Recipes emit verdicts.** A Recipe spec declares which Rules it must
   satisfy; running one produces a verdict automatically. This is the fix for A4
   — the triggering moment.

**Done when:** one verdict type in the codebase, the Rules surface lists only
checks that run, and running a Recipe produces a verdict without the user asking.

**Explicitly out of scope:** adding rules. The Rules surface gets *smaller* in
this pass. That is correct — an honest short list beats a padded one.

---

## W3 — The IA rewrite

**Problem:** B, C, D. Eleven implementation-named rooms for six questions, four
naming systems, two Scene Maps.

**Do:**
- `EHaybaPanel` becomes exactly `World / Library / Rules / Activity / Chat`.
  The enum name, the tab label, the icon key, the docs, and the onboarding copy
  must be the same word. Add a test asserting that.
- **Activity** absorbs Plan + Diff + Tool Stream. Plan-pending becomes a *state*
  of an activity row with inline Approve/Reject, not a room.
- **Library** absorbs Memory/Library + Slivers, split into Profiles and Recipes.
- **Rules** absorbs Validation + Lessons + the PLUMB panel. A Lesson renders
  inline on the rule it explains; it is never a separate screen.
- **World** keeps one Scene Map. **Pick one renderer and delete the other** —
  recommend keeping the web/`cognitive-map` one if it is the richer view, since
  `SWebBrowser` gives you layout and interaction for free, but that is a call to
  make with both on screen.
- **Settings** absorbs the MCP capabilities panel and moves behind a gear.
- Rewrite `HaybaMCPOnboardingWidget` panel copy to match (it currently claims 7
  panels and names three that do not exist).

**Done when:** five sidebar entries; every one of the six user questions has
exactly one room; `grep` finds no surviving "Sliver", "Tool Stream",
"Validation Report", or "Memory Inspector".

---

## W4 — The visual system

**Problem:** E. No grid, no weight, no state system, three palettes.

**Do:**
- Land the generated palette tokens in `HaybaMCPStyle.cpp`, replacing the ad-hoc
  cool blue-greys and the second cream.
- Land 13 new icons on the 24 px keyline grid, replacing 12 inconsistent ones.
- Implement the **state layer**: `Hayba.Icon.<Name>` plus an ochre state tint, so
  active / pending / violated read from the icon itself. This is the fix for the
  sidebar feeling inert.
- `#B56A1D` (or the tuned variant) appears **only** for: active tab, pending
  approval, unsaved edit, rule violation. Never decoration. Add this to
  `CONTRIBUTING` so it does not erode.

**Done when:** the sidebar communicates state without text, and one grep for the
ochre hex returns only semantic uses.

**Assets:** produced by the codex runs in this directory — `icons/`, `palette.md`,
`icons/preview.html`, `RATIONALE.md`.

---

## W5 — Recipes become real

**Problem:** A3. Two specs, one unproven, ten widgets.

**Do:**
1. **Prove or kill `pcg_biome`.** Resolve the `TODO(live-validate)` on
   `MeshSelectorParameters` / `ImportText` against a live editor. If the inline
   sub-object import does not work, switch to the `pcg_set_prop` nested-path
   fallback and validate *that*. A seed recipe that does not work is worse than
   no seed recipe.
2. **Capture buffer.** A fixed-size (~200 call) in-memory ring in the MCP server
   at the tool-call boundary, existing secret redaction applied on the way in,
   never written to disk.
3. **`hayba_recipe_capture`.** Reads the buffer, lifts varying values to
   parameters, emits a Recipe spec.
4. **Review sheet.** The user sees and edits the generated spec **before** it is
   saved. Nothing reaches disk unreviewed. The 10 `SSliverParam*` widgets finally
   earn their existence here, because captured parameters are arbitrary.
5. **"Save as Recipe"** on every completed Activity row. This is the feature.
6. **~6 first-party seed recipes**, offered as an explicit choice in the wizard:
   heightmap import, biome scatter, foliage density pass, landscape material
   blend, lighting preset, PIE smoke test. Keep the set small — every seed is a
   maintenance liability against UE version churn.

**Done when:** a user can do something once, press one button, and have a
parameterized repeatable version of it — and the Library is never empty unless
they chose that.

**Session-only limitation is intended:** restart clears the buffer. "Save what I
just did" is the right scope and it avoids inventing a durable argument store.

---

## W6 — First run

**Problem:** C. The wizard misstates the product and ends on "Coming soon".

**Do:** correct panel names and count; delete the "Coming soon" step or ship the
sample scene; add the seed-recipes choice from W5; keep required steps
(connection, capability token, plan mode) and make the optional ones honestly
optional.

**Done when:** nothing in first-run is aspirational.

---

## W7 — The B-half: compete on the code loop

**Problem:** F2, F3, F4. Aura's coding agent writes and self-corrects C++
in-engine. Ours cannot, in our own panel.

This is genuinely reachable — the hard part (`BuildHandler`'s async job registry
with piped stdout and no game-thread block) already exists and is good.

**Do:**
1. **`livecoding_compile_await`** — fire `LiveCoding.Compile`, then poll
   `UnrealBuildTool\Log.txt` (where the errors actually are, per the code's own
   comment) and return a real result instead of fire-and-forget.
2. **A diagnostics parser** — UBT/MSVC output to structured
   `{file, line, column, severity, message}`. Self-correction needs structure,
   not a stdout blob.
3. **Read-only source access — NO write authority.** *(Decided 2026-08-23.)*
   The in-editor agent may **read** `<project>/Source/**`, build, and parse
   diagnostics. It **proposes** a patch; the user applies it. It cannot write
   any file.

   This was chosen over path-scoped write authority deliberately. This entire
   branch has been *shrinking* agent authority — #411 retired the embedded
   Python Tier-3 override, #412 moved connector I/O out of Unreal Python, #394
   wants freeform escape hatches replaced by capabilities. Handing the chat
   agent a filesystem cuts directly against that current, and the blast radius
   of a confused agent would go from "assets, with undo" to "the disk, with
   none". `03a0a39e` (a relative screenshot name wrote into the Unreal install
   tree) is the concrete precedent for why path scoping alone is not enough.

   Read + compile + diagnose delivers most of the visible value — the agent
   reads your code, builds it, and tells you exactly what is wrong and where —
   with **zero** new authority surface. It upgrades to scoped write later with
   no rework, because the diagnostics parser and the proposal UI are the same
   either way.

4. **Chat persistence** — close the three TODOs in `HaybaMCPChatPanel.cpp`.

**Do not chase:** in-engine 3D asset generation. That is a model plus a pipeline,
not a plugin feature, and it is the one place their lead is structural.

**Done when:** the in-editor agent can read a `.cpp`, compile it, surface the
real error at `{file, line, column}`, and hand the user a patch to apply — all
without leaving the editor, and without the agent holding write authority.

---

## W8 — Crash resilience (existing issues, unchanged)

Not created by this plan, but it gates phase 3 and it is the ground the whole
positioning stands on. Aura leads with crash recovery; six `priority: critical`
issues here say we cannot yet. **This outranks every workstream above except
W0/W1.** Land #406, #407, #411, #415, #387 before the Slate rewrite.

---

## Risks

| Risk | Mitigation |
|---|---|
| Slate rewrite collides with in-flight crash fixes on the same files | Phase ordering — W3/W4 wait for the P0s |
| Deleting `ValidatorFinding` breaks consumers we have not found | W0's inventory runs first; grep the generated capability doc |
| Recipes stays thin even after capture ships | The wizard seed set guarantees a non-empty Library on day one; capture guarantees growth |
| `pcg_biome`'s unproven write turns out to be broken | W5.1 resolves it before it is offered as a seed |
| The five-noun IA drifts back into eleven | The naming test in W3, plus the ochre-semantics rule in CONTRIBUTING |
| Aura ships spatial understanding | Nothing in their copy suggests a world model today. The moat is real but it is not permanent — W2 and W5 are the ones that build it |

## What this plan deliberately does not do

- Add tools. The surface shrinks in every phase but W7.
- Add validator rules. The honest short list is the feature.
- Rename or restyle the logo.
- Chase tool-count parity with anyone. See the field study.
