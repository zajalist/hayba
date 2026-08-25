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
- ~~Sign-off on two new palette entries.~~ **Withdrawn.** `Status.Warn` and
  `Status.Info` now carry the Validation panel's original literals unchanged,
  so the addition moved those colours into the token system without altering a
  pixel. The retuned values were a genuine improvement, but shipping a visible
  palette change nobody approved is not how curation works here. Retuning is a
  two-line edit in `HaybaMCPStyle.cpp` whenever it is wanted; the call sites
  are already on tokens and need no further change.
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

- **DataAssetHandler** — *corrected below; this is not a "keep both" case.*
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


### Correction: the DataAsset conflict is a design choice, not a merge

Written above as "both sides improved the same path, keep both edits". That is
wrong, and so was my first attempt at correcting it (which claimed both
branches independently found the same bug — they did not; `git show f325ea06`
has the fix already). What actually happened:

**The merge base already reported the save honestly.** `saved:false` plus a
plain-English `save_note` was there before either branch. The two branches then
took that same starting point in opposite directions, which is why this
conflicts and why neither side can simply absorb the other.

*This branch* kept the base's shape — a failed save is a caveat on a success:

    Out->SetBoolField("saved", bSaved);          // Ok(), even when false
    if (!bSaved) Out->SetStringField("save_note",
        "created in memory but NOT written to disk — call asset_save, or "
        "create into an existing content folder");

*The hardening branch* escalated it — an unverified save became a failure, with
the whole provenance chain published alongside the verdict:

    const bool bOutcomeTrustworthy = bDirtyMarked && bPreSaveReResolved
        && bSaveAttempted && bSaved && bTargetReResolved && bDirtyKnown;
    Out->SetBoolField("ok", bOutcomeTrustworthy);
    // plus dirty_marked, pre_save_re_resolved, save_attempted, saved,
    //      target_re_resolved, dirty_known as separate wire fields

Neither is a superset. They disagree about the question an MCP reply answers:

|  | this branch | hardening branch |
|---|---|---|
| unverified save | `ok:true`, `saved:false`, one plain-English note | `ok:false`, "unknown outcome" |
| wire cost | 2 fields | 8 fields, every call |
| caller must | read one note | interpret six booleans |

**Recommendation, not a decision.** Take the hardening branch's *rigour* and
this branch's *wire economy*: compute `bOutcomeTrustworthy` exactly as it does
— that chain catches real failure modes this branch misses, notably an asset
that re-resolves to something else between save and reply — but publish `ok`
plus one `error` naming **which** link broke, not all six booleans. Six
internal step-flags on every successful call is the token cost of a debugging
session charged to every caller forever, and the failing link is the only one
anybody reads.

The general lesson for the rest of the merge — earned the hard way, by getting
this entry wrong twice in a row: **read the merge base before characterising a
conflict.** Both of my earlier readings were confident and wrong, in opposite
directions, because I diffed the two branches against each other and never
against what they started from. A conflict tells you two sides changed the same
lines; it says nothing about whether they were fixing the same thing, fixing
different things, or diverging from a fix that was already there. The base is
the only thing that distinguishes those, and it is one `git show` away.

Applied to the remaining six conflicts: none of them have been read against
`f325ea06` yet, so the "both sides are right, keep both" characterisation above
should be treated as unverified for every file except this one.

### All eight, read against the base

Done properly this time — `git diff f325ea06..each-side` per file, rather than
diffing the branches against each other:

| file | this branch | hardening branch |
|---|---|---|
| `handlers/HaybaMCPDataAssetHandler.cpp` | +19 / −1 | **+1620 / −91** |
| `HaybaMCPCommandHandler.cpp` | +29 / −172 | **+575 / −105** |
| `handlers/HaybaMCPRenderHandler.cpp` | +10 / −4 | **+223 / −279** |
| `tools/index.ts` | +43 / −5 | **+255 / −105** |
| `code-mode/list-tool-categories.ts` | +5 / −4 | **+213 / −37** |
| `tools/python-run-validator-wrap.ts` | +4 / −2 | +34 / −15 |
| `handlers/HaybaMCPPhysicsHandler.cpp` | +20 / −9 | +10 / −22 |
| `validator/rules.ts` | **+16 / −46** | +10 / −13 |

Every file is BOTH-CHANGED, so none can be resolved mechanically. But the shape
of the table is the finding, and it inverts the obvious approach.

**In seven of eight conflicting files, this branch's changes are the small
ones.** DataAssetHandler is the extreme case: 20 lines here against 1,711
there — roughly **eighty-five to one**. The instinct when merging someone else
into your own feature branch is to favour your side and re-apply theirs. Here
that instinct is precisely backwards: `--ours` on these files would discard the
overwhelming majority of the hardening work, and it would *compile*, and the
test suite would stay green, because what it deletes is defensive code for
failure modes the tests do not produce.

**So the merge direction should be: take the hardening branch's version of
these eight files, then re-apply this branch's much smaller edits on top.** The
one file where that reverses is `validator/rules.ts`, where this branch is the
larger change (−46 lines, from collapsing the five finding shapes into one).

`HaybaMCPCommandHandler.cpp` needs care in either direction: this branch's
−172 is mostly the *deletion* of the inline `ui_memory_set` / `ui_tool_stream`
router special-cases, which moved to a real `UIBridgeHandler`. Taking theirs
wholesale would resurrect three retired inline commands and give the router two
paths to the same handler. That one is genuinely hand-work: keep the extraction,
port their edits into the extracted handler.

### Why this was worth measuring rather than assuming

Three characterisations of this merge were written before this table, each
confident, each wrong: "not mechanical, the renames will collide" (renames
collide with nothing), "both sides are right, keep both edits" (unverified),
and "both branches independently found the same bug" (the base already had the
fix). The numbers took one command and settle all three.

---

## Built, tested, unreachable — a survey (2026-08-25)

Four separate defects today had the same shape: a capability written,
reviewed, tested, and never wired to anything. `checkProtocol` reached only
`doctor`. `checkRecipeRequires` had zero callers. A working room grammar
shipped as a test fixture. So rather than keep tripping over these, I looked
for the rest: exported symbols with no production reference anywhere.

**The first pass was wrong and reported 202.** It excluded a symbol's own file
on the theory that a local use does not prove an external caller — which
misclassifies every helper called by an exported entry point in the same file.
`searchNodes` and `connectWithBackoff` are both entirely reachable and both
appeared in that list. Counting same-file references cut it to 34.

Of those 34, most are legitimate: deliberate test seams, and per-domain
constant lists consumed by name. Two findings are real.

### 1. The retry guard was copied by hand across a dozen files — now pinned

`executeCommand` retries once on transport failure unless the command is in
`NON_IDEMPOTENT`, because re-firing a spawn executes it twice. That master set
is hand-maintained, and each tool domain *separately* exports its own
`*_NON_IDEMPOTENT` list which the master only cites in a comment:

    // Foliage-domain factory tools (Wave 3 Task 2) — see foliage-py-tools.ts
    // FOLIAGE_NON_IDEMPOTENT (asset-create / append / delete).
    'foliage_type_create',

Eleven domain lists, all with tests, none with a production caller — the truth
copied by hand and nothing checking the copy. Add a command to a domain list,
forget the master, and it becomes retry-eligible: on a flaky connection the
actor spawns twice, and the second call succeeds, so nothing reports an error.

No drift exists today. `non-idempotent-coverage.test.ts` now pins it, and was
verified by deleting `foliage_scatter_paint` from the master and watching the
failure name the command that would be double-executed. It is a test rather
than a runtime import because the domain modules sit downstream of the
executor; importing them back to fix a bookkeeping problem is the wrong
direction for a cycle.

### 2. Two shipped tools are unreachable — a regression that predates this branch

`hayba_request_input` and `hayba_get_user_response` (issue #11, PR #113 — the
Plan tab's approve / choose_one / choose_many / text / form / progress prompt
system) exist in `tools/prompts/`, carry full `when` / `not_when` metadata, and
have 9 tests each.

**Nothing registers them.** No agent can call either one. The feature is
unreachable from the product.

The original commit added 40 lines to `tools/index.ts` doing exactly this
registration. Those lines did not survive the repo restructure, and
`origin/main` does not have them either — so this is not something this branch
broke, and fixing it fixes it for everyone.

**Deliberately not fixed here.** `tools/index.ts` is the file where the
crash-hardening branch has +255/−105, and the recommended resolution for it is
to take that branch's version and re-apply this branch's smaller edits. A
registration added now is precisely the kind of small edit that gets dropped in
that merge — the work done, then silently lost, which is worse than the current
honest gap.

**So it is queued as merge follow-up work**, and needs re-checking after the
merge lands: add two `defineTool` descriptors for the handlers already exported
from `tools/prompts/hayba-request-input.ts` and
`tools/prompts/hayba-get-user-response.ts`. The handlers need no changes.

### Worth noticing about the method

Nothing here was findable by running the code or by reading a test. Both
defects are absences — a call that does not happen — and a green suite is
exactly what an absence looks like from inside the suite.

### Correction: "most of the 34 are legitimate" was not checked

I wrote that and had verified two. Checking the rest changes the picture, though
not the severity — nothing found is a hazard. The accurate classification:

**Superseded entry points (4).** `registerPyTool`, `registerJsonTool`,
`guardHandlerWithEvidence`, `parseEffectsFromDescription`. Each is an older
door into a module whose *current* door is live and wired. The
response-evidence contract in particular is fully applied — via
`isUnderEvidenceContract` / `withEvidenceWarning` at `register-tool.ts:147`,
not via the `guardHandlerWithEvidence` wrapper the module's own docblock
describes. The docblock is right about the seam and wrong about the function.

I suspected these were a hazard — that `registerPyTool` might bypass the
evidence contract, silently opting any tool registered through it out of the
silent-success protection. It does not: it calls `registerTool`, the same
seam. Worth having checked, and worth recording that the answer was no.

**Per-domain constant lists (11).** Now pinned by
`non-idempotent-coverage.test.ts` — see above.

**An unwired concept (1).** `plumb/junction.ts` defines `junctionType` and the
`JunctionType` union `PORTAL | BOOLEAN_UNION | CLASH` — what happens where a
native and an imperial space meet. Six tests. **Nothing in the product consumes
any of the three values**, so the concept exists only as a tested function.

Not fixed, because wiring it would mean inventing where a junction verdict
belongs in the PLUMB pipeline, and that is a design decision about a headline
feature rather than a gap to close. Flagged for whoever owns PLUMB's roadmap:
either it earns a consumer or it should go, and right now it is neither.

**Genuinely unused, no successor (1).** `awaitEditorResponsive` in
`tcp-client.ts`.

**Deliberate test seams and type-only exports.** The remainder.

Nothing here is deleted. Deleting a superseded factory is safe but churns files
during a pending merge for no behavioural gain, and the two findings that
matter are recorded above rather than tidied away.

---

## Correctness pass (2026-08-25) — eight defects, one shape

Every one of these returned success while doing the wrong thing, or claimed a
protection that was not running. None threw. None failed a test. A green suite
is what each of them looked like from the inside.

| # | Defect | How it presented |
|---|---|---|
| 1 | `python_run`'s two pre-execution crash guards were wired to nothing | the guards existed, were tested, and never ran; only a post-condition rule was live, which reports *after* the deadlock |
| 2 | The self-socket detector matched one idiom of two | `socket.create_connection(...)` — the likelier one — passed straight through |
| 3 | `net_set_replication` resolved by label, first match, then **wrote** | reconfigured an arbitrary actor on a duplicated label, reported ok |
| 4 | `editor_pie_assert` accepted a path **suffix**, first match | asserted against an unrelated actor — a false pass in a test harness |
| 5 | Copilot health check called a non-existent command | `ue_connected` always false, with a healthy editor on the other end |
| 6 | Four Fab tools call commands no handler has ever declared | advertised in the catalogue, `Unknown command` on every call |
| 7 | A misspelled optional parameter was silently dropped | `rotaton` accepted; actor spawned at default rotation; ok returned |
| 8 | `effects` derived from idempotency, not mutation | 29 mutating tools sat outside the evidence contract; no legacy tool ever got the validation nudge |

Six were found by comparing two artifacts that should agree — code against
docs, TypeScript against C++, declaration against implementation — not by
running anything. The other two were found by running the thing and looking at
what came back.

### What is now gated

Three checks were added, each verified by breaking what it guards:

- `docs-command-check` — docs name real CLI subcommands; no doc prescribes the
  MCP entry name without saying the name is arbitrary; the handler count in
  RELIABILITY matches the C++ (and fails loudly if the sentence is reworded so
  the number stops being checked).
- `declared-command-check` — all 228 commands a handler declares are
  implemented. Two dispatch without naming themselves and are allowlisted with
  the verified reason.
- `non-idempotent-coverage.test.ts` — every per-domain retry list is contained
  in the master set, so a command added to one and forgotten in the other
  cannot become retry-eligible.

### Checked and clean

Worth recording so nobody re-runs them: catalogue health (473 descriptors — no
duplicate names, no missing `returns`, no blank descriptions); every local
actor-resolution helper in the handlers (the two that guessed are fixed, the
rest resolve on unique identifiers or already count matches); and
`registerPyTool` does **not** bypass the evidence contract, which was a
hypothesis worth disproving.

### Must be re-checked after the branch merge

All three touch files where the crash-hardening branch has large changes, so
"take theirs and re-apply ours" can drop them silently — they compile and pass
tests when missing:

1. `python_run` must still be registered against the **validated** handler
   (`tools/index.ts`), or defect 1 returns.
2. `hayba_request_input` / `hayba_get_user_response` still need registering —
   built, tested, unreachable, and absent from `main` too.
3. The Fab tools' honest-failure path, and the decision on whether they should
   remain in the catalogue at all.

---

## The merge, hunk by hunk — and a correction to the advice above (2026-08-25)

The sizing above measured how much each side changed each FILE and concluded
"this branch is the small side in seven of eight, so take theirs and re-apply
ours." **Reading the actual hunks says something different, and in places the
opposite.**

Total file churn is not the same as conflicting content. `tools/index.ts` shows
+255/−105 on the hardening branch, which is why it was treated as the most
dangerous file in the tree — but git auto-merges nearly all of it. **Its only
conflict is a single tool-description string.** Meanwhile `RenderHandler.cpp`
looked like theirs-dominant at +223/−279, and both of its conflict hunks are
*ours-only*: our side has content, theirs is empty.

### Per-file resolution

| File | Hunks | Resolution |
|---|---|---|
| `tools/index.ts` | 1 | **Trivial.** One tool `description` string, reworded and reflowed. Pick either; ours names the return as a "PLACEMENT PLAN", which is more specific. |
| `code-mode/list-tool-categories.ts` | 1 | **Cosmetic.** Same data; theirs reflowed it multi-line, ours is compact and carries a comment recording that `blueprint_add_event` was wrongly hidden from agents. Take ours, then diff the command arrays to confirm neither side added a command. |
| `python-run-validator-wrap.ts` | 2 | **Combine, mechanically.** Ours renamed `context` → `data` and added `category`; theirs kept `context` but added `policy_code`, `matched_rule`, `retry_unchanged`. Our field names, their content. |
| `validator/rules.ts` | 1 | **Take theirs.** Ours is empty; theirs adds a rule (`actor_position_drift_after_user_edit`). Adapt it to the collapsed `Finding` shape — `data`, not `context`. |
| `handlers/HaybaMCPRenderHandler.cpp` | 2 | **Take ours.** Both hunks are ours-only. Ours holds the signal-timeout guard (do not read task-written fields after a timeout) and the PNG dimension check. |
| `handlers/HaybaMCPPhysicsHandler.cpp` | 1 | **Take ours.** Ours is the ambiguity-checked `FindActorOrAmbiguityError`; theirs is the older first-match `FindActorByName`. |
| `handlers/HaybaMCPDataAssetHandler.cpp` | 2 | **Genuinely both.** Ours makes a failed save truthful; theirs adds a bounded reflection readback (`ReflectPropertyValueBounded`). Neither subsumes the other. See the design question below. |
| `HaybaMCPCommandHandler.cpp` | 3 | **Mostly theirs.** Two hunks are pure additions from their side (13 and 70 lines); the third is mixed. Keep our `UIBridgeHandler` extraction — taking theirs wholesale resurrects the three retired inline router commands and gives the router two paths to one handler. |

So it is **four files taking ours or trivially either way, two taking theirs,
and two needing real thought** — not "seven of eight take theirs".

### The one real design question

Unchanged from above: both branches took the merge base's honest save-reporting
in opposite directions. Ours treats a failed save as a caveat on success
(`ok:true`, `saved:false`, one plain-English note); theirs treats an unverified
save as a failure and publishes a six-flag provenance chain. Recommendation
stands — their rigour, our wire economy: compute the trustworthy verdict as
they do, publish `ok` plus one `error` naming the link that broke.

### What this changes about the queued follow-ups

The three items listed as "must be re-checked after the merge" were deferred
partly because `tools/index.ts` looked too dangerous to touch. It is not: one
description-string conflict. **Registering `hayba_request_input` /
`hayba_get_user_response` there, and the `python_run` validated-handler swap,
are at low risk of being lost.** They still need verifying after the merge —
anything can be dropped by a careless resolution — but the caution that
deferred them was based on a number that did not mean what I took it to mean.

### Method note

Three readings of this merge have now been wrong: "the renames will collide"
(they collide with nothing), "both sides are right, keep both" (true for one
file of eight), and "take theirs, this branch is the small side" (backwards for
three files). Each came from measuring something cheap — file names, line
counts — instead of reading the conflicting text. The hunks took one script and
about ten minutes.

---

## Correction: the two prompt tools should NOT be registered (2026-08-25)

Recorded above as finding #2 of the orphan survey — "two shipped tools are
unreachable… the registration did not survive the repo restructure… fixing it
fixes it for everyone" — and queued as merge follow-up work. **That was wrong,
and acting on it would have made things worse.**

`hayba_request_input` and `hayba_get_user_response` send the wire commands
`hayba_request_input` / `hayba_get_user_response` to the editor. Those commands
do not exist:

    grep -rn "hayba_request_input|hayba_get_user_response" unreal/…/Private/  -> nothing
    grep -rn "request_input|user_response|prompt_id"       unreal/…/          -> nothing
    git log --all -S "hayba_request_input" -- "*.cpp" "*.h"                   -> nothing

The plugin half was never written, in any branch, at any point in history.
`HaybaMCPPlanPanel` has no prompt or response surface, and no `plan_*` command
appears in the generated capability list.

So the TypeScript tools are one half of a feature whose other half does not
exist. **Being unregistered is the correct state**, not a regression: they
cannot work, and registering them would put two more tools in the catalogue
that answer `Unknown command` — precisely the Fab situation criticised
elsewhere in this document. The right comparison is not "a registration was
lost" but "this is the Fab pattern, found a second time".

### What actually follows

- **Do not register them** during or after the merge. Remove that item from the
  follow-up list.
- The real question is the same one the Fab tools raise: whether TypeScript
  halves of unbuilt features should live in the tree at all. Both sets are
  written, tested, and inert. Deleting them, or building the plugin side, are
  both defensible; leaving them registered is not, and only Fab is registered.
- The `python_run` validated-handler swap remains a genuine follow-up. That one
  fixes a guard that exists on both sides and was simply not wired.

### Why the first reading was wrong

I checked that the registration had once existed (it had — 40 lines in an
older `tools/index.ts`) and inferred the feature had been complete and then
broken. I never checked whether the commands those tools call exist. The
evidence for "shipped feature, lost registration" and for "TypeScript-only
half, never finishable" looks identical from the registration side alone; only
the C++ distinguishes them, and it was one grep away.

---

## A pre-existing UI test failure, diagnosed but not fixed (2026-08-25)

Running the UE automation suite — which nothing on this branch had done —
found **2 failures out of 38**. Both are `Hayba.MCP.UI.Replace.*`. They are
**not** caused by this branch: `HaybaMCPUIHandler.cpp` and its test are
byte-identical to the merge base (`git diff --quiet f0bb8369 HEAD -- …` passes).

    Ensure condition failed:
      WidgetBP->WidgetVariableNameToGuidMap.Contains(Widget->GetFName())
      [WidgetBlueprintCompiler.cpp:781]
    Widget [HaybaMCP_Replaced_0] was added but did not get a GUID

### What is established

UMG's compiler requires every widget it walks to have an entry in
`WidgetVariableNameToGuidMap`. `ui_mutate_tree replace` renames the outgoing
widget to a scratch name (`HaybaMCP_Replaced_N`, UIHandler.cpp:2147) so the
replacement can take the original name, moves or drops its GUID, and then calls
`WidgetTree->RemoveWidget(Widget)`. Something still walks that discarded widget
at compile time, and it no longer has a GUID under its scratch name.

**One real fixture bug was found and fixed** along the way: the test built
`CollisionTarget` with `ConstructWidget` (which leaves `bIsVariable` true) and
registered GUIDs for its three other widgets but not that one — so the fixture
failed the compile it was setting up. That is committed; the failing widget
name moved from `CollisionTarget` to `HaybaMCP_Replaced_0`, which is how we
know it was a genuine second cause and not the same one.

### What was tried and REVERTED

Two handler changes, both reverted because neither fixed the failure and both
rested on a diagnosis that turned out wrong:

1. Registering the incoming widget when `preserve_guid` found nothing to carry.
2. Clearing `bIsVariable` on the outgoing widget once its GUID was taken.

Each is defensible on its own terms, and shipping unverified behaviour changes
to a 4,000-line handler on the strength of a wrong diagnosis is not. If either
is wanted later it should arrive with a test that fails without it.

### The next hypothesis, untested

`RemoveWidget` detaches a widget from its parent but does not change its
`Outer`. If the compiler enumerates widgets via `GetObjectsWithOuter(WidgetTree)`
rather than by walking from the root, a detached-but-still-outered widget is
still visited — which would explain why renaming, detaching, and clearing
`bIsVariable` all failed to help. The fix in that case is to move the discarded
widget out of the tree's ownership entirely:

    Widget->Rename(nullptr, GetTransientPackage(), REN_DontCreateRedirectors | REN_DoNotDirty);

Unverified. Confirm how UE 5.8's `WidgetBlueprintCompiler` enumerates widgets
before acting on it.

### Worth noting for whoever picks this up

Each attempt costs a full close-editor → rebuild → relaunch → run cycle of
several minutes, which is why three guesses is where this stopped. The suite
takes ~60s once running; `test_run { "filter": "Hayba.MCP" }` then poll
`build_status { job_id }`.

### Severity, settled by reading the engine source

`WidgetBlueprintCompiler.cpp:781` is not a hard failure. The engine **recovers
from it**:

    if (!ensureAlwaysMsgf(WidgetBP->WidgetVariableNameToGuidMap.Contains(Widget->GetFName()),
            TEXT("Widget [%s] was added but did not get a GUID"), *Widget->GetName()))
    {
        WidgetBP->WidgetVariableNameToGuidMap.Add(Widget->GetFName(), FGuid::NewGuid());
    }

The missing entry is filled in with a fresh GUID and compilation continues. So
the user-visible consequence is not a broken blueprint or a lost binding — it
is an `ensureAlways` firing, which the automation harness reports as a test
failure because ensures are errors under test.

Two things follow:

- **This is a test-visible defect, not a data-loss one.** It should be fixed
  because a permanently-red test trains people to ignore the suite, not
  because `ui_mutate_tree replace` is corrupting assets. Nothing observed
  suggests it is.
- **The `bIsVariable` theory was disproven here, not just unconfirmed.** The
  ensure sits inside `ForEachSourceWidget` and does not consult `bIsVariable`
  at all, so clearing that flag could never have silenced it. Reverting that
  change was right for a better reason than "it did not work".

The remaining question is unchanged and still unanswered: what does
`ForEachSourceWidget` enumerate, such that a widget passed to
`WidgetTree->RemoveWidget` is still visited? The installed engine headers under
`UE_5.8/Engine/Source/Editor/UMGEditor/Public/WidgetBlueprint.h` do not declare
it (383 lines, no `WidgetTree`, no `ForEachSourceWidget`), so it is inherited
from a base class elsewhere. Answer that before writing another fix.
