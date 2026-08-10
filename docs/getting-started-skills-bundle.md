# Getting started — Skills bundle

Sibling of [`docs/getting-started.md`](getting-started.md). Covers Tier 3:
the shipped `SKILL.md` workflow guides.

## Install

```bash
cp -r mcp-tools/hayba-mcp/addons/workflows/* ~/.claude/skills/
```

Each subdirectory under
[`mcp-tools/hayba-mcp/addons/workflows/`](../mcp-tools/hayba-mcp/addons/workflows)
is a self-contained skill: a folder named after the skill, containing one
`SKILL.md` with YAML frontmatter (`name`, `description`) and a body Claude
Code reads when deciding whether the skill applies. There are four:

## The four skills

### `hayba-new-scene`

> "Use when the user asks to generate a new scene from scratch — coordinates
> moodboard → references → spatial planning → asset placement → physics
> validation → CLIP scoring."

Workflow (from the file): generate a moodboard, fetch reference embeddings,
pull the level's spatial index, assign biome zones per World Partition cell,
build/execute a PCG graph and paint foliage per zone, dress hero areas from
Content Browser search results, validate physics (shallow first, deep only
for hero shots), capture the viewport and CLIP-score it against the
moodboard, and hand off to `hayba-refine-scene` if the score is below 0.65.

### `hayba-refine-scene`

> "Use when the user wants to improve an existing scene — captures viewport,
> scores against references, and applies targeted edits to low-score
> regions."

Workflow: capture the current viewport, pull reference embeddings from
shared memory, CLIP-score per actor to find the worst-scoring elements, try
one of lighting / material swap / displacement / foliage-density change per
low scorer, and iterate — stop on a score delta under 0.02 or after 5
rounds.

### `hayba-debug-level`

> "Use when a level has performance, physics, or layout problems — combines
> `editor_stream_log`, `scene_validate_physics`, and `scene_export`
> hierarchical mode to find issues."

Workflow: baseline FPS/draw-calls/memory, tail the editor log filtered to
`LogStreaming|LogPhysics|LogPCG`, run a shallow physics validation, export
the scene hierarchically to spot over-dense cells, snap floating actors to
ground (validating placement first), resolve interpenetration by transform
or visibility, and check World Partition cells for ISM-consolidation
opportunities on perf hotspots.

### `hayba-pcg-build`

> "Use when the user wants to build a PCG/PCGEx graph — guides through node
> selection, validation, and execution."

Workflow: list available PCG node classes, confirm pin types per candidate
node, sketch the graph as JSON, validate it (must pass all 5 validation
layers), create the graph from the validated JSON, execute it on a target
component, and read back the generated node output to verify.

## What this page does and doesn't verify

These four descriptions are read directly from the shipped `SKILL.md` files
— the workflow steps and the tool names inside them (`hayba_generate_moodboard`,
`pcg_validate_graph`, `scene_validate_physics`, etc.) are quoted as written,
not independently re-verified against the current tool registry here. Some
referenced tools may live in domains that have moved or been reorganized
since a given skill was last touched (see `docs/handoffs/HANDOFF-architecture-cleanup.md`
for the current state of tool availability). If a skill references a tool
that no longer resolves, that's a bug in the skill file, not something this
page can catch — check with `list_tool_categories` / `hayba_search_tools` if
a step in one of these workflows fails to find its tool.

## Discoverability

Once copied into `~/.claude/skills/`, Claude Code surfaces the matching
skill automatically based on the `description` frontmatter — no explicit
invocation needed, per the existing "Tier 3" note in
[`docs/getting-started.md`](getting-started.md).
