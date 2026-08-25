# P1 — the Profile / Rule / Recipe collapse (execution plan)

Implements ADR-0009. Almost entirely TypeScript; no plugin rebuild. This is
the change that makes the product *feel* coherent rather than merely look
coherent — and it is the one the whole five-noun IA rests on.

**Precondition:** F7's generated inventory exists. Deleting a type safely
requires knowing every reference.

---

## The five verdict shapes being collapsed into one

From 01c §3e, exact inventory:

| # | Type | Location |
|---|---|---|
| 1 | `ValidatorFinding` | `validator/rules.ts:32` |
| 2 | `UiFinding` | `validator/ui/types.ts:106` |
| 3 | `ContentFinding` | `validator/content/types.ts:42` |
| 4 | `BaseFinding` / `FindingOf<R>` | `validator/run-category-rules.ts:21,40` |
| 5 | `Verdict` / `InstanceVerdict` | `plumb/contracts.ts:71`, `plumb/evaluate.ts:66` |

`tools/plumb/tools.ts:30-36` imports two of them and hand-converts. #4 was
introduced to unify #2 and #3 and **replaced neither** — the direct precedent
for why "add a unifying type" fails unless the old ones are deleted.

**The target:** PLUMB's directional verdict — signed `value_m` + `FixVector` —
is the only verdict in the product.

---

## Commit sequence

### 1. Land the unified `Finding`, adapters only
Add `validator/finding.ts` with the single type. Write adapters from each of
the five shapes into it. **Delete nothing yet.** Everything still works;
the new type is merely available. Reviewable in isolation.

### 2. Migrate producers, one category per commit
`ui` rules (80 in `validator/ui/rules.ts`) → `content` → the 7 live
`validator` rules. Each commit: producers emit `Finding` directly, that
category's adapter is deleted, its old type deleted. `run-category-rules.ts`
loses its generic and takes `Finding`.

**Non-spatial checks are not validation.** The two `python_run` safety gates
(`isSelfSocketScript`, `danglingLifetimeRegistration`) run *before* execution
and *refuse* — they are guards, not verdicts. Move them to
`tools/guards/` and name them accordingly. They must not be dragged into the
verdict model just because they currently live in `validator/`.

### 3. Delete the dead rules and their pinning test
`pcg_surface_source_not_landscape`, `unreal_landscape_placeholder`,
`actor_position_drift_after_user_edit`, `actor_spawn_class_not_found` — plus
`__tests__/rules.test.ts:33-48`, the test that pins the dead state as correct.

**The Rules surface gets smaller here.** That is the intended outcome; note it
in the changelog so it reads as intent, not regression.

### 4. Migrate the on-disk history
`validator/history.ts` serialises the old shape. Add a read-side migration
(detect old records, adapt on load, write new shape). Users must not lose
their finding history to a refactor.

### 5. Delete `ValidatorFinding`
Only after 1–4. The type disappears; the compiler proves nothing references it.

### 6. Rename slivers → Recipes
`hayba_sliver_list/get/run/import` → `hayba_recipe_*`, **with the old names
aliased for one release** (the param-alias machinery already exists). Rename
the spec schema, the Slate widgets, the docs, `SSliversPanel` → `SRecipesPanel`.
Grep must find no surviving "sliver" outside a compatibility shim and the
historical ADR.

### 7. Recipes emit verdicts — the triggering moment
A Recipe spec declares which Rules it must satisfy; `runRecipe` evaluates them
and returns the verdict with the result. **This is the fix for A4** (nothing
had a triggering moment). After this commit, a user never navigates to Rules
to find out whether an edit was sound — the answer arrives with the edit.

---

## What must not break

- **The closed primitive set stays closed.** 13 primitives, no operators, no
  user-written logic. Generality comes from binding. Authoring fills values.
- **`response-evidence.ts`'s invariant** — "a response is a claim, not
  evidence" — is the single most valuable rule in the TS codebase (01c). The
  verdict work must strengthen it, never route around it.
- **Cross-cutting policy stays at the registration seam**
  (`withValidationNudge` / `withEvidenceWarning` / `appendNicheBriefing`).
  Never inline into handlers.
- **The hash-only journal.** Recipe capture (W5) reads a bounded in-memory
  ring buffer at the tool-call boundary, never the journal.

---

## Sliver → Recipe: the payload problem is separate

Renaming does not fix "2 specs, one unproven". That is W5, and it has its own
precondition: **prove or kill `pcg_biome`'s `TODO(live-validate)`** — whether
`ImportText` imports the inline sub-object onto the instanced
`MeshSelectorParameters`, or whether the `pcg_set_prop` nested-path fallback is
needed. A seeded starter Recipe that does not work is worse than none.

That check needs a live editor, so it belongs with the next in-editor session
— not in this TypeScript-only pass.

---

## Definition of done

- One verdict type in the codebase; `grep` finds no `ValidatorFinding`,
  `UiFinding`, `ContentFinding`.
- The Rules surface lists only checks that run.
- Running a Recipe produces a verdict without being asked.
- Finding history survives the migration.
- "Sliver" is gone from the vocabulary.


---

## Status — 2026-08-24

Steps 1–7 landed; the TypeScript half of P1 is complete. 2134 tests, tsc clean.

| Step | Commit |
|---|---|
| 1. Unified `Finding` + adapters | `e91ee9b2` |
| 2. Producers migrated (ui → content → tool rules) | `eb873d80`, `8a84a10e`, `3e39d465` |
| 3. Dead rules deleted | `9f59b92b` |
| 4. History migrates on read | `ec6354a6` |
| 5. `ValidatorFinding` deleted | `ec6354a6` |
| 6. slivers → Recipes (TS half) | `3826fd2a`, `db196208`, `907999b7` |
| 7. Recipes emit verdicts | `43a7162a` |

Definition of done, checked rather than assumed:

- One verdict type. The only mentions of the other four are the comment in
  `finding.ts` recording why they existed.
- The Rules surface lists only checks that run — enforced by a test.
- Running a Recipe produces a verdict without being asked.
- Finding history survives the migration (three tests, including that the
  timestamp/record-id survives).
- "Sliver" survives only in documented compatibility shims.

### Two holes found while doing the work, both fixed

**`checkRecipeRequires` had no callers.** A recipe could declare requirements
and nothing ever checked them — A4 was worse than "no triggering moment", it
was "no trigger at all".

**Requirements were never validated at define time.** `evaluate()` skips a
constraint whose primitive it does not recognise, on the stated assumption
that define-time validation rejected it. `validateRecipeRequires` existed and
only its own test called it, so a spec with a nonsense primitive loaded
cleanly and was then reported SATISFIED while checking nothing. Same shape as
the four catalogued-but-dead validator rules. `parseRecipeSpec` now runs it.

### What is left: the C++ half of step 6

Not started — it needs a full rebuild (class renames change layout, so Live
Coding cannot patch it) and the editor was running.

- `Private/Slivers/` → `Private/Recipes/`, ~20 files
- `SSliversPanel` → `SRecipesPanel`, `HaybaSliverClient/Loader/Types`
- `UHaybaSliverSettings` is a **config UCLASS** — renaming it orphans its
  `[/Script/HaybaMCPToolkit.HaybaSliverSettings]` section in
  `EditorPerProjectUserSettings.ini` and silently drops the user's configured
  `McpHttpBaseUrl` and `MaxSliverDepth`. Needs `[CoreRedirects]` class +
  property entries, shipped in plugin `Config/`, and verified by launching
  rather than assumed.
- Then `%APPDATA%/Hayba/slivers` → `.../recipes` with a one-time migration,
  moving both halves together, and the `/sliver/*` route alias can retire a
  release later.


### C++ half of step 6 — written, NOT COMPILED (`9361d128`, `20c52bb3`)

28 files renamed, `Private|Public/Slivers` → `Recipes`, every identifier and
user-visible string with them.

`Config/DefaultHaybaMCPToolkit.ini` carries class, enum and property
redirects for `UHaybaSliverSettings` → `UHaybaRecipeSettings`. File name and
entry format were taken from a shipped engine plugin
(`Engine/Plugins/2D/Paper2D/Config/DefaultPaper2D.ini`) rather than from
memory, because getting the location wrong fails silently — the section is
simply never found and the user's settings revert to defaults.

Fixed a bug the rename exposed rather than caused: `RecipeFilePath` returned
only the new suffix, so a recipe installed before the rename would show in the
list and then fail to export or delete. It now resolves whichever spelling is
on disk, and the delete prompt names the real file.

**Before this can ship, someone must:**

1. Close the editor (class renames change layout — Live Coding cannot patch
   them) and run a full rebuild.
2. Launch, and confirm a previously-configured `McpHttpBaseUrl` still reads
   back. That is the only way to know the CoreRedirects actually took; a
   silent revert to defaults is what failure looks like.
3. Confirm the Recipes panel still lists a recipe installed under the old
   `.sliver.json` name, and that export and delete both find it.

Until then the plugin build on this branch is unverified. The TypeScript side
is unaffected and green.

### Still open after step 6

- Move `%APPDATA%/Hayba/slivers` → `.../recipes`. Both halves must move in one
  commit, with a one-time migration; `recipes/loader.test.ts` pins the current
  location and will fail loudly if only one side moves.
- Retire the `/sliver/*` route alias and the `hayba_sliver_*` tool aliases one
  release after this one ships.


---

## Step 6 C++ half — BUILT AND VERIFIED (2026-08-25)

Editor closed (zero dirty packages), rebuilt, relaunched, checks run.

**Build:** clean. Only pre-existing PCG deprecation warnings.

**Check 1 — settings survive the class rename.** FAILED first, then fixed.

The CoreRedirects did NOT carry the settings. Seeding `MaxSliverDepth=17`
under the old section and reading the class back after the rebuild gave `8`,
the default. The reason: a config UCLASS's values live in a section keyed by
the class path, and the config system never consults CoreRedirects when
resolving a section name. Nothing in `Runtime/Core` offers a section-rename
mechanism either.

`UHaybaRecipeSettings::MigrateLegacyConfigSection()` now adopts the old
section explicitly, writes the values under the new name and clears the old
one. Re-tested end to end: seeded `31337` / `AutoDebounced250` / `17` under
the legacy section, and after the rebuild the class read back all three, with
the ini rewritten under the new section and the old one gone. Survives a
second restart, so the migration runs once and sticks.

The redirects stay — they do cover asset references to the old class and
enum, which is a separate job. The ini now documents what they do and do not
do.

**Check 2 — a half-migrated library.** Found a bug and fixed it.

Reading both spec spellings means a directory can hold `X.recipe.json` AND
`X.sliver.json` for one recipe. The plugin appends into a flat `TArray`, so
every migrated recipe appeared TWICE in the panel. The real library on this
machine was already in that state. The loader now skips an id it has already
loaded, reading the current spelling first so first-wins is correct.

The TypeScript loader could not duplicate (Map keyed by id) but picked its
winner by `readdir` order, which is nobody's decision. It now sorts the
current spelling first and claims ids explicitly.

**Check 3 — verified by test, not by eye.** There is no editor-UI screenshot
command, so `Hayba.Recipes.Loader.LegacySpecNames` covers it as a real UE
automation test: a legacy-named spec loads, a half-migrated pair lists once
with the current spelling winning, and two distinct ids still list as two.
`Result={Success}`.

The test was confirmed to actually catch the bug — removing the dedup made it
fail with "Expected 'half-migrated recipe listed once' to be 1, but it was 2",
then restoring it passed. An assertion never seen red proves nothing.

**Full plugin suite:** 41 pass, 3 fail. None are recipe-related: two are
NullRHI/commandlet artifacts (`RenderSafety.Policy`, `UI.Replace`) and one is
a different plugin (`MetaSound.InputBoundary`). All three test files contain
zero references to recipes or slivers, so the rename cannot have caused them.
They are pre-existing and out of scope here.

**Editor:** relaunched, MCP up, zero brush errors. The probe values were
removed from the user's settings afterwards.

### Still open

- Move `%APPDATA%/Hayba/slivers` -> `.../recipes`. Both halves must move in
  one commit with a one-time migration; `recipes/loader.test.ts` and the C++
  path comment pin the current location.
- Retire the `/sliver/*` route alias and the `hayba_sliver_*` tool aliases one
  release after this ships.


---

## Library directory moved — DONE and verified live (2026-08-25)

`%APPDATA%/Hayba/slivers` -> `%APPDATA%/Hayba/recipes`. Both halves moved in
one commit (`4a8dbc0f`) because they read the same directory: move one and the
Recipes panel goes empty.

Both run the same migration before their first read. It renames the directory,
which is atomic, so the two are expected to race on startup and losing is
harmless — the loser finds the destination already there. When the destination
exists (partly migrated, or the other half won) it moves over only what is
missing and never overwrites, so a spec edited since upgrading is not clobbered
by the stale copy left behind. A move, not a copy: two live libraries would
drift the moment either was edited.

**Verified against the real library, not just in tests.** The machine's library
was staged back into a genuine pre-upgrade state (only the old directory, both
spec spellings inside) and the editor launched:

    LogTemp: HaybaRecipeLoader: moved the recipe library to
             C:\Users\Admin\AppData\Roaming/Hayba/recipes

`slivers/` is gone, `recipes/` holds everything.

**A bug that only the live test would have caught.** The migration was first
wired into `SRecipesPanel::Construct`, so it ran only if the user happened to
open the Recipes tab. The first live launch migrated nothing and the directory
sat unmoved. A data migration gated on visiting a particular tab is not a
migration, it is a coin flip. It moved to `FHaybaMCPModule::StartupModule`
(`bfb14fc1`), which is where it belongs, and the second launch moved the
library immediately.

The unit tests passed the whole time — they exercise `MigrateLegacyLibrary`
directly and never had an opinion about who calls it.

**Coverage:** 3 vitest cases plus `Hayba.Recipes.Loader.LibraryMove` (whole-
directory move, partly-migrated fill-without-overwrite, nothing-to-do). Both
UE tests `Result={Success}` on the final build.

### Remaining

Retire the `/sliver/*` route alias, the `hayba_sliver_*` tool aliases and the
`.sliver.json` read path one release after this ships. Nothing else carries the
old vocabulary.
