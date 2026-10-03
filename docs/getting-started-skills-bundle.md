# Getting started — Hayba workflow skills

The workflow library lives in [`mcp-tools/hayba-mcp/addons/workflows/`](../mcp-tools/hayba-mcp/addons/workflows). It currently contains **51 skills**: the original four, repaired where their tool guidance had drifted, and 47 focused additions. A skill is a `SKILL.md` guide for an agent; it is not an MCP command or a tool pack.

## Install in an agent host

Copy the skill folders into the host's skill directory. For Claude Code:

```bash
cp -r mcp-tools/hayba-mcp/addons/workflows/hayba-*/ ~/.claude/skills/
```

For Codex:

```bash
cp -r mcp-tools/hayba-mcp/addons/workflows/hayba-*/ ~/.codex/skills/
```

Each folder has YAML frontmatter with a discriminating `name` and `description`. The host can select a matching skill from that short description and read the full body only when needed. The in-editor Hayba copilot does not currently load these skill bodies automatically; use the catalog commands below to find and read one explicitly when integrating another agent host.

## Browse without loading every guide

[`catalog.json`](../mcp-tools/hayba-mcp/addons/workflows/catalog.json) is generated metadata: name, category, tags, description, tool references, and relative skill path. The index is small enough to search while each workflow body remains separate.

From `mcp-tools/hayba-mcp/`:

```bash
node scripts/skills-catalog.mjs search "PCGEx generated instances"
node scripts/skills-catalog.mjs show hayba-pcgex-output-audit
node scripts/skills-catalog.mjs validate
```

`search` returns only concise matches. `show` reads the selected `SKILL.md`. These are local catalog operations, not Unreal editor calls.

| Area | Skills |
| --- | --- |
| World composition and streaming | `hayba-new-scene`, `hayba-world-composition`, `hayba-world-partition-streaming`, `hayba-traversal-playtest`, `hayba-spline-route-authoring` |
| Set dressing | `hayba-refine-scene`, `hayba-hero-set-dressing`, `hayba-foliage-layout` |
| PCG / PCGEx | `hayba-pcg-build`, `hayba-pcgex-node-selection`, `hayba-pcgex-output-audit` |
| Procedural planning | `hayba-room-grammar-prototype` |
| Assets and materials | `hayba-asset-import-vetting`, `hayba-content-redirector-migration`, `hayba-material-look-pass`, `hayba-material-instance-variants` |
| Terrain and water | `hayba-terrain-import-pass`, `hayba-water-crossing` |
| Lighting and VFX | `hayba-lighting-mood-pass`, `hayba-weather-visibility-pass`, `hayba-niagara-vfx-pass` |
| UI | `hayba-ui-hud-build`, `hayba-ui-warning-audit`, `hayba-ui-data-binding`, `hayba-localization-layout-stress`, `hayba-controller-focus-audit` |
| Gameplay and AI | `hayba-ai-behavior-tree`, `hayba-combat-encounter`, `hayba-camera-player-feel`, `hayba-data-balance-pass`, `hayba-gameplay-ability-slice`, `hayba-gameplay-input-mapping`, `hayba-objective-trigger-slice`, `hayba-physics-interaction` |
| Narrative | `hayba-dialogue-subtitle-review` |
| Audio | `hayba-audio-soundscape`, `hayba-metasound-cue`, `hayba-spatial-audio-falloff` |
| Animation and cinematics | `hayba-animation-state-audit`, `hayba-cinematic-shot`, `hayba-sequencer-motion-pass` |
| Multiplayer | `hayba-multiplayer-replication-audit` |
| Optimization | `hayba-performance-budget`, `hayba-mesh-lod-pass`, `hayba-texture-memory-pass`, `hayba-pie-performance-capture` |
| Release preparation | `hayba-project-cook-readiness` |
| QA | `hayba-debug-level`, `hayba-qa-smoke-test`, `hayba-save-load-regression`, `hayba-world-save-integrity` |

The guides cover authored content, runtime checks, and production preparation. Each guide states where Hayba's current tool readback stops and an Unreal editor observation or measured build is still required.

## Authoring contract

Each skill states when it applies, preferred Hayba tools and meaningful alternatives, a bounded pass, warnings about what a successful call does *not* prove, and evidence required to report completion. Inspect each returned warning and verify whether its requested property actually applied before proceeding. The default deferred route is `hayba_search_tools` when the command is unknown, `get_tool_signature` to inspect its accepted fields, then `hayba_invoke` with the exact typed tool name. `hayba_invoke` can call an unloaded tool without first loading its pack; use `hayba_pack_load` when repeated calls in one domain make native schemas useful. `list_tool_categories` distinguishes callable commands from supported commands without an agent wrapper. The default invoke route also reaches legacy commands marked callable in the sidecar. An absent native schema is not a reason to switch to `python_run`.

Use `python_run` only when both typed and callable legacy routes cannot perform the task. Before that exceptional call, write an explicit bounded plan, acquire the appropriate editor lease with `lease_acquire` and wait for a grant, inspect `editor_get_state` for the active map, PIE ownership, busy operations, and dirty packages, and review the complete script, its targets, effects, and unsafe engine calls. Recheck editor state after execution, read back every intended change, and release the lease with `lease_release`. A script refusal or uncertain result requires diagnosis and readback, not an unchanged retry.

For an accepted map change, identify the active map, deliberately call `level_save` with its exact current-path guard, inspect its saved, dirty, and verified result, and read back the changed actors or world state. If saving or verification is unsafe or incomplete, say the edit remains unsaved and use `hayba-world-save-integrity` before claiming persistence. A map save alone does not establish that every external actor package persisted.

Concrete tool names in skill text use snake case. The validator scans them against the current TypeScript tool descriptors and only legacy commands marked `agent_callable: true` in the sidecar. Mark a snake-case response field as `field:<name>` so it is not mistaken for a tool. The check catches references to commands that are documented but cannot be invoked, as well as nonexistent names. Conceptual capabilities should be described in ordinary language, clearly identified as plans rather than invented commands.

After adding or editing a skill, regenerate and validate the index:

```bash
node scripts/skills-catalog.mjs index --write
node scripts/skills-catalog.mjs validate
npm test -- scripts/skills-catalog.test.mjs
```

The test also runs in the package's normal Vitest suite. Adding a skill does not add an MCP tool or expose another schema at startup. [`packs.yaml`](../mcp-tools/hayba-mcp/src/tools/routing/packs.yaml) is a separate mechanism for grouping existing tools.

## Known corrections from the original four

The first scene and refinement guides previously required moodboard generation and CLIP scoring commands that are not implemented in the callable tool catalog. They now use user-provided references, viewport captures, and explicit visual judgment. The PCG guide retains its detailed production-method comparison and uses fresh instance readback from `pcg_cook_and_wait`; `pcg_read_node_output` is documented as potentially stale. The level debugging guide now measures a symptom before changing actors and verifies the result afterward.
