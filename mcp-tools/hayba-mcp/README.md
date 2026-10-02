# @hayba/mcp — the Hayba MCP server

**This is the core product.** A Node/TypeScript [Model Context
Protocol](https://modelcontextprotocol.io) server that exposes Hayba's tool
surface to an agent host (Claude / GPT / any MCP client) over **stdio**, and
bridges those tools to a running Unreal Engine 5 editor over a **TCP** seam.

```
Agent host ──stdio──▶ @hayba/mcp ──TCP──▶ UE5 C++ plugin
 (Claude/GPT)        (this package)       (unreal/HaybaMCPToolkit)
```

> One protocol across two language boundaries. The TCP envelope is the single
> most important invariant in the repo — see [`../../CONTEXT.md`](../../CONTEXT.md)
> for the domain language and [`../../docs/adr/`](../../docs/adr/) for the
> recorded decisions. (`docs/ARCHITECTURE.md`, referenced by the root README,
> is a planned long-form expansion of the CONTEXT.md seam section.)

## What it is

- **MCP module** — the interface is the set of MCP tools plus their Zod
  schemas. The server is started in [`src/index.ts`](src/index.ts): it
  registers catalog resources (`pcgex://catalog/{category}`), registers
  tools via `registerTools`, starts the local web dashboard, connects a
  `StdioServerTransport`, and background-probes the visual sidecar.
- **TCP client seam** — [`src/tcp-client.ts`](src/tcp-client.ts) is the Node
  adapter that talks to the UE plugin's `FHaybaMCPTcpServer`. Both sides must
  agree on a length-prefixed JSON envelope `{ cmd, id, params, auth? }`.
- **Schema registry** — [`src/tools/schema-registry.ts`](src/tools/schema-registry.ts)
  records the Zod shape of every tool at registration time so signatures are
  *derived from the same schema used to validate inputs* — never a
  hand-maintained dict that drifts.

## Run it

Requires **Node ≥ 22.5** (see `engines` in [`package.json`](package.json);
older Node crashes on the `node:sqlite`-adjacent native deps).

```bash
npm install                 # from the repo root (npm workspaces)
npm run build -w @hayba/mcp # builds the dashboard, then `tsc`
node mcp-tools/hayba-mcp/dist/index.js
```

Scripts ([`package.json`](package.json)):

| Script | Action |
|---|---|
| `build` | `build:dashboard` then `tsc` |
| `build:server` | `tsc` only (skip the dashboard) |
| `dev` | `tsc --watch` |
| `start` | `node dist/index.js` |
| `test` | `vitest run` |
| `typecheck` | `tsc --noEmit` |

The package also exposes a `hayba-mcp` bin (`./dist/index.js`), so an MCP
host can launch it directly once built.

> `npm test` here (`tsc --noEmit` + vitest) is the authoritative local
> gate. Run it before pushing.

### Configuration

All via environment variables ([`src/config.ts`](src/config.ts)):

| Var | Default | Purpose |
|---|---|---|
| `UE_TCP_HOST` | `127.0.0.1` | UE plugin host |
| `UE_TCP_PORT` | `52342` | UE plugin port (plugin auto-falls back `52343–52350`) |
| `DASHBOARD_PORT` | `52360` | Local web dashboard (kept clear of the UE `52342–52350` walk) |
| `HAYBA_CODE_MODE` | on (`off` to disable) | Progressive tool discovery (see below) |
| `HAYBA_NODE_CATALOG` | resolved | Override PCGEx `node_catalog.json` path |
| `HAYBA_PCGEX_DB` | resolved | Override PCGEx `pcgex_registry.db` path |
| `HAYBA_CRITIQUE_ENABLED` / `HAYBA_CRITIQUE_THRESHOLD` | on / `15.0` | Terrain self-critique |
| `HAYBA_BRAIN_URL` | empty | Hosted Hayba Pro Brain URL; needed for remote route advice |

Resource paths (`node_catalog.json`, `pcgex_registry.db`) are resolved by
walking a fallback list — new plugin layout, workspace `Resources/`, legacy
`Hayba_PcgEx_MCP` layout — so existing installs keep working.

#### Route advice for external MCP hosts

`hayba_suggest_route` is off by default. To expose this read-only tool to
Claude Code or another MCP host, set `externalRouteAdvice` in
`Saved/HaybaMCP/settings.json` (or the file selected by `HAYBA_SETTINGS_PATH`):

```json
{ "externalRouteAdvice": "local" }
```

`"local"` gives a deterministic suggestion from enabled tools and installed
workflow skills. `"brain"` also asks the hosted Brain to rank that shortlist
when Hayba Pro is signed in; it falls back to local order when sign-in or the
Brain is unavailable. Brain ranking requires `HAYBA_BRAIN_URL` here and the
private Brain's `FASTINO_DECISIONS_ENABLED=1` and
`FASTINO_EXTERNAL_ROUTE_ADVICE_ENABLED=1`. The Brain holds the Fastino key;
this MCP process sends only a fixed intent, mode, and candidate IDs. The tool
does not execute its suggestion or bypass normal tool and editor checks.

The MCP process holds its Hayba Pro refresh token in memory. The Unreal plugin
stores a token in its DPAPI vault, but restores it to the MCP process only when
a Pro chat turn starts, not when Claude Code launches MCP. With the editor
closed or before that handoff, `"brain"` mode gives local advice until the
same MCP process signs in. The loopback device-code endpoints
`/brain/signin/start` and `/brain/signin/poll` can sign in that running
process, but there is no automatic headless restore from the Unreal vault.
Restarting MCP also clears its in-memory sign-in.

#### DeepSeek in Community Chat

The `deepseek` preset appears immediately after OpenAI in the provider list.
It uses DeepSeek's [OpenAI-compatible Chat Completions API](https://api-docs.deepseek.com/)
at `https://api.deepseek.com` with `deepseek-flash` as the default model.
Supply your own DeepSeek key in the editor's provider settings or as
`DEEPSEEK_API_KEY` for a headless Node client. Community Chat uses the same
streaming and tool-call path as other OpenAI-compatible providers. Hayba Pro
BYOK accepts the preset at its fixed hosted endpoint and sends the user's key
to the Brain; custom endpoints remain available in Community Chat only.

### PCG registry intelligence

The node catalog supports four read-only authoring queries in addition to
exact lookup and keyword search:

- `hayba_search_node_catalog_semantic({ query, k? })` ranks nodes with a
  deterministic CPU-local semantic vector built from descriptions, classes,
  categories, pins, and properties. It requires no model download or sidecar.
- `hayba_compatible_pins({ from_class, from_pin })` resolves the source output
  type and returns exact-type and `Any` input pins in deterministic order.
- `hayba_get_pattern_template({ intent })` returns an annotated starter graph
  for road networks, surface scattering, or cluster refinement. Unknown
  intents return the available template IDs instead of guessing.
- `hayba_diff_node_catalog_versions({ baseline_path })` compares a saved
  `node_catalog.json` (the shipped nested format or a flat snapshot) with the
  currently loaded catalog and reports added, removed, and field-level
  modified node classes. Save the old catalog before upgrading PCGEx, rebuild
  with `hayba_scrape_node_registry`, then pass the saved path to this tool.

These tools inspect catalog metadata only; they do not require a running Unreal
Editor and do not mutate the registry.

### World evidence comparison

`world_compare_snapshots` compares two supplied `world_budget_snapshot` results
without contacting the editor. Each side needs a distinct `scenario_id` and the
same caller-declared `protocol_id`; the tool also checks world, folder aggregate,
World Partition setting, and scan limit. Optional `editor_pie_capture_get`
results must be supplied as a completed pair with matching capture settings.
It returns raw loaded counts and deltas, whole-editor proxy timing and memory
statistics with sample counts and units, and verdicts only against structural
caps explicitly supplied to the comparison. Incomplete structural scans remain
scanned-prefix evidence. A truncated tagged-actor scan stays a labeled lower
bound; Hayba does not subtract two lower bounds. Counts beyond JavaScript's
safe-integer range are rejected instead of rounded. The caller is responsible for ensuring the declared
protocol represents comparable route, hardware, build, and editor conditions;
GPU, streaming, NPC cost, design quality, and production performance remain
unknown.

## Code Mode (the deep interface)

By default the server exposes only **three meta-tools** instead of the full
~100-tool catalog:

- **`list_tool_categories`** — enumerates the handler domains and the command
  names within each ([`src/tools/code-mode/list-tool-categories.ts`](src/tools/code-mode/list-tool-categories.ts));
  disabled tools are filtered out.
- **`get_tool_signature`** — derives a command's parameter schema from the
  Zod registry on demand, with a "did you mean" suggestion on a miss
  ([`src/tools/code-mode/get-tool-signature.ts`](src/tools/code-mode/get-tool-signature.ts)).
- **`python_run`** — executes a script through UE's `PythonScriptPlugin` over
  the TCP seam for constrained embedded editor scripting
  ([`src/tools/python/python-run.ts`](src/tools/python/python-run.ts));
  Tier-3 host I/O (filesystem writes, subprocesses, and sockets) is always
  refused before interpreter execution. The legacy `allow_unsafe` boolean is
  accepted only for compatibility and is deprecated and ineffective. Use typed
  brokered tools for supported host work (#412/#415). This in-process boundary
  does not make arbitrary Python safe or provide process isolation (#392/#414).

The full catalog is registered eagerly only when `HAYBA_CODE_MODE=off`
(see the `if (config.codeMode) return;` guard in
[`src/tools/index.ts`](src/tools/index.ts)). This is a deliberately **deep**
module: a tiny interface hiding a large surface, so a multi-domain task
doesn't pay the token cost of every schema up front.

## The TCP client seam

[`src/tcp-client.ts`](src/tcp-client.ts) (`UETcpClient`) connects to
`127.0.0.1:52342` by default. Wire format:

- **Length-prefixed JSON.** A 4-byte little-endian length header precedes the
  UTF-8 JSON body.
- **Request:** `{ cmd, id, params }` (`TcpCommand`).
- **Response:** `{ id, ok, data?, error? }` (`TcpResponse`), correlated back
  to the caller by `id`.
- The client tolerates partial reads (it buffers until a full frame arrives)
  and rejects all pending requests on socket close. The matching adapter is
  the UE plugin's `FHaybaMCPTcpServer`; the plugin publishes its actual port
  to `Saved/HaybaMCP/instances/<pid>.json` for multi-editor setups.

## Visual sidecar addon

[`addons/visual-embeddings`](addons/visual-embeddings) is a Python FastAPI
sidecar (CLIP / SpatialCLIP / OWL-ViT) used for spatial grounding and physics
validation. `src/index.ts` background-probes it at startup
(`pingSidecar`) and caches availability so visual tools and
`hayba_check_ue_status` can branch on it without paying connect-timeout
latency. It is **optional and degraded-mode aware** — the server runs
without it. Setup: [`addons/visual-embeddings/README.md`](addons/visual-embeddings/README.md)
and [`../../docs/getting-started.md`](../../docs/getting-started.md) (Tier 2).

Other addons:

- [`addons/workflows`](addons/workflows) — `SKILL.md` workflow guides
  (`hayba-new-scene`, `hayba-refine-scene`, `hayba-debug-level`,
  `hayba-pcg-build`) a Claude Code host surfaces for matching tasks (Tier 3).
- [`dashboard/`](dashboard) — the Vite/React local web dashboard served by
  [`src/dashboard/server.ts`](src/dashboard/server.ts).

## How to add a tool

1. Add a handler module under [`src/tools/`](src/tools) (or a domain
   subfolder) exporting a Zod `schema` and a handler of type `ToolHandler`.
2. Register it in [`src/tools/index.ts`](src/tools/index.ts) via the wrapped
   `server.tool(...)`. Registration **also** calls `recordSchema(name, {
   shape, cost, returns })` so the schema registry knows the command —
   regardless of whether Code Mode eagerly registers it.
3. If the command is dispatched into UE, ensure the UE plugin has a matching
   handler (see [`../../unreal/HaybaMCPToolkit/README.md`](../../unreal/HaybaMCPToolkit/README.md))
   and that both sides agree on the `{ cmd, id, params }` envelope.
4. Run `npm test -w @hayba/mcp` (`tsc --noEmit` + vitest).

> Eagerly-registered tools are only exposed to the agent when Code Mode is
> off; under Code Mode they are reached through `python_run` / discovered via
> `list_tool_categories`. Recording the schema keeps `get_tool_signature`
> accurate either way.

## Layout

```
src/
  index.ts            MCP server entrypoint (stdio + dashboard + sidecar probe)
  tcp-client.ts       UE TCP adapter (length-prefixed JSON envelope)
  config.ts           env-driven config + resource path resolution
  resources.ts        pcgex://catalog/{category} resources
  catalog.ts          PCGEx node catalog access
  tools/
    index.ts          registerTools — the single registration point
    schema-registry.ts Zod-shape registry feeding get_tool_signature
    code-mode/        list_tool_categories, get_tool_signature
    python/           python_run
    actor|scene|editor|visual|material|plumb/ … domain tool modules
  agents/ dashboard/ … supporting modules
addons/workflows          SKILL.md workflow guides
dashboard/                Vite/React local dashboard
```

The Python visual sidecar lives at [`../visual-sidecar`](../visual-sidecar).

## See also

- [`../../CONTEXT.md`](../../CONTEXT.md) — domain language, the protocol seam
- [`../../docs/adr/`](../../docs/adr/) — recorded architectural decisions
- [`../../unreal/HaybaMCPToolkit/README.md`](../../unreal/HaybaMCPToolkit/README.md)
  — the UE5 plugin (the other adapter on the seam)
- [`../visual-sidecar/README.md`](../visual-sidecar/README.md) — the Python visual sidecar
