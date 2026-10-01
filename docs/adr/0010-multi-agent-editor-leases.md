# 0010 — Several agents share one editor through leases, not a lock on the game thread

Status: **Proposed**
Date: 2026-09-27

## Context

Hayba was built for one agent per editor. Several agents now drive the same
editor at once (a terrain agent, a foliage agent, a verifier), and the plugin
had no idea they were different callers:

- Every connection's reader thread feeds **one** global FIFO
  (`PendingCommands`). A game-thread ticker drains up to 4 commands / 8 ms per
  tick. `ProcessCommand` never knew which connection sent a command.
- Nothing serialized a **multi-step sequence**. Agent A's "unload region, edit,
  save" could interleave with agent B's "load level".
- Plan-Mode approval was **one global flag**: whichever agent sent the next
  destructive command spent the Approve the user gave to someone else.
- The Node client forgets a request on timeout, and `python_run` was not in
  `NON_IDEMPOTENT`, so a slow script was **sent twice**.

The crash that forced this: a `python_run` unloaded World Partition actors
inside Hayba's global `BeginTransaction`. `UTransBuffer::Reset` then reported a
non-zero active count and the next tick crashed in Landscape.

Blocking was never an option. The game thread is the only thread that can run
editor commands; if it waits on a lock, every agent waits, including the one
that holds the lock and needs a tick to finish.

## Decision

**Coordination is by lease: a time-limited, owner-scoped claim on named
resources that the editor checks but never waits on.**

### Callers have an identity

The TCP envelope gains two optional fields, both back-compatible:

- `owner` — which agent is calling. The Node client sends `HAYBA_AGENT_ID`, or
  a per-process id. An envelope without one gets `conn:<id>` (one owner per
  connection); an in-process call gets `local`.
- `lease` — a held `lease_id`. The command then acts as that lease's owner,
  so a lease can be handed to a helper process.

Each connection has a `ConnId`, carried with every pending command. Reader
threads report a closed connection through an MPSC queue that the game-thread
drain hands to the router.

### Commands have an access class

`HaybaMCPAccessPolicy.h` (pure, no editor) classifies every command:

| Class       | Meaning                                                                                                      | Locks it needs                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Read        | reads state; only commands in the R12 read sets (`HaybaMCPCommandSets.h`: control plane, reads, PIE observation, `lease_*`) | none                                               |
| WriteScoped | changes something inside one world; every command outside the read sets (fail closed); PIE drive commands   | X on declared resources, else only IX on the world |
| WriteWorld  | `level_save`, `editor_save*`, `wp_load_cell`, a World Partition python script, an undeclared python mutation | X on `world:<current>`; an undeclared non-WP `python_run`: X on `global` |
| Global      | `level_load`, `level_create`, PIE start/stop, save-and-quit, console commands, Live Coding                    | X on `global`                                      |

`python_run` is classified per request: a World Partition script is
WriteWorld whatever it declares; declared `resources` make it WriteScoped on
those claims; `read_only: true` makes it Read; anything else is an undeclared
mutation and takes X on `global` for conflicts, so it meets any other owner's
lock, including an `asset:` build lease. The lexical tier classifier no
longer decides the class: it misses real writers. The Node server's
Python-backed read tools declare `read_only` themselves
(`PyToolDescriptor.readOnly`, a reviewed list), so they keep working while
another owner holds a lease; a tool that does not declare it is a write.

### Resources form a hierarchy with intent locks

```
global
├── world:<package>
│   ├── wp-region:<package>:<minX>,<minY>,<maxX>,<maxY>   (AABB, XY)
│   └── actor:<object path>
├── asset:<path>
└── pie
```

A claim takes S or X on its node and IS or IX on every ancestor (standard
multi-granularity locking). Two regions of one world whose AABBs overlap are
compared as one node; regions that only share an edge do not overlap. Assets
and PIE sit directly under global: an asset is not inside a world.

An undeclared WriteScoped command takes only IX on its world, so scoped
writers do not exclude each other, but they do collide with anyone holding
the whole world or everything. The exception is a command that writes one
asset named in its own request (`AssetWriteCommands`: Blueprint graph and
Widget Blueprint authoring, including their compile-and-save): it takes X on
`asset:<package>` of that field, so two agents editing one asset collide and
a world or region lease does not block it. The same `asset:` X lock is how a
build marks its assets busy (`asset_busy`, ADR-0012).

### The lease table never blocks

`HaybaMCPLeasePolicy.h` is a pure table with an injected clock.
`lease_acquire` answers either:

- **granted** — a `lease_id`, the expiry, the resources; or
- **queued** — a ticket, the position, the blocking holder's owner, an ETA
  (the blocking holders' remaining TTL) and a poll hint.

The caller polls by calling `lease_acquire` again with its ticket. A ticket
not polled for 30 s is dropped, so a crashed agent cannot hold the queue.
TTL defaults to 120 s, max 900 s. The Node `LeaseKeeper` renews every
`max(1 s, min(ttl, grace) / 3)`, 20 s at the defaults. With `bind_connection`
(the default) a closed connection **orphans** its leases: they keep their
locks until the earlier of their existing expiry and `OrphanedAt + 60 s`
(`OrphanGraceSeconds`; never `Now + 60`, so nothing slides an orphan forward)
and are then dropped, unless their owner revives them with an explicit `lease_renew` (by `lease_id`, or `lease_renew {}`
for every lease it holds), which re-binds them to the renewing connection.
The connection's queued tickets are dropped at once. A TCP server restart
orphans every bound lease. Re-acquiring the same active, non-yieldable claims with the same owner,
label and binding returns the same `lease_id` (`reused: true`). A command
that passes every gate and uses a lock its owner holds slides that lease's
expiry forward (touch-on-use); reads, status polls and refused commands never
do. `lease_release {all: true}` releases every lease and ticket of the caller.

The queue has two lanes. **Interactive** requests overtake **long** ones, but
a long waiter that has been overtaken K times (3) or has waited T seconds (60)
is aged, and nothing that arrives after it may overtake it any more. An owner
never conflicts with itself.

### Lease ids

A lease is named by its `lease_id`: `ls_<seq>_<mac12>`, and a queued request
by its ticket, `lq_<seq>_<mac12>`. `mac12` is the first 12 lowercase hex
characters of HMAC-SHA1, keyed by a 32-hex salt drawn once per editor session,
over `"<prefix>:<seq>"`. The salt never appears in an id, so one holder cannot
derive another's. The table lives in memory, so ids never outlive the session.

The name is the fix, not an allowlist. The handle used to be called `token`,
and both redaction layers (the editor's `RedactFinalEnvelope` and the Node
server's MCP-result redaction) erase any value under a secret-shaped key, so
every client received `[REDACTED:token]` and every renew, release and batch
failed. The redaction code is unchanged. The lease and batch protocol follows
three rules instead, pinned by `Hayba.MCP.Lease.IdSurvivesRedaction`,
`secret-redaction.test.ts` and `lease-wire.test.ts`:

- no lease or batch protocol key ends in a secret word (token, secret,
  password, passwd, pwd, credential, cookie, authorization, or a `*key`
  compound);
- lease and ticket ids use only `[a-z0-9_]`;
- no hint or `next` text contains `token:` or `token=`.

`token` survives only as a deprecated **input** alias on `lease_renew` and
`lease_release`. The reply then carries `deprecation`, and the editor logs one
Warning per command, param and owner (`lease_renew: deprecated param 'token'
from owner 'X'; send lease_id`); that line is the removal metric. A redaction
marker under `lease_id` is refused with `[lease_id_redacted]`. `editor_batch`
takes `lease_id`, or `lease`, which is permanent because it is not
secret-shaped. `ping` reports `capabilities.lease_id: true`; host tools use
leases only when it is set. The Node server seeds its envelope lease only from
`HAYBA_LEASE_ID` and ignores `HAYBA_LEASE` and `HAYBA_LEASE_TOKEN`.

### EnforcedForWrites by default

After authentication, `ProcessCommand` records the caller's presence and then
checks the command's locks against other owners' leases. `LeaseEnforcement`
is read on every check (Project Settings > Hayba MCP Toolkit), so a change
applies at once:

- **Off** — no check.
- **Advisory** — the command runs; the response gains a top-level
  `lease_warning` (the Node client folds it into the tool's data) and the
  editor logs it.
- **EnforcedForWrites** (default; shipped only together with `lease_id`) —
  reads run, and a dead lease handle on a read only warns. A write is refused
  with `lease_conflict` when another owner's lease conflicts (`reason: held`)
  or its envelope names a dead lease (`reason: lease_unknown`), and with
  `owner_required` when it names no owner while other agents are connected.
- **Enforced** — as EnforcedForWrites, and a read that names a dead lease is
  refused too.

Precedence is `owner_missing` > `lease_unknown` > `held`. Only an owner named
in the envelope, or proven by a valid lease handle, counts as present; the
synthetic `conn:<n>` and `local` owners never do, and presence never extends a
lease. A redaction marker in the envelope `lease` counts as absent. Every
lease warning is rate-limited: the first per (reason, owner, command, holder)
per 30 s is logged, the next window's first line says `(+N identical …)`, and
a closed window is summed as `repeated N more times in 30 s`; each response
still carries its own `lease_warning` with `repeats_in_window`.

Write detection fails closed (see the class table). PIE observation commands
are Read; PIE drive commands keep a write class, but a PIE command that the
PIE guard authorizes (a drive command from the PIE's owner, or
`editor_stop_pie` of an agent PIE) skips the lease check, so a lease taken
during the PIE cannot deadlock it. The check refuses or warns; it never grants
and never waits. Rollback is live: set Lease Enforcement to Advisory; the
restart fallback is `Config/DefaultHaybaMCP.ini` with the
`[/Script/HaybaMCPToolkit.HaybaMCPDeveloperSettings]` section and
`LeaseEnforcement=Advisory`.

### What leases unlock

- `python_run deadline_s` above 5 s (max 60) needs an exclusive lease on the
  current world or on global (or `bAllowLongPythonDeadlineWithoutLease`). It
  holds the game thread, so it is refused, not clamped, without one.
- **Plan approval is per owner.** Only the agent that proposed the plan can
  spend the Approve; a different agent's proposal clears a stale approval. A
  plan proposed without an owner keeps the old global rule.

### Cheap wins that did not need leases

- `transaction: false` on any command skips the global editor transaction.
- `python_run` with `world_partition: true`, or a script that visibly uses the
  World Partition loader/unload APIs, always skips it. This removes the crash
  above regardless of leases.
- `python_run` is in `NON_IDEMPOTENT`: never auto-retried after a transport
  failure.

## Consequences

- An agent that wants a safe multi-step sequence asks for it and learns who is
  in the way and for how long, instead of discovering it from a crash.
- Leases are **coordination, not security**. `owner` is self-declared; the
  capability token remains the auth boundary. Tokens are salted and shown only
  to their owner, because an envelope `lease` acts as that owner.
- The table lives in editor memory. An editor restart forgets every lease;
  a TCP-server restart orphans bound leases until their earlier expiry or
  orphan grace limit, unless their owner renews them.
- EnforcedForWrites changes nothing for a single-agent client: with no other
  owner present and no other lease held, nothing is refused. Advisory remains
  the live rollback.
- A command's class is only as good as its table entry. A misspelt entry
  silently falls back to the derived class, so both a native test
  (`Hayba.MCP.Lease.ClassificationDrift`) and a local-gate test
  (`access-policy-drift.test.ts`) check every entry against the real commands.

## Invariants this must not break

- The game thread never waits on a lease.
- Every entry point expires lapsed leases and abandoned tickets before it
  answers.
- The envelope stays back-compatible: `owner` and `lease` are optional, and
  the Node client omits them when empty.
- `lease_*` are never Plan-Mode gated and never in `NON_IDEMPOTENT` (checked in
  `plan-mode-gate.test.ts`): an agent must always be able to queue for, see
  and release a lease.

## Batches and fences (built after the first change)

### `editor_batch`

`editor_batch {lease, steps:[{cmd, params?, fence_after?}], on_error, idle_ticks?, fence_timeout_s?}`
runs several commands under one lease and answers `{job_id}` at once;
`batch_status {job_id}` (or `build_status`) follows it. The state machine is
pure (`HaybaMCPBatchPolicy.h`, `Hayba.MCP.Batch.*`): the driver
(`HaybaMCPBatchHandler.cpp`, an `FTSTicker` job like `test_run`'s) feeds it
the clock, the idle predicate and the lease facts each tick and does the ONE
action it answers.

- **One step per tick**, each through the normal `ProcessCommand` path (auth,
  lease check, Plan gate, transaction, journal). The batch was Plan-gated
  itself, so with Plan Mode on its approval covers its steps and they do not
  spend it again.
- **Fences.** After each step: `idle` (default) waits for N consecutive idle
  ticks (shaders, asset registry, GC or incremental purge, async loading: the
  `wait_for_idle` predicates plus `IsAsyncLoading`); `gc` first calls
  `CollectGarbage`, but only while the batch lease is exclusive on a region,
  a world or global (otherwise it waits for idle and says so); `none` is the
  next tick. A fence that never settles fails its step after
  `fence_timeout_s`.
- **Soft paths.** Step params are stored as text and parsed again for every
  step; no step holds an object across a fence, where GC may collect it.
- **Regions.** `wp_region_load {bounds, name?}` and `wp_region_unload {name?}`
  are steps the batch runs natively with a `UWorldPartitionEditorLoaderAdapter`
  it owns, never inside an editor transaction. Loading needs the lease to hold
  the region exclusively (X on global, the world, or a containing
  `wp-region:`). Every region still loaded when the batch ends, for any
  reason, is released. A global command (map load, PIE, quit) is refused while
  a region is loaded.
- **Errors.** `on_error: stop` halts at the failing step and releases the
  regions. `unload_then_stop` releases them and then runs a settle fence
  (gc when allowed, then idle) before reporting done. A lost lease stops the
  batch the same way. The batch keeps its own lease alive while it runs and
  stops if the lease is released. Its client's connection closing does not
  stop it: the lease is orphaned, the batch's in-process keep-alive renews it
  (which unbinds it), and the batch runs to the end of its step list.

### Fair queue at fences

A batch lease is marked yieldable. At a fence, if a waiter of another owner
that the fence serves (an interactive request, or an aged long one) is
blocked by the batch lease, the batch **yields**: the table stops counting the
batch lease against waiters queued before the fence opened, so their next
poll is granted. Those grants are capped at `FenceGrantMaxSeconds` (30 s)
including renewals. While yielding the batch runs nothing; the let-in owner's
commands do not collide with the parked batch. The batch resumes once the
fence grants are released or lapse, or after a short window (4 s) if nobody
polled. The batch ages too: after 3 yields or 60 s spent yielding it stops
yielding, so a stream of interactive work cannot starve it. A request blocked
by a batch is told so and gets no ETA (a running batch's expiry says nothing).

The TCP drain is unchanged: commands that need no lease still interleave
between batch steps, as they always did, because the batch never holds more
than one tick.

## Next

1. **`wait_for_idle` as a real wait.** It still snapshots the busy predicates
   once. The batch fence now waits across ticks without blocking; the
   standalone command can reuse the same fence (a one-step batch, or a job).
2. **Migrate `editor_gate.py` in the host project.** The proposed version
   ships with the first consumer project's host tools (patch plus tests,
   file-lock fallback kept). Install it when the consumer's editor is
   closed, then move
   `apply_look.py` and `bpgraph.mjs` to one connection per client with the
   `lease` envelope field, then retire the file lock.
3. **Batch cancel.** A running batch stops only on error, lease loss or
   completion. A `batch_cancel` would be a machine input like `bLeaseValid`.
4. **Fair scheduling of the drain itself.** Fences serve lease waiters. The
   drain is still one global FIFO for lease-free commands; it could pick by
   the same lanes if a lease-free flood ever starves an interactive agent.
