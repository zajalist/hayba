# Field deep-dive — architecture teardowns (2026-08-23)

Companion to `00-FIELD-STUDY.md` (which has star counts and the strategic
frame). This is the per-repo teardown, Epic 5.8 scope, Aura's *documented*
capabilities vs its marketing, cross-engine patterns worth stealing, and the
2026-07-28 MCP spec features nobody in this field exploits yet.

## 1. Open-source teardowns

### ChiR24/Unreal_mcp (840★, pushed daily) — MIT
- TS + C++ plugin. **Dual transport: native in-plugin HTTP/SSE (no Node
  required) or TS stdio bridge** — same gateway contract on both.
- The most aggressive gateway in the field: **one `unreal` tool** with four
  operations (`search`/`describe`/`execute`/`configure`) routing to 23 internal
  tools. Explicit bounded routing layer against context bloat.
- **Auth on by default** (auto-generated capability token), pattern-blocked
  console commands, per-IP rate limit, graceful degradation without a live
  editor, exponential-backoff handshake retry. UE **5.0–5.8** — widest range.
- Take: the no-bridge install path and default-on auth are real adoption and
  trust advantages we lack.

### IvanMurzak/Unreal-MCP (25★ but by the Unity-MCP author) — Apache-2.0
- C++ plugin + auto-managed **.NET sidecar** over localhost IPC with one-shot
  stdin token. Cloud backend (ai-game.dev) or self-hosted.
- 61 tools / 7 families incl. **C++ source editing + compile (6 tools)** with
  structured compile-error feedback loops; **transactions + standard UE
  undo/redo on tool ops**; per-tool on/off toggles in an MCP Tools window.
- Runtime (in-game) side has 5 safety layers: opt-in connections, default-off
  kill-switch, Shipping-build gates, loopback-only, stdin tokens.
- From his Unity-MCP (13.6k★ ecosystem): **one-attribute custom tool
  registration** (`[AiTool]` — any method becomes a tool in one line),
  auto-generated skills, dual stdio/streamableHttp. Expect these to land in
  the UE port. **Watch this repo** — it is the one most likely to climb.

### GenOrca/unreal-mcp (135★) — Apache-2.0
- Python server + plugin riding UE's Python Editor Script Plugin; optional C++
  helper for APIs Python misses. No rebuild on the Python path.
- **21 domain namespaces, 253 actions** with `list_actions` discovery — the
  "small tool list, large action set" shape closest to our Code Mode.
- No undo, no crash story, unvetted `execute_python`.
- Novel: vision domain returns viewport frames **with actor labels** for
  visual scene grounding.

### remiphilippe/mcp-unreal (67★) — Apache-2.0
- **Single Go binary**, zero deps; Remote Control HTTP (30010) + custom plugin
  (8090); headless build/test/cook needs **no editor and no plugin**.
- 49 tools / 11 categories; structured JSON build errors; per-test pass/fail.
- Novel: **Bleve full-text offline UE API doc search** (`lookup_docs` /
  `lookup_class`); Live Coding hot-reload tool; strongest headless CI story.
- Take: doc-search-as-a-tool kills the agent guess-wrong-API bug class — this
  is the "reflection/source intelligence" item already on our roadmap, proven
  viable by a 4-commit repo.

### runreal/unreal-mcp (113★) — MIT
- Zero plugin: UE's built-in Python Remote Execution. Two settings toggles +
  one config edit = lowest friction in the field. No safety story at all.

### kvick-games/UnrealMCP (603★) — MIT
- Early-era prototype, blender-mcp-inspired, basic TCP verbs. Historical.

### chongdashu/unreal-mcp (2,061★) — MIT
- The fork-parent (Flopperam lineage started here). BP node-graph editing
  early; self-declared experimental; stagnant since 2025-04. Stars ≠ liveness.

## 2. Epic first-party MCP (UE 5.8)

- Announced State of Unreal / Unreal Fest Chicago **2026-06-17**; shipped as
  **Experimental** `UnrealMCP` plugin; Epic says MCP is core infrastructure
  carried into UE6.
- In-process localhost HTTP at `127.0.0.1:8000/mcp`; console command
  `ModelContextProtocol.GenerateClientConfig` writes client config.
- Coverage: actor spawn/place, lighting config, material-instance
  create/modify, **Slate UI widget inspection**, automation tests, Blueprint
  navigation. **Extensible via `UToolsetDefinition` subclassing (C++ or
  Python)** — Epic ships the socket and extension point, not the catalog.
- Gaps it leaves (third-party analyses; Epic's own tool inventory is not
  published in detail — UNVERIFIED at the item level): thin breadth, no
  transactional multi-step undo, no read-back verification loops, no auth
  beyond localhost, experimental API churn.
- Strategic read unchanged from the roadmap: **extend their Toolset Registry,
  don't fight it** — speak `list_toolsets`/`describe_toolset`/`call_tool` for
  interop.

## 3. Aura — documented reality vs marketing

Fetched: /documentation/, /quick-start/, /editor-agent, /coding-agent-cpp/,
/pricing-explained/.

- Separate agents per domain: Editor (drives editor via **generated Unreal
  Python** — batch property edits, renaming, tags, unused-asset finding,
  naming conventions, CSV export), Blueprints, C++, Level Design, Art Tooling
  (concept images + 3D models), VFX/Audio, Behavior Trees, Profiling.
- **Crash recovery: NOT documented anywhere.** The C++ docs say the opposite:
  *"C++ can cause compilation issues. If this happens you will need to close
  Unreal and rebuild in Visual Studio or Rider"* — and advise regular backups.
  The homepage recovery claim is marketing copy with no documented mechanism.
- **Playtest loop: no documentation page describes the mechanism.** UNVERIFIED.
- No documented sandboxing; docs warn generated Python "can have consequences."
- C++ agent: review-and-accept patches, then Live Coding compile; requires a
  dummy C++ class for BP-only projects.
- Pricing: unlimited Auto Mode **only with Training Data sharing enabled**;
  Auto Mode silently spends premium credits on hard tasks; per-agent-type
  costs; **not compatible with source builds of UE**; separate installs per
  engine version; Windows-only.

**The reframe:** Aura took the crash-resilience *slogan*. We have the
*machinery* (SEH on the dispatch seam, async job registry, transactional undo,
hash-only journal) — shipped, in code, documentable. Their documented moat is
product polish + model routing, not editor reliability. The counter is not to
out-shout them; it is to **publish evidence**: a reliability page with the
crash-class inventory, what is guarded, and reproducible torture tests. Nobody
in this field documents reliability; the first one to do it credibly owns the
word.

## 4. Cross-engine patterns worth stealing

- **blender-mcp (26.2k★):** radical install (`uvx … install-addon` + sidebar
  connect toggle) plus bundled **asset-source integrations** (Poly Haven,
  Sketchfab, Hyper3D, Hunyuan3D) that make first-session demos spectacular.
  Steal: tiny visible connect UI + asset acquisition for demo-wow.
- **Unity-MCP / CoplayDev (13.6k★):** 47 deliberately focused tools, selective
  tool-group activation, and — the killer — an in-editor **auto-configurator
  that detects Claude/Cursor/VS Code/Windsurf and writes their MCP config for
  them**. Steal: that onboarding flow, verbatim. It kills the biggest
  first-run failure mode we have (hand-editing client JSON).
- **godot-mcp (5.3k★):** no plugin; one generic in-engine script interprets
  `{operation, params}` JSON. Steal: version-proofing pattern — a tiny generic
  engine-side surface outlives engine API churn.

## 5. MCP spec 2026-07-28 — the unexploited protocol features

- **Tasks**: `tools/call` can return a task handle; `tasks/get` / `tasks/update`
  / `tasks/cancel`. Stateless — no persistent connection needed for long work.
- **MRTR** (multi round-trip requests): server returns `InputRequiredResult`
  with `inputRequests` + opaque `requestState`; one result can batch an
  elicitation AND a sampling ask.

What a UE MCP can do with these that **nobody** in the field does yet:

1. Bakes/builds/cooks/PIE as **cancelable tasks with real progress** — our
   `FHaybaMCPJobRegistry` maps onto protocol tasks almost 1:1. This also
   retires the late-response crash class at the protocol level ([[
   bug_haybamcp_tcpserver_late_response_crash]]): the task handle survives the
   socket.
2. **Cancellation** wired to `FSlowTask`/async ops — abort a cook or PCG regen
   mid-flight.
3. **Elicitation** as a protocol-level Plan Mode: destructive-op confirmation
   and ambiguous-asset choice through the client's own UI — a safety gate no
   surveyed server has.
4. **Sampling**: the server asks the client's model to summarize a 10k-line
   build log or judge a screenshot — without holding API keys. Perfect fit for
   BYOK.
5. Statelessness makes **editor-crash-and-reconnect protocol-legible**: crash,
   relaunch, the task handle still answers. That is the crash-resilience story
   told in the protocol's own grammar.

This aligns with open issue #381 (migrate to MCP SDK v2 / 2026-07-28) — that
issue is not plumbing, it is the delivery vehicle for differentiators 1–5.

## Field summary

Nobody combines: (a) the Epic-gap features — transactions/undo, crash
resilience, read-back verification; (b) a serious token economy (only ChiR24
and GenOrca try); (c) the new task/elicitation primitives (nobody). Epic
commoditizes the socket. Aura's documented strength is polish and model
routing, and its docs concede the reliability ground. The lane is open; it is
an evidence problem, not a capability problem.
