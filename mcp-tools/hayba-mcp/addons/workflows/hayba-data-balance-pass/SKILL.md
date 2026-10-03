---
name: hayba-data-balance-pass
description: Use when tuning a scalar Unreal DataAsset value against a stated gameplay target and verifying the saved value and runtime effect.
metadata:
  category: gameplay
  tags: balance, data-assets, tuning, regression
---

# Tune one gameplay value

## When to use

Use when a concrete gameplay metric points to one owned DataAsset value: cooldown, movement speed, damage, range, or similar. Write down the baseline, intended range, test scenario, and any designer constraints before editing. Change one variable at a time so the observed effect has a plausible cause.

## Tool routing

- Read data_get and inspect whether reflection is complete or truncated. Find the exact property and type, then use get_tool_signature for data_set. This writer supports only bounded built-in scalar types; it does not author arrays, structs, text, or object references.
- Call data_set once and inspect its verification, observed value, target re-resolution, and dirty state. If the result is uncertain, re-read the exact asset with data_get before retrying. Save with asset_save only after the readback matches the intended value.
- Exercise the affected behavior in an existing focused test with test_list, test_run, and test_get_log, or use an authorized PIE scenario with editor_get_state, editor_start_pie, one concrete runtime observation through editor_pie_actor_inspect or editor_pie_assert, then editor_stop_pie. A single assertion is one observation; poll separately if state changes over time.

## Evidence

Report asset and property, baseline and saved value, test conditions, before/after gameplay metric, warnings, and unresolved effects. A changed property does not establish balance or causality when other variables changed or no representative play session was measured.
