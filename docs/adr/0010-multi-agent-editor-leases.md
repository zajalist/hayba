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
- `lease` — a held lease token. The command then acts as that lease's owner,
  so a lease can be handed to a helper process.

Each connection has a `ConnId`, carried with every pending command. Reader
threads report a closed connection through an MPSC queue that the game-thread
drain hands to the router.

### Commands have an access class

`HaybaMCPAccessPolicy.h` (pure, no editor) classifies every command:

| Class       | Meaning                                                                                                      | Locks it needs                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Read        | reads state                                                                                                  | none                                               |
| WriteScoped | changes something inside one world; default for every Plan-Mode destructive command                          | X on declared resources, else only IX on the world |
| WriteWorld  | `level_save`, `editor_save*`, `wp_load_cell`, a World Partition python script, an undeclared python mutation | X on `world:<current>`                             |
| Global      | `level_load`, `level_create`, `editor_pie_*`, PIE start/stop, save-and-quit, console commands, Live Coding   | X on `global`                                      |

`python_run` is classified per request: a World Partition script is
WriteWorld whatever its tier; declared `resources` make it WriteScoped; a
read-only tier with nothing declared is Read. The tier classifier is lexical
and weak, so declaring resources is the reliable way to ask for less.

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
the whole world or everything.

### The lease table never blocks

`HaybaMCPLeasePolicy.h` is a pure table with an injected clock.
`lease_acquire` answers either:

- **granted** — a token, the expiry, the resources; or
- **queued** — a ticket, the position, the blocking holder's owner, an ETA
  (the blocking holders' remaining TTL) and a poll hint.

The caller polls by calling `lease_acquire` again with its ticket. A ticket
not polled for 30 s is dropped, so a crashed agent cannot hold the queue.
TTL defaults to 120 s, max 900 s; the Node `LeaseKeeper` renews at a third of
the TTL. With `bind_connection` (the default) a closed connection releases
everything it held or queued.

The queue has two lanes. **Interactive** requests overtake **long** ones, but
a long waiter that has been overtaken K times (3) or has waited T seconds (60)
is aged, and nothing that arrives after it may overtake it any more. An owner
never conflicts with itself.

### Enforcement is a setting, advisory by default

After authentication, `ProcessCommand` checks the command's locks against
other owners' leases. `LeaseEnforcement`:

- **Off** — no check.
- **Advisory** (default) — the command runs; the response gains a top-level
  `lease_warning` (the Node client folds it into the tool's data) and the
  editor logs it.
- **Enforced** — the command is refused with `code: "lease_conflict"` and the
  conflict facts under `lease`.

The check refuses or warns; it never grants and never waits. Commands from an
agent that never acquires a lease are unaffected until someone else holds one.

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
  a TCP-server restart keeps them until their TTL.
- Advisory mode changes nothing for existing single-agent clients except a
  possible `lease_warning`. Turning on Enforced is a per-project choice.
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

## Next

Not built in this change, in the order they depend on each other:

1. **`editor_batch` with fences.** One request carrying several commands under
   one lease, executed in order on the game thread with a fence between steps.
   A fence is where the editor may tick (GC, streaming, shader compile) and
   where other owners' work may run.
2. **Native `wp_region_load` / `wp_region_unload`.** Typed commands that take
   `wp-region:` resources directly, so World Partition work stops going through
   `python_run` and its lexical detection, and the region lock is exactly the
   loaded area.
3. **Fair-queue scheduling at fences.** Today the fair queue orders lease
   grants only. At a fence the drain could pick the next command by the same
   lanes and aging, instead of the single global FIFO, so one agent's long
   batch cannot starve another agent's interactive command.
4. **Migrate `editor_gate.py`.** Host projects use this script (outside this
   repo) so agents take turns in the editor. Move its callers to
   `lease_acquire` on the resources it protects, then retire it.
5. **`wait_for_idle` as a real wait.** It snapshots busy predicates once today;
   combined with fences it can wait across ticks without blocking the game
   thread.
