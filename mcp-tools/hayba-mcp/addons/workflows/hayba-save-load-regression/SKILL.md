---
name: hayba-save-load-regression
description: Use when checking that a project-defined game save restores one concrete piece of player progress after a clean restart.
metadata:
  category: qa
  tags: savegame, persistence, regression, pie
---

# Test one game-save round trip

## When to use

Use for one user-visible state such as checkpoint, inventory item, or objective completion. Identify the project's save slot and UI or input path, a disposable test profile, and the exact value expected after reload. Hayba has no generic SaveGame editor; do not invent a save operation.

## Tool routing

- Search test_list for a project persistence test, run a focused candidate with test_run, and inspect test_get_log. If the game exposes a known save/load action, use editor_get_state before editor_start_pie, then trigger the action with editor_pie_press_key or editor_pie_click_widget after confirming it in editor_pie_widget_tree.
- Observe the state with editor_pie_actor_inspect or one-shot editor_pie_assert. End the session with editor_stop_pie. Start a fresh PIE session, invoke the game's load path, and observe the same state again. Poll editor_pie_wait_for in separate calls only if restoration is asynchronous; a single polling response is not a wait.
- Use an isolated test slot. If the save path or state is not visible through Hayba's tools, run the project's automated test or inspect it manually in Unreal and record that limitation. Never test against a player's real save without authorization.

## Evidence

Report slot identity, pre-save state, save action and confirmation, fresh-session loaded state, test results, warnings, and unverified fields. A value that survives within one PIE session does not prove disk persistence or behavior after a process restart.
