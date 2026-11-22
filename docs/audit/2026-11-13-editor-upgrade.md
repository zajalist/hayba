# UE 5.9 editor upgrade verification

This development update targets the installed Windows x64 UE **5.9.0 Preview,
CL 60351404**. Exact engine build compatibility is checked by the installer;
these results do not certify every engine build or every project's Play session.

## Changes

- Replace the old semantic World tab with the local HTML chat workspace. Keep
  native authority for credentials, editor actions, approvals and provider calls.
- Search threads and turns, page long transcripts, inspect agent-delegated work,
  and retain drafts/context through connection recovery. Manual subagent task
  creation is removed.
- Transfer changed transcript rows after a negotiated full snapshot. Revision
  gaps request recovery, including a lost thread-switch snapshot. Selection and
  the reader's position survive updates; shrinking history clamps the page.
- Add read-only editor diagnostics, optional Fab catalog/library search, a native
  Fab opener, and attachment of imported Content Browser selections. Fab owns
  account, license, purchase and Add to Project actions.
- Add bounded Chooser inspection and truthful, bounded asset validation. Correct
  PCG read leases, Python method classification and the native health command.
- Package a portable project installer with bundled Node/MCP dependencies and
  optional Claude configuration, backups and rollback.

Transcript updates reduce bridge bandwidth and keep the DOM to 80 messages.
Native projection/row serialization and the browser's message-array copy remain
linear in retained history. This is not constant-time streaming or disk-backed
history virtualization.

## Verification before native packaging

| Gate | Result |
|---|---|
| MCP source suite | 298 passed suites and one skipped suite; 3,779 passed tests, one existing skipped test |
| Final Chooser boundary follow-up | 26 passed, including maximum-page Unicode output and the 48 KiB byte budget |
| Server build / TypeScript | Passed |
| Production dependency policy | Passed; zero findings, errors or warnings |
| Installer unit/boundary tests | Two passed |
| Actual-source Chromium UI checks | Three passed; markup, streaming, approvals, selection, responsive layout, history, diagnostics, Fab, revision recovery and truncation |
| Independent transport/Fab review | Two defects reproduced and fixed; no remaining blocker in reviewed scope |
| Real UE Chooser API probe | 23 assertions, exit 0, zero engine errors/warnings; no residual Content files or dirty packages |
| Focused native UE automation | 45 tests passed, exit 0; 44 clean and one expected warning in negative sidecar-identity cases |
| Fab optional dependency | Macro-disabled compilation without Fab headers passes; final DLL has no Fab DLL import and loads with Fab disabled |
| MCP catalogue schemas | All 455 schemas serialize; two regression tests plus 51 existing Niagara/Foliage boundary tests pass |
| Session-file boundary follow-up | 36 tests pass; explicit normalized containment supplements the existing ID allowlist |
| Legacy health-wrapper metadata | Wrapper lint passes; 209 related tests pass |
| Final MCP-to-Unreal wire gate | 14 assertions pass; real stdio client, complete catalogue, Plan Mode refusal, forged-script rejection, Chooser pagination/errors and disabled-Fab response; client/editor exit 0 |

The initial Chooser API probe executed generated Python against real UE objects;
it did not establish MCP routing. Subsequent real MCP checks exposed and corrected
two integration problems: generic Python requires exact review even when labelled
read-only, and generic response shaping clipped the new inspector's JSON. The
dedicated native read command accepts only asset/page data and invokes a fixed
bundled inspector. Arbitrary caller Python remains gated. The router preserves
bounded structured stdout, and the inspector returns a short error above 48 KiB
of ASCII JSON instead of emitting a torn page. Maximum page dimensions are work
limits, not a promise that every text-heavy page fits the response budget.

Provider billing/generation, live Fab account search/import and a user's
game-specific PIE session have not been exercised by these gates. Ten moderate
development-only dependency findings remain in the lint dependency chain; no
forced breaking downgrade was applied. Touched-file lint had zero errors and
12 warnings; whole-repository lint still has existing debt. The CI lint/format
job is an advisory signal, not proof of a warning-free repository.

The final native DLL is SHA256
`b5aaeeb3f327a3d9c0767939a74b725c9b372f03083b85808632739dc59cea7f`,
built from native source commit `28686520d708d29e32e2314843b8349088b3f191`.
The final build covers 39 changed translation units. All 437 copied native
source/resource/config/descriptor hashes match the source tree. The expected
warning is the sidecar-identity test deliberately probing unavailable endpoints;
the corrected run contains no ensure, assertion or fatal error.

Runtime verification caught an invalid abstract-UObject test fixture and stale
allowlist assumptions. The corrected fixture uses real CurveFloat assets and
proves pre-validation budget rejection, exact successful validation counts and
no saves/dirty-state changes. Unsupported/skipped/cancelled outcomes have separate
result-shaping tests. Initial failure evidence is retained, not treated as a
passing run.

A real MCP client also exposed two pre-existing `z.custom<number>` schemas that
could not be published by the current SDK. They now use finite Zod numbers with
the same work limits and error messages. The complete catalogue has a regression
test; no permissive JSON-schema fallback was added. CI's path alert was addressed
at the session filesystem boundary, and the legacy `ping` wrapper metadata now
matches the corrected health route.

The final wire run used the exact DLL above, a real two-row/one-column Chooser
fixture, Plan Mode enabled and sidecar autostart disabled. It read both pages,
rejected arbitrary Python despite `read_only:true`, and rejected a caller script
on the named route. Cleanup restored dirty packages to `[]`, removed the unsaved
fixture, left Content empty and closed both editor and MCP server. Logs contain
no fatal, assertion, ensure, Python error or Zen startup. Optional-domain and
filesystem-DDC setup warnings are not represented as engine failures.

[CI on the final native source commit](https://github.com/zajalist/hayba/actions/runs/43382731978)
passed server typecheck/build/tests, architecture, visual-sidecar and production
dependency checks. [CodeQL](https://github.com/zajalist/hayba/actions/runs/43382731971)
passed its C++, JavaScript/TypeScript and Python analyses.

The final survival gate used that same DLL in an owned D3D12 offscreen editor.
All 35 hostile-input cases and verified graceful cleanup passed (36/0); the
separate one-case canary proved unexpected editor death would fail the ordinary
gate. Real Python nonce execution before/after cases prevents a blanket Plan
Mode refusal from masquerading as survival. The deadline case returned in
5,042 ms. The ordinary editor exited cleanly without forced recovery, crash
artifacts, critical shutdown signatures or Content/config/project changes.
This is a focused survival gate. Seven opt-in acceptance scenarios and optional
satellite-plugin workflows remain outside it; it does not prove every tool or
every project's Play session safe.

## Installer artifact

The development ZIP is `Hayba-Setup-UE5.9-20261113.zip` (102,547,300 bytes),
for Windows x64 UE 5.9.0 Preview build `60351404`. SHA256:
`35647731db6a3b657ad0cce89edeabb4967cf71cfff0900bbd7c377ed4d166f1`.
It contains the exact native DLL above, official-checksum-verified Node 24.14.0,
159 production dependencies and 11,063 payload files. Reading every payload file
back from the compressed ZIP reproduces the manifest's byte counts and hashes.
It is an unsigned development package, not a published release or a universal
UE 5.9 binary. The installer checks the exact engine build before installation.

A fresh CLI installation into a disposable project with spaces in its path
passed, including isolated Claude Code/Desktop configuration. The installed
bundled Node completed a real MCP SDK handshake and listed its seven entry tools.
This small discovery surface is intentional; the complete catalogue remains
available through tool discovery.

The installed plugin then launched its own bundled Node/server process and
passed HTTP identity/protocol/target checks plus a native TCP ping matching the
owned editor PID and project. Verified native save-and-quit returned editor exit
0, removed the Node child and closed both ports. The smoke script itself exited
0, with no fatal/assert/ensure or Zen startup. HTTP's separate TCP client remained
truthfully lazy/disconnected; the direct native ping establishes editor identity,
not an eager HTTP-to-TCP connection.

Intermediate installed-smoke attempts used Windows PowerShell 5 even though the
TCP test helper requires PowerShell 7. Their initial timeout diagnosis was wrong;
the shell incompatibility is recorded and those attempts are not counted as
passes. The corrected harness requires PowerShell 7 and passed its first native
ping without retries. No product change was needed. The delivered ZIP differs
from the fresh-install-tested ZIP only in `START HERE.txt`, clarifying developer
junction handling. Installer code/manifest and every runtime payload hash match.

## Test isolation and known incident

Owned test editors used disposable projects and never opened or modified the
OutOfFrame project. One initial installed-sidecar probe used Unreal's default
DDC setup, which caused Unreal to restart the shared Zen cache with a different
data-directory choice. That attempt is not qualified as isolated. The owned
editor was closed; read-only process inspection later showed Zen owned by the
still-running user editor using its normal LocalAppData cache. The retired Zen
process's complete command line and prior cache contents were not captured, so
exact restoration of its previous cache state is not claimed. No cache directory
was deleted and no Zen process was manually killed or restarted.

Subsequent owned launches explicitly select EnginePak plus an owned filesystem
DDC with `-DDC-NoDefaultGraph`; their logs contain no Zen service startup. No
desktop takeover, user-editor shutdown or live project installation occurred.
The running OutOfFrame installation remains unchanged. Updating its physical
plugin folder replaces the nested developer link with a self-contained copy;
[the installer guide](../windows-installer.md) explains backup and migration.

## Repository cleanup

The upgrade was isolated from the original dirty `foa-main` checkout. Existing
chat/installer work was carried forward; unrelated water/capture edits and other
agents' local configuration were preserved.

All 34 open issues and 15 open pull requests were audited in
[the issue ledger](2026-11-13-issue-triage.md). They were not blanket-closed.
The dependency finding in #443 is corrected in this branch; #454 and #459's
Python/PCG fixes were re-applied with tests. Remaining runtime/security acceptance
is explicit in the ledger rather than being represented as completed cleanup.

Git cleanup pruned 14 already-deleted remote-tracking refs and archived 57 merged
unused local branches plus 50 stale unattached generated agent branches. No
remote branch or unmerged feature work was deleted. Every archived tip can be
restored with:

```sh
git branch <name> refs/archive/20261113/heads/<name>
```

Active worktrees, open-PR branches, release/main branches and unmerged feature
branches remain. Local JSON manifests under `Saved/overnight-audit-20261113`
record the before/after refs, original file hashes and individual test evidence.

## Research

- [Agentic editor UI research](../design/2026-11-12-agentic-editor-research.md)
- [UE 5.9 API research](../design/2026-11-13-ue59-editor-research.md)
- [Fab integration and public API constraints](../design/2026-11-13-fab-integration.md)
- [Baseline and stale compiled-test cleanup](2026-11-13-baseline.md)
- [Installer operation and recovery](../windows-installer.md)
