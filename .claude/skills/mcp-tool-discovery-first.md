---
name: mcp-tool-discovery-first
description: Use when planning ANY UE world mutation. Forces tool discovery (hayba_search_tools → list_tool_categories → hayba_pack_list) BEFORE reaching for python_run. Use whenever the task involves spawning, scattering, painting, importing, sculpting, or any other write to the UE scene.
---

# mcp-tool-discovery-first

`python_run` is the **last resort**, not the first. The MCP toolkit ships ~154 commands across ~30 domains; many have typed TS wrappers, others are reachable through `hayba_invoke` or a pack that simply isn't loaded yet. Reaching for `python_run` before exhausting discovery is how sessions end with crashed editors and undelivered scenes (see `docs/superpowers/specs/2026-05-23-pcg-landscape-mcp-postmortem.md`).

## The ordered flow (do this at every fork)

For any verb — `spawn`, `scatter`, `paint`, `import`, `sculpt`, `bake`, `set_material`, `align`, `place`, etc.:

1. **`hayba_search_tools(verb)`** — search the TS-captured tools by keyword.
2. **`list_tool_categories`** — scan all 30 domains for the verb / nearby verbs. Read the per-domain command list, not just the domain name.
3. **`hayba_pack_list`** — check whether a relevant pack exists but isn't loaded; `hayba_pack_load <name>` brings it in.
4. **Only after all three return nothing useful**, consider `python_run`.

### Concrete examples

| Task | Wrong instinct | Right discovery |
|---|---|---|
| "Create a landscape" | `python_run` with `unreal.Landscape` (gives a placeholder stub) | `hayba_search_tools landscape` → finds `landscape_import`; if TS wrapper parked, request it be unparked rather than smuggling around it |
| "Scatter trees on terrain" | `python_run` looping `eas.spawn_actor_from_class` | `hayba_search_tools scatter` → find PCG-on-landscape sliver; export a working PCG asset (`hayba_list_pcg_assets` + `hayba_export_pcg_graph`) to learn the pattern |
| "Paint a layer" | `python_run` manipulating LandscapeLayer weight maps | `list_tool_categories` → `landscape` domain → `landscape_paint_layer` (or matching sliver) |
| "Import a heightmap" | Write the R16 to disk and hand-roll the import in python | `hayba_search_tools heightmap` / `import` → `landscape_import` MCP handler |

## Anti-pattern checklist (refuse all of these)

- **Never** open a TCP socket from inside UE python to a port owned by the `HaybaMCPToolkit` plugin (52342–52350). The connecting thread is the game thread; the plugin handler may need the game thread too → deadlock → editor crash. If a TS wrapper is missing, the right move is *add the wrapper, rebuild, ask the user to reconnect* — not smuggle through a side channel.
- **Never** assume "no TS wrapper" means "tool doesn't exist." Check `list_tool_categories` for legacy UE-side handlers; consider `hayba_invoke` with the legacy command name.
- **Never** assume `get_tool_signature` returning `no_schema_available` means "use python_run." It means "the schema sidecar didn't pick this one up" — the handler may still exist.
- **Never** use `python_run` to mutate world state on a code path that has a typed handler. Typed handlers marshal to the game thread; raw socket calls don't.

## When `python_run` is legitimate

- Pure read-only diagnostics (asset registry queries, property dumps).
- One-off explorations the user explicitly asked for.
- Filling in a gap **after** logging that the gap exists and noting it should become a typed tool.

If you ever feel the pull to `python_run` for world mutation, stop and run steps 1–3 again. The fork question is "does a typed tool exist?", and the answer is almost always yes.
