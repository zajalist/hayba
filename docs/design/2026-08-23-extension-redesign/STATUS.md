# Implementation status — branch `worktree-extension-rework`

Written 2026-08-24. The plans in this directory describe intent; this records
what is actually built, so a reader does not have to diff seven commits against
five execution docs to find out.

Everything below is on `worktree-extension-rework`, branched from `origin/main`
at `f0bb8369`.

**On isolation, precisely.** The TypeScript server other people use serves from
`dist/` in the *main* worktree, which nothing here has written to — every
`npm run build` in this branch lands in this worktree's own `dist/`.

The C++ side is a weaker claim and was overstated earlier. Verifying the Slate
work means compiling this branch's plugin and running an editor on it, which
happens in a separate runtime worktree (`hayba-aphrosia-runtime`, hard-synced
to the commit under test). That editor is a dev instance, not anyone's working
session — but it is a real editor running unreleased plugin code, so "nothing
has touched a running MCP" was too strong. What is true: no shared binary and
no shared `dist/` is modified, so nobody else's session can pick this branch up
by accident.

## Landed

| Item | State | Evidence |
|---|---|---|
| **F8** — catalogue search perf | **done** | `searchNodes` haystack cached in a WeakMap; **7.740ms → 1.186ms per query, 6.5×** on a 3000-node corpus. Test pins the property (repeats must not re-pay the build), not a timing number. |
| **F7** — capability inventory | **done** | `tools/capability-inventory.mjs` derives the surface from `GetCommands()`: **239 commands, 35 handlers**. `docs/CAPABILITIES.md` generated. CI-gated. |
| **P3a** — icon pipeline | **done** | `tools/build-icons.mjs` derives 148 rasters (37 icons × 16/28/32/56) from the signed masters. Hash manifest, CI-gated. |
| **P3a** — style layer | **compiled, live** | 24 colour + 11 metric tokens, 37 icons registered as PNG at exact draw sizes, text styles on tokens. Built and run in the editor; `tools/style-token-check.mjs` gates typo'd token names in CI. |
| CI gates | **5 wired** | capability drift, icon staleness, prompt-names-a-real-tool, style-token resolution, shipped-asset staleness. Each was verified by breaking the thing it guards and watching it go red — a gate that has only ever passed is not known to be a gate. |

Full TS suite green: **201 files, 2264 tests** (re-run after every change), plus `tsc --noEmit` and a full `npm run build` including the asset copy — that last one because the suite runs from `src/` and stayed green through a broken build once already.

Also landed while auditing: a categorical colour family, with two hues fixed
that sat within 10 degrees of the semantic ochre; raster filenames moved off
`@` (a Perforce revision character); and the catalogue cache test rewritten
from a timing assertion to an observable one.

**Three of the last four fixes were defects in this session's own work.** Worth
knowing when reading the rest: writing something carefully is not the same as
having verified it.

## Small open item

`build-icons.mjs` reports one master built but unbound: **material-display**.
It is a real 37th icon, distinct from `material`. Nothing in the UI asks for
it, and binding it would mean inventing a destination to justify an asset —
backwards. It stays built and unbound until something needs it; the icon check
reports this as a *note*, not a failure, which is the right severity for "an
asset exists that nobody uses yet".

## Corrections to the plans in this directory

- **F8's estimate was wrong.** `02-PLAN` and `05-EXECUTION-FOUNDATIONS` say
  "10–50×". Measured is **6.5×**. The remainder is the substring scan itself;
  an inverted index would cut it further and is not worth it yet.
- **F14 is smaller than described.** `HaybaMCPNiagara/` and
  `HaybaMCPSequencer/` are **not in the repo** — they are untracked local build
  residue in the main worktree. Deleting them is an `rm`, not a commit. The
  registration unification turned out to be already in place; see
  03-MASTER-PLAN §F14 for what was actually changed (a silent no-op made
  loud).
- **The GAS/MetaSound "described but not implemented" finding is dead.** The
  generated inventory reports zero such commands, confirming it was an artifact
  of a glob that skipped satellite modules. `01-CRITIQUE` §H already said so;
  this is independent confirmation.
- **P3a's scope was widened slightly and deliberately.** Only four old tab
  tokens shared names with new icons, so a literal reading would have left
  seven outline icons beside four filled ones in one sidebar. The old tokens
  were re-pointed at signed rasters whose meaning already matches the tab
  (ToolStream → activity, SceneMap → world, Plan → plan-pending, Validation →
  rules, MCP → connect, Slivers → recipe). **No tab renamed, moved, or
  removed** — still look-only.

## Findings that need a decision (not acted on)

1. **`editor_get_perf_stats` is an orphan.** `FHaybaMCPPerfHandler` declares it
   while `FHaybaMCPEditorHandler` implements `editor_get_performance_stats` —
   the one actually described and used. A whole handler's command is dead.
   Delete the duplicate, or merge and expose? Allowlisted meanwhile.
2. **`copilot_get_key` is unreachable by design** — credential retrieval the
   agent must never reach. Allowlisted with that reason.
3. **`blueprint_add_event` was hidden by a stale comment** and is now listed.
   The comment claimed three commands were `not_implemented_in_v1` stubs to
   omit; only one was actually omitted, and all three have since been
   implemented for real. **Live-verify before trusting it.**


## Open issue: icon optical weight (found 2026-08-24)

Pixel audit confirms the two-tone palette claim is true (zero off-palette
pixels across 37 masters), but found ink coverage varies **6.7×** at 16px --
`save` 73% solid, `connect`/`remove`/`camera-viewport` 10.9%. Ten icons fall
under 20%, including `world` (sidebar) and `state-pending` (a row-end mark
whose job is to be noticed). See `14-ICON-WEIGHT-AUDIT.md`.

Not acted on: these were picked individually across four review rounds, so
regenerating them at heavier weight is the user's call.

## What needs the user

- ~~A Live Coding compile of the style layer.~~ **Done.** Class-layout
  changes ruled Live Coding out, so it went through full rebuilds:
  `Build.bat AphrosiaEditor Win64 Development`, editor relaunched, MCP
  handshake confirmed. The header reading held — `IMAGE_BRUSH` does append
  `.png`, and the `Set`/`Get` type pairings were right.
- **Sign-off on two new palette entries.** `Status.Warn` (`#C9A25E`) and
  `Status.Info` (`#7E9CC4`), added so the Validation panel's severity colours
  could leave their full-saturation primaries. This is a *visible* change to
  that panel, not a like-for-like swap — see 13-COLOUR-MIGRATION.
- **A decision on the ten faint icons** (regenerate heavier, restrict to 28px,
  or accept). See the audit above.
- **A verdict on the 28px rasters** (`icon-rasters-proof.html`). If they
  disappoint at true size, the fallback is hand-tracing the six sidebar icons
  to SVG, and that is much cheaper to decide before more Slate work lands.

## Deliberately not done

Nothing on this list any more. Both entries were deferred for the same stated
reason — stacking unverified C++ on an unverified style layer makes the
eventual build problem larger, not smaller — and that reason expired once the
plugin could actually be built and run from this worktree.

~~The 53 inline `FLinearColor` literals across nine panels.~~ **Swept**, down
to 34 that are deliberately not chrome — handler data, Unreal's own graph
grammar, one pending palette axis, and two load-bearing alphas. Each remainder
is listed with its reason in 13-COLOUR-MIGRATION, because an undocumented
remainder invites someone to sweep the ones that must not be swept.

~~F14's registration unification.~~ **Was already done**, which this section
kept asserting otherwise long after 03-MASTER-PLAN recorded the finding.
Satellites self-register via `RegisterExternalHandler`; GAS and MetaSound both
`LoadModuleChecked` so the core router exists first regardless of load order.
The one real change was making a dropped registration *say so* instead of
silently no-opping — a dropped handler otherwise means every command it
declares just does not exist, with nothing to explain why.

Two docs disagreeing about whether work is done is worse than either being
wrong on its own, so: 03-MASTER-PLAN §F14 is the record, and this section was
the stale one.


---

## Branch divergence — needs a decision before this lands (2026-08-25)

Found while checking whether `test-editor-survival.ps1` exists for the R4
reliability page. It does not exist on this branch, and tracing why turned up
something larger.

    branch point            f325ea06
    on crash-resilience,
      not in this branch    25 commits
    on this branch,
      not in crash-res.     83 commits
    either merged to main?  no

The 25 include real hardening, not just noise:

    3b2d102e  harden typed asset_import against crafted native input (#415)
    24ff49b1  a caught SEH fault jumped over the engine's world restore
    c481d076  retire embedded Tier-3 authority (#411)
    9de78453  broker host I/O outside Unreal Python (#412)
    45f37c2d  cap generated engine workloads (#413)
    be67efad  remove raw temp-file spill for oversized python_run output (#383)
    534cb939  make mutation outcomes and callbacks truthful (#369 #370 #406)
    7684fe81  bound embedded execution policy (#366 #392)

Two consequences.

**The reliability page cannot cite the survival suite yet.** R4's outline says
`scripts/test-editor-survival.ps1` "already exists (1,652 lines)". It exists at
`mcp-tools/hayba-mcp/scripts/`, is 706 lines, and lives on the OTHER branch.
Publishing a reliability page whose centrepiece is "run our torture suite"
against a script this branch does not contain would be the worst possible
version of that document.

**Someone has to decide how these two branches meet.** Neither is on main. The
rework branch has 83 commits of product change; the other has crash hardening
that this one has never been tested against. Merging is not mechanical — the
rework renamed a plugin directory tree, moved handlers, and changed the
validator's on-disk format, all of which the hardening commits predate.

Not a call to make unattended: it decides what ships and what gets re-tested.

### Also corrected

An earlier note in 03-MASTER-PLAN said "#415 landed on this branch as
3b2d102e". It did not. The A1 conclusion stands — it rests on reading this
worktree's code and importing a glTF and an HDR through a build of THIS branch
— but the attribution was wrong and is now marked as such.

---

## The merge, measured (2026-08-25)

The note above says merging "is not mechanical" and lists the rework's renames
as the reason. That was a guess. Here is the actual damage, from
`git merge-tree --write-tree HEAD feat/crash-resilience-advisory-hardening`:

    conflicting files        8
    conflict hunks          13
    conflicted lines       446
    merged tree             59b8504c

**The feared cause is not in the list.** The plugin directory rename, the moved
handlers, and the validator's on-disk format change produce *zero* conflicts —
git tracked all three cleanly. Every panel file, `HaybaMCPModule.cpp`, and the
validator's `tool-hooks.ts` and `runner.test.ts` all auto-merge. The pessimism
was unearned, and planning around it would have been planning around nothing.

### What actually conflicts, and why it is the interesting kind

| File | Hunks | Lines |
|---|---|---|
| `handlers/HaybaMCPDataAssetHandler.cpp` | 2 | 80 |
| `handlers/HaybaMCPRenderHandler.cpp` | 2 | 58 |
| `HaybaMCPCommandHandler.cpp` | 3 | 160 |
| `handlers/HaybaMCPPhysicsHandler.cpp` | 1 | 15 |
| `validator/rules.ts` | 1 | 9 |
| `tools/index.ts`, `code-mode/list-tool-categories.ts`, `python-run-validator-wrap.ts` | 4 | 124 |

These are **not** either/or conflicts. In almost every case both branches
independently improved the *same* code path, and the merge needs both edits
kept, not one chosen:

- **DataAssetHandler** — the hardening branch made a discarded save result
  truthful (`ok:true` regardless of whether the save actually succeeded); this
  branch changed the same block's output shape. Both are right. The resolution
  is this branch's shape carrying that branch's honesty.
- **RenderHandler** — that branch added timeout-safety (do not read
  task-written fields after a signal timeout; the task owns the shared ref) and
  PNG dimension verification. This branch touched the same function. Dropping
  either side reintroduces a real bug.
- **CommandHandler** — this branch *removed* the inline `ui_memory_set` /
  `ui_tool_stream` router special-cases into a proper `UIBridgeHandler`, while
  that branch edited them in place. The resolution is "take this branch's
  extraction, and re-apply that branch's edits inside the new handler" — the
  one hunk where a careless `--ours` silently loses work.

### What this means for the decision

The merge is roughly a day of careful work, not a rewrite. The cost is not in
the volume; it is that **six of the eight conflicts are semantic** — both sides
correct, both needed — so this cannot be resolved by picking a side, and a
resolution done quickly will look fine and quietly drop hardening.

Two things must be true afterwards, and neither is implied by "it compiles":
this branch has *never* been tested against those hardening commits, and the
survival suite that would test it (`test-editor-survival.ps1`, 706 lines) lives
only on the other branch. So the order is: merge, then run that suite against
the merged result, and only then treat R4's reliability claims as citable.

Still a decision, not a task — it decides what ships and what gets re-tested.
But it is now a decision with a number attached.
