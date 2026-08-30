# The field — Unreal MCP / AI-agent tooling, August 2026

Star counts and push dates pulled live from the GitHub API on 2026-08-23.

## Commercial

### Aura (tryaura.dev) — the one that matters
Built by **Ramen VR** (the Zenith VR studio). PR Newswire launch, Epic Developer
Community showcase thread, public beta shipped.

Claims, verbatim from their site:
- "The AI agent for Unreal + Unity"
- "builds, tests, and verifies"
- "the only agent that can build a feature and then playtest itself"
- **"automatically recover from editor crashes while it's running"**
- "Tests gameplay, UI, and finds bugs before you do"
- "In the editor, in Claude Code and Codex and even your favorite IDE"
- "Trusted by thousands of game studios, from AAA to indie"
- Unreal 5.4+ / Unity 5/6

Capability surface: Editor-Use Agent (lighting, post-process, mass Blueprint
edits), Coding Agent (writes/edits/compiles C++ in-engine, **self-corrects on
compile errors**), 3D asset generation in-engine, plus Blueprints, enums,
structs, data tables, UI, levels, behaviour trees, VFX, audio.

Pricing: credit-based. Monthly credit for prompts/tasks, **unlimited usage in
"Auto Mode"** on every plan, premium credit for frontier models (Claude Opus)
on top. Annual −25%. Free 2-week trial, settable overage caps.

**Why this is the strategic problem.** Crash recovery is their *headline*, and
it is the thing this repo has six open `priority: critical` issues about
(#415, #411, #407, #406, #387, epic #373). "We survive editor crashes" is no
longer a differentiator we can lead with — it is now table stakes that we do
not yet fully meet. Their weakest flank is genuine spatial understanding:
nothing in their copy suggests a world model, constraints, or semantic asset
profiling. That is where we can be un-copyable within a quarter.

## Open source

| Repo | ★ | Forks | Last push | Stack | Read |
|---|---|---|---|---|---|
| chongdashu/unreal-mcp | 2,061 | 340 | 2025-04-22 | C++ plugin + Python | The reference fork-parent. **Dead 16 months.** Stars are legacy, not liveness. |
| flopperam/unreal-engine-mcp | 1,072 | 202 | 2026-06-26 | C++ plugin | README now redirects to Aura. Absorbed. |
| ChiR24/Unreal_mcp | 840 | 159 | 2026-08-23 | TS + C++ | **Most active. Closest architectural rival.** |
| kvick-games/UnrealMCP | 603 | 81 | 2025-06-22 | C++ | Small surface: spawn/transform/scene-info/run-python. |
| ayeletstudioindia/unreal-analyzer-mcp | 158 | 33 | 2025-08-06 | TS | Read-only UE *source* analysis. Orthogonal. |
| GenOrca/unreal-mcp | 135 | 18 | 2026-07-07 | Python | Extensible custom tools. |
| runreal/unreal-mcp | 113 | 27 | 2025-06-06 | Python | Remote Execution, zero plugin install. |
| remiphilippe/mcp-unreal | 67 | 14 | 2026-02-20 | Go | Single binary, 49 tools, UE 5.7, headless build/test. |
| runeape-sats/unreal-mcp | 46 | 10 | 2026-03-31 | Python | Remote Control API. |
| IvanMurzak/Unreal-MCP | 25 | 3 | 2026-08-20 | C++ + .NET | By the Unity-MCP author. Likely to climb — watch it. |

### ChiR24 — study this one
It solved the tool-count problem differently than we did: **23 canonical parent
tools behind a single `unreal` gateway tool**, four functional groups (Core 8 /
World Building 4 / Gameplay Systems 8 / Utility 3). Dual transport: **native
C++ HTTP/SSE with no Node bridge required**, plus an optional TS WebSocket
bridge, both exposing the identical gateway contract. Capability-token auth
(32-byte auto-generated), loopback-only by default, pattern-based console
command validation, 60 req/min rate limiting, 10s asset cache TTL, exponential
backoff on automation handshakes.

Two things they have that we do not:
1. **A no-bridge install path.** Plugin alone gets you a working MCP endpoint.
   We require the Node server. That is a real adoption tax.
2. **An asset cache.** Ours has none — see the catalogue-performance finding.

One thing we have that they do not: an in-editor UI with plan/diff/undo, a
world model, and a constraint system.

### Marketing ≠ traction
`sam-david/unreal-mcp` self-describes as "the most comprehensive MCP server for
Unreal Engine — 127 tools across 16 subsystems" and ranks top-3 in search.
It has **6 stars** and has not been pushed since March. `Flux-Point-Studios`
(8★) is the same pattern. Search prominence in this niche tracks README keyword
density, not adoption. Do not benchmark against tool counts.

## The two conclusions

1. **The tool-count race is a trap.** Everyone is claiming 49 / 127 / "23
   canonical". No user has ever chosen a tool because it had more verbs.
2. **Epic shipped a first-party MCP in UE 5.8.** Generic editor control is now
   vendor-owned. Any product whose entire pitch is "let an AI move actors" has
   a ceiling. The defensible ground is what sits *above* the verbs: a world
   model, rules that hold, and edits you can trust and undo.
