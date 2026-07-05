# BYOK In-Editor AI Chat Panel — Revival Implementation Plan

Revives the Hayba MCP in-editor BYOK copilot (Aura-parity). Architecture:
**fat-server / thin-client** — the agentic tool-calling loop runs in the Node MCP
server; the C++ Slate panel is a streaming SSE chat UI.

## Architecture Decision (chosen: TS-side loop in the MCP server)

Option (a) — run the agent loop in the Node MCP server, C++ is a thin SSE chat
client — is chosen over (b) a C++-side loop.

Rationale:
- **Tool fidelity + reuse.** The server already owns the full tool catalog,
  `hayba_invoke` polymorphic dispatch, Code-Mode/deferred routing, `DisabledTools`,
  the PLUMB validator, and journaling. The loop must call tools through that same
  hardened path (`executeCommand` → TCP → C++ game-thread handler). A C++ loop
  duplicates all of it and diverges.
- **The only correct tool-calling shape in repo history is TS** (`llm-client.ts`,
  `ac46d40`: `LLMTool`/`LLMToolCall`/`LLMResponse`, `stopReason:'tool_use'`).
- **Crash-resilience.** The loop stays off the UE game thread; tool calls marshal
  through the existing async TCP seam, avoiding the game-thread deadlock class in
  `docs/audit/2026-06-22-crash-and-architecture-audit.md`. A C++ in-editor blocking
  loop would freeze the editor.
- **Streaming.** The existing Express app (`src/dashboard/api.ts`,
  `registerApiRoutes`) can host `POST /chat/stream` (SSE); C++ already uses
  `FHttpModule` and has a `SidecarURL` setting (`HaybaMCPSettings.h:56`,
  default `http://localhost:7821`) — it consumes SSE and appends deltas.
- **BYOK simplicity.** Keys live in the C++ DPAPI vault; the sidecar reads them via
  a local handshake and never logs/echoes them.
- **What the OLD implementation did:** the in-tree C++ panel did a single
  no-tools, no-stream HTTP POST returning `{reply,graph}` (a one-shot generator,
  not an agent). The removed TS `llm-client.ts` had the real tool-calling shape.
  We lift the TS shape server-side and keep/upgrade the (already production-grade)
  Slate UI.

## Global Constraints (binding — reviewers use as attention lens)

- **Branch:** all work on `feat/mcp-byok-chat-panel`. No branch switching; do not
  commit to the default branch.
- **TS verification gate:** every TS task ends with `npx tsc --noEmit` clean AND
  `npx vitest run` green (run in `mcp-tools/hayba-mcp`), plus `lint` if configured.
  New behavior gets a unit test. Provider HTTP is mocked; the agent loop is
  unit-tested with fake tools.
- **C++ verification gate:** this environment cannot compile UE C++. C++ tasks are
  tagged `[needs-rebuild]`, gated by code review against cited `file:line`, and an
  in-editor smoke step deferred to the user. C++ tasks must NOT claim runtime
  verification.
- **Security (binding):**
  - API keys are never logged, echoed, or written to the journal
    (`bEnableExecutionJournal`), transcripts, SSE frames, or tool args. The DPAPI
    vault holds the only plaintext copy; introspection returns masked last-4 only.
  - Destructive tool calls from the chat agent go through the **Plan-Mode gate**
    like any MCP client — enforced server-side in the loop, honoring
    `IsDestructiveCommand` (56 cmds, `HaybaMCPCommandHandler.cpp:28/696`) and
    `bPlanApproved` (`HaybaMCPModule.h`). The gate must not be bypassable by a
    non-UI client.
  - Provider calls go only to the configured provider endpoint (baseURL from the
    provider catalog / custom registration) — no other egress.
- **Match existing patterns:** TS tools register via `STANDARD_DESCRIPTORS` +
  `registerTool` + `recordEagerSchemas` + `remember` (descriptor path, not the
  7-file churn); commit messages omit any `Co-Authored-By: Claude` trailer.
- **Model default:** Anthropic model id `claude-opus-4-8` (adaptive thinking); do
  not hardcode retired ids. Provider/model come from `providers.ts` + user config.
- **Do not regress** the shipped SEH guards, the ticker-based game-thread dispatch
  (`HaybaMCPTcpServer.cpp` `DrainPendingCommands`), or Code-Mode registration.

## Verified codebase state (leads confirmed against tree today)

- **In-tree, dormant C++** (still present): `HaybaMCPChatPanel.{h,cpp}`,
  `HaybaMCPClaudeClient.{h,cpp}` (dual-protocol Anthropic/OpenAI, single POST, no
  tools, no stream, `Cancel()` is a TODO), `HaybaMCPWizardPrompt.h` (graph-only
  system prompt), `HaybaMCPWizardState.h`, `HaybaMCPSettings.{h,cpp}` (plaintext key
  in `GEditorPerProjectIni`), `HaybaMCPSettingsPanel.{h,cpp}` (single key/baseURL/
  model, no provider dropdown), `HaybaMCPDeveloperSettings.{h,cpp}`. `SidecarURL`
  setting exists in all three settings headers.
- **Git-history-only (removed, must be restored):** `llm-client.ts` (`ac46d40`),
  the 8-provider catalog (`2849a75` `OPENAI_COMPAT_PRESETS`; `4d47e58`
  `ENV_KEY_BY_PROVIDER`/`BASE_URL_BY_PROVIDER`/`DEFAULT_MODEL_BY_PROVIDER`), web BYOK
  panel (`94b09a9`). `mcp-tools/hayba-mcp/package.json` has NO `@anthropic-ai/sdk`
  or `openai` dep. `src/agents/` carries only `agent-registry.ts` + `types.ts`.
- **Seams to reuse:** Express `registerApiRoutes` (`src/dashboard/api.ts:14`);
  `executeCommand` (`src/tools/tool-executor.ts:133`); `agent-registry.ts` archetype
  `tool_filter`; C++ `OnToolCallRecorded` multicast → feeds ToolStream + chat trace;
  Plan-Mode gate in `HaybaMCPCommandHandler.cpp`.

---

## Task 1 — providers.ts: restore the 8-provider BYOK catalog  [TS]

**Files:** `mcp-tools/hayba-mcp/src/agents/providers.ts` (new);
`tests/agents/providers.test.ts` (new).

**Change:** Merge the removed presets (`2849a75`) + env/baseURL/model maps
(`4d47e58`) into one module. 8 providers: `mock`, `anthropic`, and OpenAI-compat
`{openai, groq, openrouter, ollama, lmstudio, custom}`. Each entry:
`{id, label, baseURLDefault, defaultModel, needsKey, keyHint, protocol:'anthropic'|'openai'}`.
Add `registerCustomProvider(label, baseUrl, authHeader?, modelDefault?)`. No secrets
stored here — this is metadata only.

**Acceptance:** unit test asserts all 8 entries, protocol classification (anthropic
vs openai-compat), keyless flags for ollama/lmstudio/mock, and custom registration.
tsc clean; vitest green.

## Task 2 — llm-client.ts: restore + add tool-calling and streaming  [TS]

**Files:** `mcp-tools/hayba-mcp/src/agents/llm-client.ts` (restore from `ac46d40`);
`tests/agents/llm-client.test.ts`; `package.json` (add `@anthropic-ai/sdk`,
`openai`).

**Change:** Restore verbatim the `LLMTool`/`LLMToolCall`/`LLMResponse`
(`stopReason:'end_turn'|'tool_use'|'max_tokens'`) shape and `complete()`. Drive
provider/model/baseURL/key from `providers.ts` + injected config (not just env).
Add a `stream()` variant yielding normalized deltas + tool-call events (Anthropic
`messages.stream` with adaptive thinking + tool_use blocks; OpenAI `stream:true`
with `tool_calls`). Normalize both provider shapes into one delta/tool-call event
type. Anthropic default model `claude-opus-4-8`.

**Acceptance:** unit tests with a mocked provider HTTP client cover: tool mapping
(our tools → Anthropic `tools` and OpenAI `tools:[{type:'function'}]`), `tool_use`
vs `end_turn` parsing, streamed delta accumulation, and 401/429 error mapping. No
real network. tsc clean; vitest green.

## Task 3 — agent loop over the live tool registry, Plan-Mode gated  [TS]

**Files:** `mcp-tools/hayba-mcp/src/chat/agent-loop.ts` (new);
`tests/chat/agent-loop.test.ts`.

**Change:** Implement the async agentic loop: build `tools[]` from the live registry
(`get_tool_signature`/`list_tool_categories`), filtered by `DisabledTools` +
archetype `tool_filter` (`agent-registry.ts`). On each `tool_use`: if
`IsDestructiveCommand` and Plan Mode is on and not approved, emit a `plan_request`
event and pause instead of dispatching; otherwise dispatch via `executeCommand`
(→ TCP → C++), feed `tool_result` back, repeat until `end_turn` or `max_steps`.
Per-session token/step budget accounting. Never place the key in any event.

**Acceptance:** unit tests with fake tools + fake LLM client cover: multi-step
tool loop to `end_turn`; disabled/filtered tool refusal; destructive-tool →
`plan_request` pause with NO dispatch; budget/`max_steps` halt. tsc clean; vitest.

## Task 4 — sidecar SSE endpoint + key handshake  [TS]

**Files:** `mcp-tools/hayba-mcp/src/chat/chat-server.ts` (new); wire into
`src/dashboard/api.ts` `registerApiRoutes`; `tests/chat/chat-server.test.ts`.

**Change:** `POST /chat/stream` — opens a per-session agent loop and streams SSE
frames `{token|tool_call|tool_result|plan_request|done}`; final payload
`{assistant_text, tool_trace[], usage}`. `POST /chat/cancel` aborts an in-flight
session (implements the long-promised Cancel semantics). Session store for
resume-by-`session_id`+last-seq (avoid duplicate destructive ops on reconnect). The
sidecar reads the API key from the C++ vault via a localhost handshake; the key is
never returned in any response. Bind localhost only.

**Acceptance:** supertest-style test drives `/chat/stream` with a mocked loop:
asserts SSE framing, a `tool_call` frame, cancel stops the stream and returns
`partial_text`, and that no frame or log contains the key. tsc clean; vitest.

## Task 5 — copilot_* MCP tools (config/keys/introspection) as descriptors  [TS]

**Files:** `mcp-tools/hayba-mcp/src/tools/copilot/*.ts` (new, descriptor path);
register in `src/tools/index.ts` `STANDARD_DESCRIPTORS`; tests per tool.

**Change:** Ship the P0/P1 copilot tools from the `ai-copilot-chat-panel` domain:
`copilot_provider_list/set/test`, `copilot_model_list`, `copilot_key_status`
(masked last-4 via C++ proxy), `copilot_health` (sidecar_ok + ue_connected +
tools_available). `copilot_key_set/clear` proxy to C++ (Task 6); `key_clear` is
plan-gated. Verify/dry-run tools so an agent can self-check config without guessing.

**Acceptance:** each tool has a vitest test (mock provider probe / C++ proxy);
`copilot_key_status` never returns the raw key. tsc clean; vitest green.

## Task 6 — C++ DPAPI key vault + provider dropdown in Settings  [C++] [needs-rebuild]

**Files:** `HaybaMCPSettings.{h,cpp}` (replace plaintext
`GetSharedApiKey`/`SetSharedApiKey`), `HaybaMCPSettingsPanel.{h,cpp}`,
`HaybaMCPDeveloperSettings.{h,cpp}`.

**Change:** Stop writing the key plaintext to `GEditorPerProjectIni`. Encrypt with
Windows DPAPI (`CryptProtectData`/`CryptUnprotectData`), store ciphertext keyed by
provider id; decrypt on demand for the local sidecar handshake only. Replace the
single `LlmApiKeyBox` with a provider dropdown (auto-fills baseURL/default model/
key-hint, keyless badge for ollama/lmstudio/mock) backed by the Task 1 catalog
mirror. Redact the key everywhere (journal, logs). DPAPI is Windows-only — document
as a known limitation (matches the plugin's Win64 pinning).

**Acceptance:** code review vs cited file:line; smoke: set a key, confirm the
on-disk ini value is DPAPI ciphertext (not plaintext), `copilot_key_status` shows
masked last-4. Tagged `[needs-rebuild]`; no runtime claim from this env.

## Task 7 — C++ SSE consumer + Cancel in the LLM client  [C++] [needs-rebuild]

**Files:** `HaybaMCPClaudeClient.{h,cpp}` (rework to SSE consumer, or new
`FHaybaMCPAgentClient`).

**Change:** Switch from single request/response POST to consuming the sidecar SSE
stream (`SidecarURL` + `/chat/stream`); append deltas as they arrive. Hold the
`IHttpRequest` and implement `Cancel()` → `CancelRequest()` so `StopGeneration()`
works. Route tool-call/tool-result frames to the panel trace.

**Acceptance:** code review vs file:line; smoke: send a prompt, observe token
streaming and mid-stream cancel returning partial text. `[needs-rebuild]`.

## Task 8 — SHaybaMCPChatPanel: streaming, tool steps, Plan handoff  [C++] [needs-rebuild]

**Files:** `HaybaMCPChatPanel.{h,cpp}`, `HaybaMCPWizardPrompt.h`.

**Change:** Append streamed deltas into the in-progress bubble; render
`tool_use`/`tool_result` as collapsible steps fed by the existing
`OnToolCallRecorded` subscription (`ChatPanel.cpp:870`); on a `plan_request` frame,
route into `SHaybaMCPPlanPanel`/overlay for approval (existing `// TODO Q15-b`),
then resume. Replace the graph-only `GetHaybaMCPWizardSystemPrompt()` with an
agent/tool-surface system prompt (or let the server inject it). Persist sessions to
disk to light up `BuildRecentSessionsMenu` (Q8-b). Keep all existing toolbar/footer/
empty-state affordances.

**Acceptance:** code review vs file:line; smoke: "spawn a cube and validate naming"
streams tokens, shows a real tool trace, spawns the cube; a destructive prompt
pauses on the Plan panel and mutates only after approve; restart rehydrates a
persisted session. `[needs-rebuild]`.

## Sequencing & dependencies
TS-first: T1 → T2 → T3 → T4 → T5 (each independently testable with mocks), then
C++ T6 (vault/config) → T7 (SSE client) → T8 (panel). T5 depends on T1/T4; T6
unblocks T5's key proxy; T7/T8 depend on T4's SSE contract.

## Open questions (resolve at implementation time)
- Cross-platform key storage: DPAPI is Windows-only (matches the plugin's current
  Win64 pinning); revisit if the plugin goes cross-platform.
- The vault→sidecar key handshake mechanism (loopback HTTP vs shared file):
  decide in Task 4/6 with the constraint that the key never transits in cleartext
  beyond localhost and is never persisted outside the DPAPI blob.
