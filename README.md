<div align="center">
  <img src="unreal/HaybaMCPToolkit/Resources/HaybaLogo.svg" width="56" alt="">
  <h1>Hayba</h1>
  <p>Inspect and edit Unreal Engine projects with an AI assistant.</p>
  <p><a href="https://github.com/zajalist/hayba/releases/download/desktop-v0.1.0-preview.3/Hayba-Desktop-Setup.exe"><strong>Download Hayba Desktop for Windows (.exe)</strong></a> · <a href="https://github.com/zajalist/hayba/releases/tag/v0.4.2"><strong>Download the v0.4.2 plugin</strong></a> · <a href="INSTALL.md">Installation guide</a> · <a href="docs/wiki/">Tool reference</a></p>
</div>

## Get started

Use a closed Unreal Engine 5.9 project on Windows x64. The release bundles the native plugin, Node runtime, and MCP server.

1. Download **Plugin** for chat inside Unreal, or **Plugin+MCP** to also connect an external client such as Claude Code or Cursor. [Windows installers](https://github.com/zajalist/hayba/releases/tag/v0.4.2)
2. Run Setup and select the project’s `.uproject` file.
3. Open the project and choose **Tools → Hayba MCP Toolkit**. In Settings, select a provider and enter your API key. Windows encrypts the saved key for your user account.
4. Start with a read-only question such as “Which actors are in this level?” Review the result before asking for an edit.

**Known issue in v0.4.2.** In-editor chat can stay on “Responding…” when the bundled server fails to start. The Desktop preview includes fixes for server startup and repeated chat initialization. [Preview build instructions](https://github.com/zajalist/hayba/tree/feature/desktop-preview/desktop)

## How it works

The TypeScript MCP server translates tool calls into editor operations. The C++ plugin reads the current scene, checks editor state and ownership, and returns the result. For example, when two agents target the same asset, an editor lease lets the second agent see that the first one is still working. [Architecture](docs/ARCHITECTURE.md) · [Editor checks and approvals](docs/safety-model.md)

![Agent requests passing through the MCP server and native editor checks](docs/media/safety-boundary.svg)

## Hayba Desktop preview

Hayba Desktop is a Windows chat workspace built with React and Radix UI. Use your OpenAI or Anthropic API key, find conversations with **Ctrl+K**, and select **Unreal level** in the composer to share the active map, actor count and play state of an open project. The Unreal panel handles reviewed editor changes. [Desktop source and build instructions](https://github.com/zajalist/hayba/tree/feature/desktop-preview/desktop)

![Hayba Desktop workspace](https://raw.githubusercontent.com/zajalist/hayba/ee7e69c0c4f015c4cdeab0ca5881abf3646208ce/desktop/media/workspace.png)

Download **Hayba-Desktop-Setup.exe** from the [Windows Desktop preview](https://github.com/zajalist/hayba/releases/tag/desktop-v0.1.0-preview.3). Leave the project field blank for Desktop alone, or select a closed UE 5.9 project to install the editor panel. If the panel is missing after reopening the project, check **Edit → Plugins → Hayba MCP Toolkit** and restart Unreal after enabling it.

To remove Desktop and its project integration, close Hayba and Unreal, then select **Windows Settings → Apps → Installed apps → Hayba Desktop Preview → Uninstall**. Setup keeps a backup of removed plugin files in the project's `Saved/HaybaInstaller` folder.

## Explore the code

| Component | What lives there |
| --- | --- |
| [Unreal plugin](unreal/HaybaMCPToolkit/) | Chat workspace, native command handlers, and editor automation tests |
| [MCP server](mcp-tools/hayba-mcp/) | Tool schemas, provider clients, and request routing |
| [Architecture decisions](docs/adr/) | The design decisions behind coordination, permissions, and optional integrations |

[Release history](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE)
