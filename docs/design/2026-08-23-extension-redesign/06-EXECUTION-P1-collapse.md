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
