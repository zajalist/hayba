<div align="center">

<img src="unreal/HaybaMCPToolkit/Resources/HaybaLogo.svg" width="66" alt="Hayba mark" />

# Hayba

**Build Unreal worlds with agents that can share an editor.**

Inspect, plan, build, and validate Unreal Engine worlds through MCP. Native editor checks keep agent work accountable to the state of the project.

**[Download the Hayba 0.4.2 installers](https://github.com/zajalist/hayba/releases/tag/v0.4.2)** (Windows, Unreal Engine 5.9)

[Explore the architecture](docs/ARCHITECTURE.md) | [Browse the tools](docs/wiki/) | [Changelog](CHANGELOG.md) | [Contribute](CONTRIBUTING.md)

</div>

Hayba connects MCP-capable agents to Unreal Editor. It gives them a wide tool library, a focused in-editor workspace, and a native safety boundary for changes to a shared project.

> **Release status:** `v0.4.2` is the latest release. It is tested on Unreal Engine 5.9 (5.7 and 5.8 may work but were not tested for this release) and ships the new editor workspace, multi-agent editor leases and the editor safety train. See the [changelog](CHANGELOG.md) and [versioning](docs/VERSIONING.md).

The development workspace now opens directly into Chat, with searchable threads,
model and access controls, context attachments, delegated-agent results, Fab
browsing and media connections. The old World/semantic-map tab is removed;
scene inspection remains available to agents through the tool catalog.
See the [workspace guide](unreal/HaybaMCPToolkit/README.md) for the unreleased UI
and the [changelog](CHANGELOG.md) for its verification scope.

## Install (Windows, Unreal Engine 5.9)

No Git, npm, Node or Visual Studio needed. Node and the MCP server are bundled. Both installers run without admin rights and add an uninstaller under **Settings > Apps**.

**Option 1: Plugin + MCP** (use Hayba from Claude Code, Claude Desktop or Cursor, and in the editor)

1. Download **Hayba-Setup-0.4.2-Plugin+MCP.exe** from the [latest release](https://github.com/zajalist/hayba/releases/latest) and close your project in Unreal.
2. Run it, choose your `.uproject`, tick the apps to connect, and click **Install**.
3. Open the project in Unreal 5.9, then restart your AI app and ask it to "check the Hayba Unreal connection".

**Option 2: Plugin only** (in-editor chat, no external AI apps)

1. Download **Hayba-Setup-0.4.2-Plugin.exe** from the [latest release](https://github.com/zajalist/hayba/releases/latest) and close your project in Unreal.
2. Run it, choose your `.uproject`, and click **Install**.
3. Open the project, then **Tools > Hayba MCP Toolkit > Settings**: pick a provider, paste your API key, and click **Save**. The key is stored encrypted with Windows DPAPI.

Any Unreal 5.9.x launcher install works. Other engine versions are refused with a clear message and no changes. For a source build, see [INSTALL.md](INSTALL.md).

## See the workflow

A typical request is concrete: *“Inspect this level, propose a route to the focal point, then make the approved changes.”* Hayba exposes the scene and relevant tools, lets the agent prepare a reviewable plan, and checks the editor before writes. [The install guide](INSTALL.md) walks through setup step by step.

## Why Hayba

| Strength | What it means in practice | Status |
| --- | --- | --- |
| **Tools for actual production work** | Actors, assets, levels, Blueprints, PCG, materials, UI, physics, animation, audio, tests, and project operations. Agents can discover signatures as needed instead of loading the whole catalog at once. | Available |
| **Shared-editor coordination** | Owner-bound leases and busy-asset rules turn competing writes into explicit refusals. Bounded batches stop when editor state changes. The orchestrator can respond instead of guessing what happened. | Available in `0.4.1` |
| **Native crash and state guards** | A contained native fault leaves the editor in a sticky unsafe state. Play, dirty Blueprints, read-only saves, and unattended execution receive checks at the editor boundary. | Available in `0.4.1` |
| **Reviewable changes** | Plan Mode can require approval before destructive steps. Supported operations use Unreal undo transactions; structured results expose refusals and partial work. | Available; expanded in `0.4.1` |
| **Asset workflows in chat** | Search Fab, open its native library, attach imported selections, inspect Chooser tables and validate bounded asset sets. Media providers support explicit generation requests. | Development branch; optional plugins/providers required |

The [tool reference](docs/wiki/) covers individual operations. Optional [GAS and MetaSound plugins](docs/adr/0008-satellite-plugins-earn-their-place.md) extend the core. The distinction is how the tools work together under a shared editor's live constraints.

## See the safety boundary

![Two agents route requests through the MCP server to native editor checks; allowed writes reach Unreal Editor and blocked writes return a structured reason](docs/media/safety-boundary.svg)

The [TypeScript MCP server](mcp-tools/hayba-mcp/) routes requests to the [C++ editor plugin](unreal/HaybaMCPToolkit/). The editor plugin checks state and ownership where writes actually happen. The [visual sidecar](mcp-tools/hayba-mcp/addons/visual-embeddings/) is optional. [Explore the architecture](docs/ARCHITECTURE.md).

## Safety is part of the workflow

Release `0.4.1` includes a coordinated set of protections: sticky refusal after a contained native fault, PIE and asset-busy checks, guarded save paths, owner-bound leases with recovery, and bounded batch execution. These address a shared editor's real failure modes: one agent can hold a resource while another reads stale state, Play can begin during a build, or a native fault can leave the editor unsafe for more writes. [The scratch-host safety guide](docs/SAFETY-scratch-host-and-leases.md) records the live verification boundaries.

Hayba does not treat every refusal as failure. A structured refusal tells the agent whether to wait, refresh state, request a lease, stop Play, or return control to the user. Plan Mode requires approval for destructive commands when enabled; owner-bound leases, PIE and editor-health guards apply independently. Native undo covers supported operations, with documented exceptions. [Read the safety model](docs/safety-model.md) · [Security policy](SECURITY.md) · [Decision records](docs/adr/)

## Install

**Requirements:** Windows, Unreal Engine 5.9, Node.js 22.5 or newer, Git, and the Visual Studio C++ tools Unreal uses to compile plugins. The optional visual sidecar has separate Python dependencies.

**[Follow the step-by-step install guide](INSTALL.md).** It covers every click and command, how to check each part works, and a troubleshooting table. The short version, in PowerShell:

```powershell
git clone --branch v0.4.1 https://github.com/zajalist/hayba.git C:\Tools\hayba
Set-Location C:\Tools\hayba; npm install; npm run build
$Project = "C:\path\to\YourProject"   # the folder with your .uproject
New-Item -ItemType Directory -Force "$Project\Plugins"
New-Item -ItemType Junction -Path "$Project\Plugins\HaybaMCPToolkit" -Target "C:\Tools\hayba\unreal\HaybaMCPToolkit"
& "C:\Program Files\Epic Games\UE_5.9\Engine\Build\BatchFiles\Build.bat" UnrealEditor Win64 Development -Project="$((Get-ChildItem $Project -Filter *.uproject).FullName)" -WaitMutex
claude mcp add hayba-toolkit -- node C:\Tools\hayba\mcp-tools\hayba-mcp\dist\bootstrap.js
```

Then open the project. The **Hayba MCP Toolkit** panel opens by itself the first time (later: **Tools > Hayba MCP Toolkit**). Start with a scratch project while evaluating any tool that can modify editor state. [Getting started](docs/getting-started.md) covers add-ons and other MCP hosts.

## Explore the repository

| Area | Purpose |
| --- | --- |
| [`unreal/HaybaMCPToolkit`](unreal/HaybaMCPToolkit/) | Native editor integration and tool handlers |
| [`mcp-tools/hayba-mcp`](mcp-tools/hayba-mcp/) | MCP server, schemas, and tool routing |
| [`docs/wiki`](docs/wiki/) | Tool and workflow reference |
| [`docs/adr`](docs/adr/) | Architecture decisions |
| [`website`](website/) | Public Hayba site |

Developers can run `npm --prefix mcp-tools/hayba-mcp test` for the Node gate. Unreal tests require a separately built project; [CONTEXT.md](CONTEXT.md) and [the architecture guide](docs/ARCHITECTURE.md) explain the boundaries before changing them.

<div align="center">

**A worldbuilding tool should understand the world—and know when to stop.**

[Getting started](docs/getting-started.md) · [Changelog](CHANGELOG.md) · [License](LICENSE)

</div>
