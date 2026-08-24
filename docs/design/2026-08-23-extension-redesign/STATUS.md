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
| CI gates | **3 wired** | capability drift, icon staleness, icon-binding resolution. Each verified to fail on real drift, not just to pass. |

Full TS suite green at the time of writing: **187 files, 2119 tests**.

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
