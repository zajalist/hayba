---
name: hayba-qa-smoke-test
description: Use when checking a small Unreal gameplay change through available automation, PIE observation, and scene validation before reporting it done.
metadata:
  category: qa
  tags: testing, pie, regression, verification
---

# Smoke test a gameplay change

## When to use

Use after a concrete edit with a known user-facing behavior and likely regression area. Define one success observation and one failure observation before running tests.

## Tool routing

- Discover a relevant automation with `test_list`; run a focused subset through `test_run` and inspect failures with `test_get_log`. Avoid a broad test sweep when one subsystem can answer the question.
- Check `editor_get_state` before PIE. If this workflow starts `editor_start_pie` for a user-visible path, capture it with `editor_pie_screenshot` when visual behavior matters and always call `editor_stop_pie` afterward, including on failure. Leave an already running user PIE session alone. For scene mutations, run `validator_run` as a separate post-condition check after PIE stops.
- Treat a test runner's success as evidence for the assertions it executed. It does not replace a PIE interaction or a visual check when those are the requested behavior.
- If this pass makes an accepted scene repair, read back the changed actor or world state, save the exact active map with `level_save`, and inspect saved, dirty, and verified status. Re-read the edit after saving; if persistence is uncertain, report it as unsaved and route it to hayba-world-save-integrity.

## Evidence

Report test names and result, the PIE action and observed response, screenshot if relevant, validation findings, and remaining untested conditions. If a test could not run, state the reason and leave that verification open.
