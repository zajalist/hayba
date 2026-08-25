# Reliability

An AI agent driving an editor is a program you did not write, issuing commands
you did not review, against a project you cannot afford to lose. This page is
about what happens when one of those commands goes wrong.

**The claim, stated narrowly.** Not "it never crashes" — that is unfalsifiable
and reads as marketing. What is defensible: *an agent-induced fault is
contained, recorded, and recoverable. The editor keeps serving, the project
keeps its undo history, and nothing silently half-happens.*

Every row below names the mechanism, because specificity is the only thing that
makes a page like this worth reading. Where something is not covered, it says
so — that section is at the bottom and it is not short.

---

## What can go wrong, and what meets it

| Failure | What meets it |
|---|---|
| A handler faults — access violation, engine assert | A structured-exception guard at the single dispatch seam, so every handler is covered in one place rather than once each — the 33 registered by the core module, plus any satellite plugin that registers its own, since those route through the same seam. The crash path deliberately **skips post-processing**: a comment there records the 2026-08-09 incident where the "keep going" path double-faulted while hashing the very parameters that caused the first fault. |
| A destructive op half-applies | The router opens a `GEditor` transaction around dispatch and keys the outcome on the **payload's** success, not the transport's: `EndTransaction` when the handler reports ok, `CancelTransaction` when it does not — so a failure leaves no empty undo entry — and `CancelTransaction` on the crash path too. Ctrl+Z reverts an agent's work like your own. |
| A long operation blocks the editor | An async job registry. `build_*` and `test_run` return `{job_id, status:"running"}` immediately and are polled with `build_status`; `wait_for_idle` runs on a ticker. Both were converted precisely because a blocked game thread cannot tick, so the thing being waited for can never finish. |
| A client disconnects mid-command | The read loop flags the connection dead rather than tearing it down; the socket is owned by a shared reference held by both the read loop and any queued game-thread task; and the send path re-checks liveness **under the send mutex**, closing the race between a task's own guard and the read loop. A late response no-ops instead of writing a freed socket. |
| Secrets in transit, at rest, or in a log | Central redaction applied at six enforcement points — the TCP bootstrap, the chat server, the dashboard, the HTTP boundary, the DAG journal and the LLM client. Four dedicated suites hold 24 tests (`secret-redaction`, `bootstrap-redaction`, `chat-server.redaction`, `tool-stream-redaction`), with further redaction assertions inside the LLM-client, journal and dashboard suites. |
| The command journal leaking parameters | It cannot: parameters are stored as a hash, never as text. Hash-only by construction, not by filtering. |
| An agent asking for a destructive command | Plan Mode gates destructive commands behind an approved plan, and the before/after snapshot it shows you refuses to describe an actor whose label is ambiguous rather than describing the wrong one. |
| An ambiguous actor reference | Labels are not unique in Unreal. Resolution returns the unique object name if there is one, and otherwise **refuses** when a label matches several actors, naming the alternatives. Previously the first match won silently — `actor_delete` on a duplicated label destroyed an arbitrary actor and reported success. |
| Agent-written Python doing something unsafe | Pre-execution guards refuse known-crasher patterns outright — connecting to the plugin's own port from inside `python_run` (a game-thread deadlock), and registering a lifetime callback that will be garbage-collected and later broadcast into freed memory. Both refusals happen **before** the script reaches the editor; the validator also carries post-condition rules, but a report after a deadlock is not a guard. |

## Reproducing it

The honest position: there is a process-owned editor-survival suite
(`mcp-tools/hayba-mcp/scripts/test-editor-survival.ps1`, 706 lines) that drives
a real editor and asserts it is still answering afterwards. **It is not on the
same branch as this document at the time of writing**, so this page does not
yet publish its output. Doing so is the intended next step, and until then no
claim on this page rests on it.

What you can run today, against your own project:

```bash
node mcp-tools/hayba-mcp/dist/cli/index.js doctor --project <your.uproject>
```

`doctor` checks the four things that break an install and says what to do about
each. It is not a reliability proof; it is the difference between "it doesn't
work" and knowing why.

## What is NOT covered

This section is the reason to believe the rest.

- **`render_camera` still blocks the game thread.** Its wait phase polls with
  `FPlatformProcess::Sleep` on the game thread, up to a 30-second default. The
  editor is frozen for the duration. It is the last instance of a pattern
  removed everywhere else; fixing it changes the command's contract, so it is
  a decision rather than a patch. It also silently drops `world_tick` from its
  wait set when running inline — reported in the response as
  `skippedWorldTickInline`, because a blocked thread cannot advance the frame
  counter it is waiting on.
- **Some engine asserts are unrecoverable by design.** A structured-exception
  guard catches faults at the dispatch seam. It does not make a `check()`
  failure deep in the engine survivable, and nothing claims it does.
- **Three actor-lookup sites still take the first match, and they are reads
  and UI.** Object names and path names are unique within a level, so a first
  match on either is the only match. Only a *label* is ambiguous, and this
  count covers label lookups alone.

  This entry previously said five sites, and that "the destructive paths
  refuse". One of them did not. `net_set_replication` resolved its target by
  label and then wrote to it — `SetReplicates`, `bAlwaysRelevant`,
  `NetDormancy` — so on a duplicated label it reconfigured an arbitrary actor
  and reported success: the exact bug this page says is closed. It now refuses,
  naming the candidates, like every other destructive path. The claim was
  false when written and is true now.
- **Coverage is one editor, one project.** Everything on this page was verified
  against a live Unreal 5.8 editor on Windows. No claim here has been exercised
  on macOS or Linux, at studio scale, or with multiple concurrent agents.
- **The tool surface is 239 commands.** Of those, 150 are marked
  agent-callable. The remainder are reachable but not described for agents; see
  [CAPABILITIES.md](CAPABILITIES.md), which is generated from the source rather
  than maintained by hand.

## How these claims are kept honest

Four gates run in CI, each because the corresponding claim drifted at least
once:

- the command inventory is regenerated from the C++ that declares commands, and
  the build fails if the committed count drifts;
- every tool named in a shipped prompt or workflow skill must exist — added
  after the agent prompt was found instructing models to "always call" three
  tools that had never been implemented;
- the icon rasters must match their signed masters by content hash;
- the packaged build's data files must exist where the build expects them —
  added after a directory rename broke `npm run build` while every test stayed
  green, because the tests run from source and never touch the packaged layout.
