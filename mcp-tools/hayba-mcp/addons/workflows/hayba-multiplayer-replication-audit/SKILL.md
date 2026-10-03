---
name: hayba-multiplayer-replication-audit
description: Use when a replicated actor behaves differently for host and client and the editor state, network flags, and multi-client observations need checking.
metadata:
  category: multiplayer
  tags: replication, authority, client, pie
---

# Audit one replicated interaction

## When to use

Use for one actor and one state transition, such as pickup ownership or a door opening. Define which side has authority, what each client should see, expected update latency, and the project's network budget. A single-player PIE run cannot answer a multiplayer question.

## Tool routing

- Inspect the exact actor with actor_inspect and actor_get_properties. Read get_tool_signature for net_set_replication and change only a confirmed flag on an authorized map; this edits the level. Read the flag back, then save the exact active map with level_save if the edit is accepted. Inspect saved, dirty, and verified status and re-read the flag after saving. If persistence is uncertain, mark the flag change unsaved and route it to hayba-world-save-integrity.
- Use editor_get_state before a configured multi-client PIE session. If this workflow starts editor_start_pie, always call editor_stop_pie afterward. Compare editor_pie_actor_list and editor_pie_actor_inspect for the host and each relevant client instance, using their explicit instance selectors. Trigger the event once through the supported PIE input tools, then observe both sides.
- net_debug can enable a viewport stat overlay; capture it with editor_pie_screenshot if useful. Its command reply only confirms the overlay request. If the available PIE configuration exposes just one world, arrange a manual multi-client session and do not infer replication from the editor actor.

## Evidence

Report level and actor, before/after replication flags, authority and client observations, event timing, overlay or log evidence, and unresolved warnings. Flags and matching final transforms do not prove correct ownership, bandwidth, prediction, or late-join behavior; measure those separately against project targets.
