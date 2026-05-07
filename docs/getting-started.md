
## Add-On Tiers

### Tier 1 — Core (required)
- UE plugin (`HaybaMCPToolkit`) + Node.js MCP server
- See main install instructions above

### Tier 2 — Visual Intelligence (optional, GPU recommended)
- `cd packages/hayba/addons/visual-embeddings && uv sync --extra gpu` (or `--extra cpu`)
- `uv run hayba-visual-sidecar` — sidecar listens on `:7821`
- ⚠️ Continuous capture mode causes ongoing GPU load. Disable if not actively iterating.
- Configure via Project Settings → Plugins → Hayba MCP Toolkit → Visual Sidecar.

### Tier 3 — Workflow Skills (optional)
- Copy `packages/hayba/addons/workflows/*` to `~/.claude/skills/`
- Available skills: `hayba-new-scene`, `hayba-refine-scene`, `hayba-debug-level`, `hayba-pcg-build`
- These are SKILL.md guides that Claude Code surfaces automatically when matching tasks come up.
