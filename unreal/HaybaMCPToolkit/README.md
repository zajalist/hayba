# Hayba MCP Toolkit — Unreal Engine 5 plugin

The **UE5 C++ editor plugin** half of Hayba. It runs a TCP server inside the
editor and executes commands dispatched by the Node MCP server in
[`mcp-tools/hayba-mcp`](../../mcp-tools/hayba-mcp). Together they form one
protocol across two language boundaries — see [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)
and [`CONTEXT.md`](../../CONTEXT.md).

- **Plugin:** `HaybaMCPToolkit` · Editor module · `LoadingPhase: PostEngineInit`
- **Engine:** UE 5.9 (5.7 and 5.8 not tested for 0.4.1) · depends on the `PCG` plugin
- **Version:** see `HaybaMCPToolkit.uplugin`

## Install

For a step-by-step guide, see [INSTALL.md](../../INSTALL.md).

Build the MCP server first (`npm install`, then
`npm --prefix mcp-tools/hayba-mcp run build` from the repo root). Create
`<YourProject>\Plugins` if it doesn't exist, then link this folder into it
from an administrator prompt (or with Windows Developer Mode on), regenerate
Visual Studio project
files, and rebuild (Windows; UE 5.9; Visual Studio with the C++ toolchain your Unreal Engine version requires):

```bat
mklink /D "<YourProject>\Plugins\HaybaMCPToolkit" "<repo>\unreal\HaybaMCPToolkit"
```

To make the chat server available to either a copied or linked plugin, run this from the checkout after `npm run build:server -w @hayba/mcp`:

```powershell
./tools/link-chat-sidecar.ps1 -Project 'P:/YourGame/YourGame.uproject'
```

This creates a junction at the plugin's `ThirdParty/mcp_server`, including the server's dependencies. Keep the checkout in place. It refuses to overwrite an existing server installation. New plugin builds start a stopped sidecar when you send a message and wait for its health check; older builds need an editor restart after linking. Chat retains the message if startup fails. An unrelated HTTP service is never treated as a chat server.

Alternatively, set `SidecarEntryPath` under `[HaybaMCPToolkit]` in `<YourProject>/Saved/Config/WindowsEditor/EditorPerProjectUserSettings.ini` to the full path of `mcp-tools/hayba-mcp/dist/index.js` while the editor is closed.

Build artifacts (`Binaries/`, `Intermediate/`, `Saved/`, `DerivedDataCache/`,
`.vs/`) are intentionally **not** tracked — UBT regenerates them.

The in-editor workspace opens directly into Chat. More contains Activity
(live calls, changes and checks), Subagents, Connections, Fab assets, Editor status,
Settings and keyboard help. The World/semantic-map tab has
been removed; world inspection remains available through chat and agent tools.
The composer starts in Inspect mode with read-only access. Draft and Production
retain exact-call approval for edits.

Chat renders its complete workspace from bundled `Resources/chat` HTML/CSS/JavaScript
inside Unreal's existing WebBrowser module, including history, searchable model
menus, effort/access controls, context attachments and the composer. Native Slate
owns execution, session state, credential entry and exact-operation review. The
page has no network access or API keys and accepts only a native state projection.
A document-scoped, allowlisted bridge routes user actions back to existing handlers.
Missing resources, browser errors or an eight-second startup timeout restore the
full native interface without discarding the conversation or draft.
Package `Resources/chat`, `Resources/Fonts` and `Resources/HaybaLogo.svg` with
the plugin; there is no separate frontend server or build step.

The navigator groups searchable Threads, This chat and Agents. Thread metadata
is searched/paged on the sidecar (50 per page); the conversation renders at most
80 messages at once and can jump directly to matching turns. Whole transcripts
still load from JSON. Streaming sends changed message rows after a negotiated full
snapshot; missing revisions resync without losing history or selection. The main agent calls `delegate_task` when a separate inspection
helps, then receives the findings automatically. Delegated work appears inline;
Agents is a viewer, not a manual task launcher. Read-only children have independent
context, tool traces, cancel controls and retained findings; they cannot edit or
recursively delegate.
Community API sessions are supported, with three active children per parent,
two-minute execution limits and the latest 30 bounded summaries retained.

Assets & media opens Fab's genuine native interface and connects Meshy, Tripo and Aholo/Lux3D for models, fal.ai for video,
and World Labs for splat worlds through the local sidecar. Keys are
entered in a native password dialog and saved in the existing DPAPI vault; every
credential-bearing request first checks the sidecar's identity. Generations use
provider credits only when explicitly submitted. Meshy texture refinement is a
separate paid action. Jobs and result links stay in the current tab; polling stops
after ten minutes. Open results or add them to a chat draft for import review.
Fal key storage remains explicitly unverified until a real generation; no paid
probe is performed merely to connect. The UI does not automatically download or
import media. Provider contracts and
limits are documented in `mcp-tools/hayba-mcp/src/generation3d/README.md`.

Fab catalog and library searches use the optional UE 5.9 Fab API through
`fab_search` and `fab_search_status`. Jobs are caller-owned, bounded, and expire;
search completion never means an asset was imported. In chat, use **Assets & media
→ Browse Fab assets → Open Fab in Unreal**, then **My Library → Add to Project**
in Fab. Select the imported content and choose **Attach selected assets** to let
Hayba inspect it. Purchases, license acceptance and imports stay in Epic's UI.
Fab disabled or unavailable produces an actionable error rather than preventing
Hayba from loading.

**Editor status** shows the current native listener and fault guard, project,
process and exact engine build. Refresh and Copy summary do not alter the draft
or disclose credentials. Listener availability does not establish that the chat
sidecar or provider account is working; a message checks the sidecar separately.

`chooser_inspect` requires the optional **Chooser** plugin on UE 5.9. It pages
primary rows/columns and reports unavailable or clipped values explicitly.
`asset_validate` defaults to at most 100 primary assets (maximum 1000), refuses
larger folders before validation, and only reports `valid:true` for complete,
non-cancelled validation with no invalid assets. Validator callbacks themselves
are not a hard time or memory sandbox.

For browser UI testing, run `node tools/chat-ui-preview.mjs` from the repository.
It serves the same workspace with an explicitly simulated host and never accepts
API keys or calls a provider. The collapsed Test controls menu supplies fixtures.

After updating plugin C++ or SVG resources, close the editor and rebuild the
plugin before reopening. A running editor keeps the old module DLL loaded.

## The TCP seam

`FHaybaMCPTcpServer` listens on `:52342` (auto-fallback `:52343-52350`) and
speaks a length-prefixed JSON envelope (`{ cmd, id, params, auth? }`). The
Node side (`mcp-tools/hayba-mcp/src/tcp-client.ts`) is the other adapter on
this seam; the two must agree on the envelope. Port discovery is published
to `Saved/HaybaMCP/instances/<pid>.json` for multi-editor setups.

Destructive commands run inside `GEditor->BeginTransaction`, and with Plan Mode
on (the default) they wait until the user approves the plan. Most editor edits land on Unreal's normal undo stack, so Ctrl+Z works — not during Play-In-Editor, and not for asset deletes, saves to disk or arbitrary Python.

## Command-handler domains (30+)

Each domain implements `IHaybaMCPHandler` (`GetCommands()` / `Handle()`),
registered in `HaybaMCPModule`:

`Actor` · `Animation` · `Asset` · `Audio` · `BehaviorTree` · `Blueprint` ·
`Build` · `DataAsset` · `Docs` · `Editor` · `Foliage` · `GAS` · `ISM` ·
`Input` · `Legacy` · `Level` · `Material` · `MetaSound` · `Network` ·
`Niagara` · `PIE` · `Perf` · `Physics` · `Project` · `Python` ·
`SceneGraph` · `Sequencer` · `Spline` · `StaticMesh` · `Test` · `Texture` ·
`UI` · `WorldPartition`

## Source layout

```
Source/HaybaMCPToolkit/
  Public/   IHaybaMCPHandler.h · HaybaMCPCommandHandler.h · HaybaMCPModule.h
  Private/  module, TCP server, settings, Slate panels
  Private/handlers/  one *Handler.cpp per domain above
Resources/  icons, fonts, PCGEx registry DB, embedded chat workspace
```

## Provenance

Snapshot-imported from an external UE project tree (its local git
history is not authoritative). Treat this directory as the canonical
source. See ADR [`docs/adr/0004-ue-plugin-location.md`](../../docs/adr/0004-ue-plugin-location.md).
