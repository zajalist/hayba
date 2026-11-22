# Hayba Windows installers

Each release ships two per-user Setup programs (no admin, no Git/npm/Node/Visual Studio):

- **Hayba-Setup-&lt;version&gt;-Plugin+MCP.exe**: installs the plugin into a chosen `.uproject` and registers the bundled MCP server for Claude Code (project `.mcp.json`), Claude Desktop (`%APPDATA%\Claude\claude_desktop_config.json`) and Cursor (`%USERPROFILE%\.cursor\mcp.json`).
- **Hayba-Setup-&lt;version&gt;-Plugin.exe**: installs only the plugin.

Both copy the prebuilt UE 5.9 Win64 plugin, a bundled Node runtime and the prebuilt MCP server into `<Project>/Plugins/HaybaMCPToolkit`. Screens: choose project, install, finished.

## Behaviour

- **Engine:** any installed Unreal 5.9.x is accepted. When its build ID differs from the build Hayba was compiled on (a launcher hotfix), the installer stamps the engine's build ID into the plugin's `UnrealEditor.modules`. Launcher hotfixes of one minor version keep the same ABI, which is also how Marketplace plugins load. Any other version is refused with no changes.
- **Safety:** close the project in Unreal first; the installer refuses while Unreal, a build or a Hayba server uses the project and never kills processes. An existing plugin and every config file it changes are backed up to `<Project>/Saved/HaybaInstaller/backups/<operation>` with a `receipt.json`. Failures roll back. Existing MCP servers and settings are preserved; Hayba's entry is named `hayba-<project-id>`.
- **Uninstall:** Settings > Apps > "Hayba &lt;version&gt; (…)". It removes the plugin (moved to `<Project>/Saved/HaybaInstaller/removed-*`), the `.uproject` entry and this project's MCP entries, for every project that Setup installed into.
- **Silent use:** `Setup.exe /VERYSILENT /PROJECT="C:\Game\Game.uproject" /CLIENTS=code,desktop,cursor` (omit `/CLIENTS` to use the detected defaults).

## For maintainers

Files:

- `tools/installer/hayba-setup.iss`: Inno Setup 6 script for both variants (`/DWithMcp=1|0`).
- `tools/installer/Install.ps1`: command-line entry point the Setup programs call (install and `-Uninstall`).
- `tools/installer/Installer.Core.ps1`: validation, staging, installation, rollback and uninstall.
- `tools/installer/package-runtime.mjs`: copies the production dependency graph with licenses.
- `tools/build-installer.mjs`: builds the payload and both Setup programs.
- `tools/installer.test.cjs` / `tools/installer/test-core.ps1`: boundary, rollback, hotfix and uninstall tests.
- `tools/installer/smoke.mjs`: real installation into a disposable project plus a bundled Node/MCP handshake.

Install [Inno Setup 6](https://jrsoftware.org/isdl.php) (per-user is fine; set `HAYBA_ISCC` if ISCC.exe is elsewhere), build the server with `npm run build:server -w @hayba/mcp`, then:

```powershell
node tools/build-installer.mjs --artifact "D:/path/to/compiled/HaybaMCPToolkit" --engine "C:/Program Files/Epic Games/UE_5.9" --output "D:/NewHaybaInstallerBuild" [--verification "D:/path/to/workspace-install.json"]
```

`--artifact` is a plugin folder containing `Binaries/Win64/UnrealEditor-HaybaMCPToolkit.dll` compiled against that engine. With `--verification`, the builder refuses a DLL different from the one a passing native test report names. The builder verifies its Node executable against [Node's official checksums](https://nodejs.org/dist/), records per-file SHA256 hashes and writes a `.sha256` next to each Setup program. It never includes personal settings, API keys, chats or `.pdb` files.

```powershell
node --test tools/installer.test.cjs
```
