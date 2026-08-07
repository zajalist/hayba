# 0007 — A static check must know every form of the call it guards

**Status:** Accepted (2026-08-07)

## Context

Ninety-three wrapper files each hand-wrote the same eight-line body — validate,
bail, `executeCommand`, stringify — including a byte-identical error line.
`src/tools/tool-result.ts` was written to own that contract and reached 6 of 104
call sites, because its own docstring told readers not to adopt it broadly. The
duplication was stable rather than shrinking.

`ueTool(command, schema)` absorbed that body; 56 files converted.

Two static checks then went quiet, and the second was found by CI rather than by
looking:

- **`wire-command-names.test.ts`** scans source for `executeCommand('literal')`
  and asserts every name against the commands the C++ plugin implements. It
  exists because tool names and wire command names are different namespaces that
  look identical, and getting it wrong produces `Unknown command` at runtime
  while unit tests pass.
- **`scripts/check-legacy-wrappers.mjs`** scans the same way to decide whether a
  command the sidecar claims has a TS wrapper actually has one.

`ueTool` calls `executeCommand` internally. Both checks therefore **still
passed** — they simply stopped seeing the 55 call sites that had adopted the
helper. Nothing went red. Fifty-five tools would have dropped out of the check
that exists to stop "Unknown command" reaching an agent.

In one case it happened to fail loudly instead: six `editor_pie_*` wrappers were
reported as `missing-wrapper` when they had not moved at all. That is the same
blindness pointing the other way, and it is the only reason this was noticed at
all within the hour.

## Decision

**When a call site's shape changes, every static check keyed to that shape is
part of the change.** Introducing a helper that wraps a guarded call means
teaching the guards the new spelling, in the same commit.

Concretely, a check that greps for a call must match every form that reaches it:

```
executeCommand('name', …)     hand-written handlers
dispatch('name', …)           legacy dispatch
ueTool('name', schema)        pass-through wrappers
```

## Consequences

- Coverage of `wire-command-names.test.ts` went 56 → 111 sites. All 55 new ones
  validate against the plugin, which is also the evidence that the codemod
  preserved every wire name.
- A grep-based check fails **open**, not closed: it goes quiet rather than red
  when the thing it greps for is renamed. That is the opposite of what a safety
  net should do, and it is why this needs to be a standing rule rather than a
  one-off fix. `docs/WORKFLOW-improving-the-mcp.md` §5 step 2 already names the
  general shape — two copies of a rule diverge and the divergence is the bug.
- Prefer checks that parse the real source of truth over checks that grep for a
  spelling, where the choice exists. `plan-mode-gate.test.ts` reads the
  `DestructiveCommands` `TSet` literal straight out of the `.cpp` precisely so
  that asserting against a TS copy cannot prove only that the copy matches
  itself.
