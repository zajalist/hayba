# Implementation status — branch `worktree-extension-rework`

Written 2026-08-24. The plans in this directory describe intent; this records
what is actually built, so a reader does not have to diff seven commits against
five execution docs to find out.

Everything below is on `worktree-extension-rework`, branched from `origin/main`
at `f0bb8369`. **Nothing here has touched the running MCP** — the live server
serves from `dist/` in the main worktree, which was never modified.

## Landed

| Item | State | Evidence |
|---|---|---|
| **F8** — catalogue search perf | **done** | `searchNodes` haystack cached in a WeakMap; **7.740ms → 1.186ms per query, 6.5×** on a 3000-node corpus. Test pins the property (repeats must not re-pay the build), not a timing number. |
| **F7** — capability inventory | **done** | `tools/capability-inventory.mjs` derives the surface from `GetCommands()`: **236 commands, 34 handlers**. `docs/CAPABILITIES.md` generated. CI-gated. |
| **P3a** — icon pipeline | **done** | `tools/build-icons.mjs` derives 148 rasters (37 icons × 16/28/32/56) from the signed masters. Hash manifest, CI-gated. |
| **P3a** — style layer | **written, NOT COMPILED** | 14 colour + 11 metric tokens, 37 icons registered as PNG at exact draw sizes, text styles moved onto tokens. Needs a Live Coding compile. |
| CI gates | **4 wired** | capability drift, generated-doc staleness, icon staleness, icon-binding resolution. Each verified to fail on the thing it guards, not just to pass. |

Full TS suite green: **187 files, 2119 tests** (re-run after every change).

Also landed while auditing: a categorical colour family, with two hues fixed
that sat within 10 degrees of the semantic ochre; raster filenames moved off
`@` (a Perforce revision character); and the catalogue cache test rewritten
from a timing assertion to an observable one.

**Three of the last four fixes were defects in this session's own work.** Worth
knowing when reading the rest: writing something carefully is not the same as
having verified it.

## Corrections to the plans in this directory

- **F8's estimate was wrong.** `02-PLAN` and `05-EXECUTION-FOUNDATIONS` say
  "10–50×". Measured is **6.5×**. The remainder is the substring scan itself;
  an inverted index would cut it further and is not worth it yet.
- **F14 is smaller than described.** `HaybaMCPNiagara/` and
  `HaybaMCPSequencer/` are **not in the repo** — they are untracked local build
  residue in the main worktree. Deleting them is an `rm`, not a commit. Only
  the registration unification remains, and that is C++.
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

- **A Live Coding compile of the style layer.** It is reviewed against the
  UE 5.8 headers (`IMAGE_BRUSH` appends `.png`; `Set(FName, FLinearColor)`
  pairs with `GetColor`, `Set(FName, float)` with `GetFloat`) and its 44 icon
  bindings are verified to resolve — but reviewed is not compiled.
- **A decision on the ten faint icons** (regenerate heavier, restrict to 28px,
  or accept). See the audit above.
- **A verdict on the 28px rasters** (`icon-rasters-proof.html`). If they
  disappoint at true size, the fallback is hand-tracing the six sidebar icons
  to SVG, and that is much cheaper to decide before more Slate work lands.

## Deliberately not done

The 53 inline `FLinearColor` literals across nine panels, and F14's
registration unification. Both are C++ that cannot be compile-verified in this
worktree, and stacking more unverified C++ on an already-unverified style layer
makes the eventual build problem larger rather than smaller. They should follow
the compile, not precede it.


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
