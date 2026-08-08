# 0008 — A satellite plugin has to add capability the always-available surface cannot

**Status:** Accepted (2026-08-08)

## Context

Four optional plugins sat in `unreal/` — `HaybaMCPGAS`, `HaybaMCPMetaSound`,
`HaybaMCPNiagara`, `HaybaMCPSequencer` — each a complete UE module with a
handler, each declaring `EnabledByDefault: true` and its engine dependency.

**None of them were installed anywhere.** `Aphrosia/Plugins/` contained only
`HaybaMCPToolkit` and `PCGExtendedToolkit`, so all 21 of their commands answered
`Unknown command`, while `list_tool_categories` listed every one as a capability
the plugin has but no wrapper reaches. Two issues (#18, #19) read as
"handler not implemented" when the handlers were written and building.

Meanwhile the python/TS tool layer had shipped its own `niagara_*` and `seq_*`
tools. `sequencer-py-tools.ts` says why, in an overlap audit written at the time:
the satellite "may be absent", so the python tools are "the always-available
surface", and their names were chosen deliberately **not** to collide with the
dormant C++ ones — `seq_create` → `seq_new`, `seq_add_track` → `seq_track_add`,
and so on.

So the question was never "do these compile". It was whether a second, optional
implementation of the same operations should exist at all.

## What the evidence said

All four were installed as junctions, built (`Result: Succeeded`, all four DLLs
linked), and every one of the 21 commands was called against a live editor.

| Satellite | Working | Stubs | Duplicates a shipping python tool |
|---|---|---|---|
| GAS | 4 of 4 | 0 | 0 |
| MetaSound | 2 of 6 | 4 | 0 |
| Niagara | 3 of 3 | 0 | **3 of 3** |
| Sequencer | 7 of 8 | 1 | **6 of 8** |

- GAS created a real `UGameplayAbility` and `UGameplayEffect`; its two apply/grant
  commands refused an actor with no `UAbilitySystemComponent`, by name.
- MetaSound's four graph-editing commands all answer
  "pending MetaSoundFrontendDocumentBuilder API stability". Only `list` and
  `create` do anything.
- Niagara's three are `niagara_systems`, `niagara_param_set` and
  `niagara_spawn_transient` under older names.
- Sequencer's unique contribution is exactly **one working command**, `seq_play`.
  Its other unique name, `seq_export`, answers "pending MovieRenderPipeline
  integration" — the same integration `sequencer-py-tools.ts` had already
  deliberately declined to ship, with reasons.

## Decision

**A satellite plugin is justified only by capability the always-available surface
cannot provide.** Duplicating a shipping tool under an older name is not
capability; it is a second copy of one rule, which ADR-0007 exists to stop.

- **`HaybaMCPGAS` — installed and surfaced.** Four commands, no equivalent
  anywhere else. Gameplay Abilities is genuinely optional per project, which is
  exactly what the satellite mechanism is for.
- **`HaybaMCPMetaSound` — installed and surfaced, honestly.** `metasound_list`
  and `metasound_create` are callable. The four stubs are documented via
  `get_tool_signature` but `agent_callable: false`, and are named in
  `no-stub-wrappers.test.ts` so nothing wraps them while they answer nothing.
- **`HaybaMCPNiagara` and `HaybaMCPSequencer` — deleted.** Both are redundant
  with the python surface that was written to survive their absence. Their
  entries are gone from the hand-maintained catalogue, which was reporting 11
  capabilities that did not exist.

`seq_play` is the one thing lost. It is recoverable from git history, and MRQ
playback was already out of scope by an earlier deliberate decision.

## Consequences

- `list_tool_categories` stops naming 11 commands nothing can reach.
- Two projects' worth of dead C++ leave the tree; git history keeps them.
- The satellite mechanism survives with a bar attached: a new one must name a
  capability the python layer cannot reach, or it does not get created.
- **Installing a satellite is now part of the decision, not a later chore.** All
  four of these were written, built and forgotten because nothing failed when
  they were absent — the catalogue simply listed them as unavailable forever.
