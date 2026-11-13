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
| MCP source suite | 298 suites; 3,770 passed, one existing skipped test |
| Final Chooser/Fab/validation follow-up | 50 passed after the final Chooser preflight change |
| Server build / TypeScript | Passed |
| Production dependency policy | Passed; zero findings, errors or warnings |
| Installer unit/boundary tests | Two passed |
| Actual-source Chromium UI checks | Three passed; markup, streaming, approvals, selection, responsive layout, history, diagnostics, Fab, revision recovery and truncation |
| Independent transport/Fab review | Two defects reproduced and fixed; no remaining blocker in reviewed scope |
| Real UE Chooser API probe | 23 assertions, exit 0, zero engine errors/warnings; no residual Content files or dirty packages |

The Chooser probe executed the descriptor's generated Python against real UE
objects. It did not route through an MCP client. Provider billing/generation,
live Fab account search/import and a user's game-specific PIE session have not
been exercised by these gates. Ten moderate development-only dependency findings
remain in the lint dependency chain; no forced breaking downgrade was applied.

Native automation, optional-Fab load checks, survival results and final installer
hashes are recorded below once their exact artifact completes verification.

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
