# Hayba MCP Server — Domain Vocabulary

The TypeScript MCP server that bridges agent hosts (Claude Code, Claude Desktop, Cursor, GPT) ↔ the Hayba UE5 plugin over TCP. Definitions here are the canonical names — use these terms in code, commits, ADRs.

## Glossary

- **MCP server** — the Node process exposing tools to the agent host over stdio MCP.
- **Tool** — a unit the agent can call. Each Tool is registered via `server.tool(name, schema, handler)` in `src/tools/index.ts`.
- **Handler** — the TS function implementing a Tool. Its job is parse-validate-dispatch — it should not own transport or retry logic.
- **TCP envelope** — the wire format between TS and UE: length-prefixed JSON on `:52342` (with `52343–52350` fallback). Carries `{cmd, params}` request and `{ok, data?, error?, code?}` response.
- **TCP client** — `src/tcp-client.ts`. Owns the socket, heartbeat re-resolution, and the `client.send(cmd, params, timeout)` primitive. Handlers should not import it directly once the **ToolExecutor** seam is in place.
- **ToolExecutor** — `src/tools/tool-executor.ts`. The deep seam between Handlers and the TCP envelope. Owns: `ensureConnected`, send/retry, timeout-from-cost, error normalisation. Surface: `executeCommand(cmd, params, opts?) → Promise<data>` resolving with UE's `data` on success, throwing `UeToolError` on failure.
- **UeToolError** — `class UeToolError extends Error { code: "transport"|"timeout"|"plan_gate"|"tool_disabled"|"ue_error"; uePayload?: unknown }`. The single error type the executor throws; the `code` discriminator is the only thing callers branch on.
- **Tool meta** — `src/tools/hayba-tool-meta.ts`. Per-Tool metadata: `cost: low|medium|high`, `effects`, `when`, `not_when`. Cost drives the executor's default timeout (`low=2s, medium=10s, high=60s`).
- **PCG node catalog** / **node registry** — the SQLite registry of PCGEx node metadata (`pcgex_registry.db`, 344 nodes / 356 pins / 2270 properties) loaded via `src/catalog.ts`. The companion JSON `node_catalog.json` is the file form.
- **Plan Mode** — the destructive-op gate. State lives in C++ (`FHaybaMCPModule::bPlanApproved`). The agent calls `hayba_propose_plan` to push steps to the panel; user approves; UE then accepts destructive ops. The executor surfaces plan-mode rejections as `UeToolError` with `code: "plan_gate"`.
- **Code Mode** — the *legacy* meta-tool pattern (superseded by Tool Routing below, kept as `toolRouting: "full"` fallback): `list_tool_categories` / `get_tool_signature` / `python_run` let the agent discover tools on demand instead of receiving all tool schemas up front.
- **Tool Routing (γ hybrid)** — current default. Replaces Code Mode for clients that honor `notifications/tools/list_changed`. `src/tools/routing/`. Six always-on meta-tools (`hayba_search_tools`, `hayba_pack_list`, `hayba_pack_load`, `hayba_invoke`, `hayba_check_ue_status`, plus legacy `list_tool_categories`+`get_tool_signature`) keep the session-start footprint tiny; everything else is loaded on demand through named **Packs**. Switched via `Saved/HaybaMCP/settings.json#toolRouting`.
- **Pack** — a named bundle of tools the agent can load to add typed registrations natively (firing `list_changed` for clients to refresh). Two kinds: *domain packs* auto-derived from `src/tools/*/` subdirectories (or the optional `pack` field on `HaybaToolMeta` for root-level tools), and *workflow packs* curated in `src/tools/routing/packs.yaml` (`biome`, `planet-sim`, `architecture`, `connectors`, `editor`, `python`). The `editor` pack auto-loads on first successful `hayba_check_ue_status`.
- **ToolIndex** — `src/tools/routing/tool-index.ts`. Hybrid BM25 (always) + embedding (Ollama → `@huggingface/transformers` → BM25-only fallback) tool catalog. Reciprocal-rank-fusion merge. Disk-cached at `Saved/HaybaMCP/tool-index.{bm25.json,meta.json}` and rebuilt on hash mismatch.
- **Disabled-tools set** — `Saved/HaybaMCP/disabled-tools.json`. The MCP Capabilities panel writes it; both TS server and C++ plugin read it. Filtered at the meta-tool boundary so disabled tools are invisible to the agent.
- **Cognitive map** / **Scene Map** — top-down semantic clustering of the level rendered in the Hayba plugin panel. Cells are spatial bins; each cell is labelled by `ClassifyDominant` in `HaybaMCPCogMapBuilder.cpp` (C++ side).

## Architectural principles in force

- **Deep seam, not shallow handler.** A Handler should be a *specification* of params + tool name. Transport, retry, timeout, and error shaping live behind the **ToolExecutor** seam — not duplicated per Handler.
- **Two adapters = real seam.** The ToolExecutor ships with a live adapter (real `tcp-client`) and an `InMemoryToolExecutor` for tests. One adapter would be a hypothetical seam.
- **Wire compatibility.** New optional fields on the TCP envelope (`code`) are additive; older clients ignore them.
- **Plan Mode is C++-authoritative.** TS doesn't decide what's destructive; UE rejects with `code: "plan_gate"` and the executor surfaces it.

## Tool routing — quick switching

`Saved/HaybaMCP/settings.json`:

```json
{ "toolRouting": "deferred", "alwaysLoadPacks": ["biome"] }
```

- `toolRouting`: `"deferred"` (default — γ hybrid; pack-on-demand) or `"full"` (legacy — every non-disabled tool registered at start). Changes require an MCP restart.
- `alwaysLoadPacks`: array of pack names to load at MCP boot for users who only ever do one kind of work. The `editor` pack auto-loads regardless when the UE editor connects.

To add a tool: drop the handler in `src/tools/<pack-name>/` and the auto-derived domain pack picks it up. For root-level handlers, set `pack: "<name>"` in their `HaybaToolMeta`. To slot the tool into a curated workflow pack (e.g. `biome`), add its name to `src/tools/routing/packs.yaml`. Pack references in YAML that don't resolve to a captured tool log a startup warning.

## See also

- `README.md` — top-level project description.
- `docs/superpowers/specs/2026-05-06-hayba-ue-expansion-design.md` — full architectural spec (UE plugin + TS server + sidecar).
- `docs/superpowers/specs/2026-05-20-mcp-tool-routing-design.md` — γ hybrid tool routing design.
- `docs/superpowers/plans/2026-05-20-mcp-tool-routing.md` — implementation plan.
- `CHANGELOG.md` — recent Fixed/Added under `[Unreleased]`.
