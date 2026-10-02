# 0012 — PIE is editor state, not a lock; the editor refuses what a play session cannot survive

Status: **Accepted**
Date: 2026-09-28

## Context

Hayba needed to distinguish editor work from Play-in-Editor (PIE) sessions.
Without a shared PIE state, agent mutations could run during Play and an
agent-started session could compile a Blueprint still being built.

- The PIE handler bound its lifecycle hooks lazily, on the first
  `editor_pie_*` command. Agents never sent one, so the hooks were never bound.
- `editor_start_pie` called `RequestPlaySession` unconditionally. Over the
  user's session it ended that session. With a loaded Blueprint in error it
  queued a session that opened a modal dialog on the next tick, and Slate's
  modal loop does not tick `FTSTicker`, so the command drain and every batch
  hung until a human answered.
- `editor_batch` kept running steps and GC fences during PIE, and timed its
  fences against wall time.
- After a contained native fault (ADR-0011) the user's Play button still
  compiled Blueprints and ran garbage collection in the damaged process.

## Decision

**PIE is a state the router checks on every command, not a lock anyone holds.**

### One source of PIE state

`FHaybaMCPEditorState` binds PreBeginPIE, BeginPIE, EndPIE, CancelPIE,
ShutdownPIE and OnSwitchBeginPIEAndSIE in `StartupModule`, before the TCP
server starts and in owned automation children too. The pure `FPieTracker`
gives a session to the agent whose `editor_start_pie` came within 5 s, and
otherwise to the user; a session ends once however many end delegates fire.
`ResolvePie` backstops a missed hook from the play world and the queued
request. It never reads `IsPlayingSessionInEditor`, which can stay set after a
Standalone launch, so `editor_get_state.pie_running` comes from the resolved
state too. A queued request counts as PIE.

### What may run during PIE fails closed

`PieRuleFor` answers Safe for the named control-plane, read and
PIE-observation sets in `HaybaMCPCommandSets.h` (the same sets the unsafe gate
and write detection use) and for `lease_*`; PieOwner for the seven drive
commands and `editor_stop_pie`; Refuse for everything else, including commands
nobody has classified. There is no `during_pie` escape.

- Nobody drives or stops the user's PIE.
- Only the agent that started a PIE drives it. Any caller may stop an agent
  PIE, with a Warning naming both owners: a per-call raw client (`conn:<n>`)
  or a restarted Node server (a new owner) could otherwise never stop its own
  session, and every lane would get `pie_active` until a human pressed Stop.
- A drive command from the owner, or `editor_stop_pie` of an agent PIE, is
  authorized by the PIE state and skips the lease gate. Otherwise a lease
  another owner took during the PIE (`lease_acquire` is PIE-safe) would
  deadlock the PIE's owner.
- The refusal is `pie_active` (retryable, nothing ran), built by the router's
  single refusal builder, and its Warning goes through the rate limiter.

### Never queue a modal

`editor_start_pie` scans loaded Blueprints for the conditions that open a
modal before play (UE 5.8 `PlayLevel.cpp:1313` and `:1498`) and answers
`pie_blocked` with the Blueprints to fix, queueing nothing. `editor_stop_pie`
cancels a request that has not started yet, because `RequestEndPlayMap` acts
only on a running session.

### Batches pause

A running `editor_batch` holds while PIE is running or queued. The pump still
renews its lease, and the machine waits and shifts its fence and yield clocks
by the held span, so a PIE of any length never times a fence out. A new
`editor_batch` is refused during PIE, and PIE steps are rejected at validation.

### The user's Play button

`FHaybaPIEAuthorizer`, an `IPIEAuthorizer` modular feature registered in
`Startup`, denies Play while the editor is unsafe. There is no override: D2
says unsafe refuses PIE. It never greys the button out and never cancels the
request itself: the engine cancels a denied request, and a second cancel
would broadcast CancelPIE twice and reset the request under a live reference.
On UE 5.7 the override is `RequestPIEPermission(bool, FString&)` plus Hayba's
own notification; that branch compiles behind a version guard and is
unverified, because the toolkit does not build on 5.7 today.

## Consequences

- A command that is in no read set is refused during PIE, whatever its name
  suggests. Eighteen read-like commands were classified as reads when this
  was decided (`wait_for_idle`, `wait_for_shaders`, the `*_validate` and
  `*_audit` commands, `mesh_list_dynamic`, `mesh_topology_stats`,
  `metasound_inspect`, `metasound_list`, `pcg_export_graph`,
  `pcg_read_node_output`, `scene_export`, `ui_measure_text` and
  `copilot_get_key`). A new read command must be added to `ReadCommands()`;
  `Hayba.MCP.State.PieSafeDrift` prints what is refused by default.
- A batch holding World Partition regions keeps them loaded through the
  user's Play, which duplicates a heavy world, and its lease keeps renewing
  through a long PIE and keeps blocking conflicting leases.
- A session found only by the backstop reports `pie_since_s` 0.
- Asset builds (`asset_busy`) and the user's Play during another owner's
  build (D7) extend this design; the build veto is recorded in an addendum
  when it lands.

## asset_busy (P0 T3)

A build marks its assets busy by holding `asset:<path>` exclusive leases
(D5). The router checks this in slot 3, after `pie_active` and before the
lease gate, so a PIE start against another owner's build answers
`asset_busy`, not `lease_conflict` (R10).

- `AnyBusyCommands` (`editor_start_pie`, `editor_save_all_and_quit`) are
  refused while **any** owner holds an asset X lock, the caller included, in
  every `LeaseEnforcement` mode except Off. A lane's helpers share one owner,
  so excluding the caller would let a lane play its own half-built Blueprint.
  A tool releases its build leases before it starts PIE.
- `AssetBusyTargets` (the compile and save commands of one asset) are
  refused while **another** owner holds X on that asset, under a refusing mode.
  Under Advisory they run, and the reply carries
  `state_warning {code: "asset_busy", busy}`. A build compiles its own assets.
- The refusal carries `busy {command, caller_owner, assets[]}` and never a
  lease handle. Its Warning line goes through the gate limiter.
  `editor_get_state.building` lists every asset X lock, whatever its label.
- Limits:
  - Before T7, a build lease bound to a socket dies when the server drops that
    socket after 5 s idle, so the builder pings at least every 2 s.
  - After T7, an orphaned build lease keeps `asset_busy` (and refuses
    `editor_start_pie`) for up to 60 s after the builder dies.
- The user's Play button is covered separately (D7, T10).

## Addendum: the Play button during a build (D7, P0 T10)

D7 was approved on 2026-09-28. `FHaybaPIEAuthorizer` gains a build branch next
to the unsafe branch. An `IPIEAuthorizer` runs after `PreBeginPIE` and
before the pre-play Blueprint compile, so it can stop Play from compiling
Blueprints while their assets are being built.

- Any `asset:` X lock is a build (`BuildingAssets()`); the person at the
  editor is never its owner.
- `hayba.PIEBuildVeto` (console, live):
  - `0` notifies only;
  - `1` (default) vetoes, and a second press within 10 s plays;
  - `2` vetoes with no override.
  - Unknown values fail toward the veto.
- Rollback: `hayba.PIEBuildVeto 0`.
- A veto on 5.8 returns `MakeError(FText)` naming the asset, owner and label.
  The engine shows it and cancels the request. Hayba never calls
  `CancelRequestPlaySession`, which would double the `CancelPIE` broadcast
  (the PIE tracker would count two ends) and reset `PlaySessionRequest` while
  `StartPlayInEditorSession` still holds `InRequestParams`. The 5.7 branch
  returns false with `OutReason` and posts Hayba's own notification. It is
  compiled behind the version guard and is unverified.
- The double-press time lives on `FHaybaMCPEditorState`, because the
  authorizer's methods are `const`. Every allowed user Play clears it,
  including mode 0 and Play after a build releases, so a later session
  needs its own double press.
- Agent requests never get the override. They normally never reach the build
  branch, because slot 3 refuses `editor_start_pie` during any build first;
  with `LeaseEnforcement` Off they do, and are vetoed without an override in
  modes 1 and 2.
- Dirty or uncompiled code Blueprints still refuse agent Play before it can
  compile them; the build setting does not bypass that guard.
- The unsafe veto (D2) keeps precedence and has no switch and no override.
