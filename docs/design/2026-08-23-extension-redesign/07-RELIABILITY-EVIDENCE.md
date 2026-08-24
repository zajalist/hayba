# R4 — the reliability evidence page (outline)

**The strategic gap:** the loudest product in this field leads with crash
recovery its own documentation does not describe, and tells users to close the
editor and rebuild by hand when C++ breaks. Meanwhile this repo has the
machinery — shipped, in code, with dated incident comments — and **zero public
proof**. Nobody in the Unreal MCP field documents reliability. The first one
to do it credibly owns the word.

This is a writing task, not an engineering one. It is the highest-leverage
non-code work available.

**Policy constraint:** no competitor names, no "vs X" framing. Describe the
capabilities on their own terms and let a reader draw the comparison.

---

## Structure

### 1. The claim, stated narrowly
Not "we never crash" — that is unfalsifiable and reads as marketing. The
honest, defensible claim is: **"An agent-induced fault is contained, recorded,
and recoverable. Your editor keeps serving; your project keeps its undo
history; nothing silently half-happened."**

### 2. The crash-class inventory
What can go wrong when an agent drives an editor, and what each is met with.
Each row cites the real mechanism, because specificity *is* the credibility:

| Failure class | What meets it |
|---|---|
| A handler faults (access violation, engine assert) | SEH guard at the single dispatch seam — all 33 handlers recoverable in one place; the crash path skips post-processing and reports `bSessionSuspect` |
| A long operation blocks the editor | Async job registry; build/cook/test return `{job_id, status:"running"}` immediately and are polled |
| A destructive op half-applies | Router-owned `GEditor` transactions — commit or cancel keyed on the *payload's* success, not transport success |
| A client disconnects mid-command | Refcounted connection + `bAlive`; a late response never writes a freed socket |
| Task-graph re-entrancy | Ticker-based drain instead of `AsyncTask(GameThread)` |
| A modal dialog appears on the game thread | Asset guard refuses rather than prompts — an invisible total hang, prevented |
| Secrets in transit or at rest | Three independent redaction boundaries; the journal is hash-only by construction |
| Agent-generated Python doing unsafe things | Pre-execution guards refuse known-crasher patterns |

### 3. Reproducible torture tests
The part nobody else can copy quickly. `scripts/test-editor-survival.ps1`
already exists (1,652 lines) — surface it as a published, runnable suite:
what it does, how to run it against your own project, and what a pass looks
like. **Publish the raw output.** An artefact a skeptic can execute beats any
adjective.

### 4. What is NOT covered — stated plainly
The section that makes the rest believable. Name the honest limits: the open
hardening items, the operations that still block the game thread pending R2,
the fact that some engine asserts are unrecoverable by design. A reliability
page that claims total coverage is read as marketing; one that names its edges
is read as engineering.

### 5. Before/after evidence
Screenshots and numbers from work already done — the freeze fixes (idle
61s → 0.3s, render 30s → 5ms), the plan-gate audit (7 → 56 destructive
commands actually gated), the SEH coverage change (2 handlers → all 33).

---

## Where it lives
- `docs/RELIABILITY.md` in-repo (the canonical version).
- A section on the website once P3a's screenshots exist.
- Its claims are testable by a reader; anything that isn't gets cut.

## Preconditions
- **R2 first, ideally.** Publishing a reliability page while
  `RenderHandler.cpp:280` still sleeps on the game thread means either
  omitting a known hole or documenting it as open. Better: fix it, then
  publish. If timing forces publication first, §4 carries it honestly.
- F7's `CAPABILITIES.md` gives the companion "what it does" to this page's
  "what happens when it goes wrong".

## Definition of done
Every claim on the page maps to a file, a test, or a published number. No
adjective survives that a reader cannot verify.
