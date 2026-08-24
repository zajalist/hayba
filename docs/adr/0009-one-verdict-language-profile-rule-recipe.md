# 0009 — One verdict language: Profile, Rule, Recipe

Status: **Proposed**
Date: 2026-08-23
Supersedes: nothing. Retires the legacy validator's verdict type.

## Context

Three systems in this repo answer versions of the same question, in three
mutually unintelligible languages, on three separate surfaces.

| | PLUMB | Legacy validator | Slivers |
|---|---|---|---|
| Asks | "is this object placed correctly?" | "did that tool call go wrong?" | "run a parameterized edit" |
| Verdict | `ConstraintResult` — signed `value_m` + `FixVector` | `ValidatorFinding` — severity + message + hint | ad-hoc result |
| Surface | `Slate/SHaybaValidatorPanel.cpp` | `HaybaMCPValidationPanel.cpp` (47 lines) | `SSliversPanel.cpp` |

This was never the intent. `src/plumb/contracts.ts:5-8` says PLUMB exists so the
validator can speak a quantified directional language *"instead of the boolean
severity findings the legacy validator emits."* **The replacement was designed
and never executed.** Both shipped.

Three further consequences accumulated:

- **4 of 11 validator rules never fire.** `rules.ts:56` documents this as
  intentional — they are listed in the Configure panel so users know the system
  *would* warn them. `__tests__/rules.test.ts:33-48` pins that state as correct.
  A UI that lists checks it will never run is a UI that lies politely.
- **Slivers is a framework awaiting a product**: 2 specs (one carrying an
  unresolved `TODO(live-validate)` on its central write), 1,336 lines of TS, and
  10 Slate parameter widgets.
- **Nothing has a triggering moment.** All three are pull-surfaces. Nothing in
  the workflow ever says "now open Slivers" or "now run `plumb_validate`". A
  feature you must remember to go find reads as optional, and optional reads as
  unfinished.

The last point is the root cause. The others are symptoms.

## Decision

**One verdict language, three nouns.**

1. `ConstraintResult` / `GateResult` — signed `value_m` plus `FixVector` — is the
   **only** verdict type in the product. `ValidatorFinding` is **deleted**.

2. Three domain nouns, each with a real referent:

   - **Profile** — what an asset *is*. Baked geometry and physics, plus AI
     qualitative semantics that carry confidence and a human lock.
   - **Rule** — what must be true. One of 13 closed primitives plus numbers plus
     a binding. Each Rule carries its **Lesson** (the why) inline; a Lesson is
     never a separate screen.
   - **Recipe** — a parameterized, repeatable edit. Formerly "sliver". A Recipe
     declares which Rules it must satisfy.

3. **Running a Recipe produces a verdict automatically.** This is the triggering
   moment. Rules stop being a place you go and become something that appears next
   to the edit that caused it — with a `[Fix]` affordance driven by `FixVector`,
   because a directional verdict can offer a real correction rather than a red X.

4. The 4 catalog-only rules are **deleted**, along with the test that pins them.
   The Rules surface gets smaller before it gets better. An honest short list
   beats a padded one.

5. Checks that are not spatial predicates — the two `python_run` safety gates —
   are **not** validation. They are refusal, they already run before execution,
   and they are renamed to say so.

6. "Sliver" leaves the vocabulary. `hayba_sliver_*` become `hayba_recipe_*` with
   the old names aliased for one release.

## Consequences

**Good**

- One verdict type means one UI language, one store, one mental model. The
  incoherence users feel but cannot name disappears at the root.
- The directional verdict becomes load-bearing rather than a curiosity. It is
  the one thing in this product no competitor has, and it is currently consumed
  by nothing.
- The 10 `SSliverParam*` widgets stop being scaffolding for two specs and become
  the renderer for captured Recipe parameters (see W5 in the redesign plan).
- Deleting the dead rules removes the only place the UI knowingly misleads.

**Costs**

- A real refactor with deletions, not an additive change.
- The Rules surface visibly shrinks. This must be communicated as intent, or it
  reads as regression.
- Anything consuming `ValidatorFinding` outside the paths found so far will
  break. The capability inventory (W0) runs first for exactly this reason.

**Rejected alternatives**

- *Keep three systems, unify only the UI.* Cheap, and the incoherence returns the
  first time anyone looks underneath.
- *Delete slivers and the legacy validator, keep PLUMB alone.* Smallest and most
  honest surface, but it discards the Recipe idea — which, once Recipes are
  captured from work already done rather than authored, is the strongest
  world-building affordance in the product.

## Invariants this must not break

- The journal stays **hash-only**. `HashParams()` plus `SecretRedactionSummary`
  means the journal provably cannot leak secrets. Recipe capture therefore reads
  from a bounded in-memory ring buffer at the MCP tool-call boundary, never from
  a journal, and never writes unreviewed parameters to disk.
- Plan Mode transactions stay. Every destructive op inside
  `GEditor->BeginTransaction` is a trust primitive, not a feature flag.
- The primitive set stays **closed**. Generality comes from binding, not from a
  growing grammar. Authoring fills values; it never writes logic.
