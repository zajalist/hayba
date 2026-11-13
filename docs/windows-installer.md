# Hayba Windows installer

The portable installer installs a **prebuilt editor plugin, Node runtime and MCP server** into a selected Unreal project. Teammates do not need Git, npm or Visual Studio for an engine build that matches the package. Their normal C++ project build requirements still apply.

## For teammates

1. Get the **Hayba Setup ZIP** from your teammate. Extract the whole ZIP.
2. Save and close the target project in Unreal.
3. Double-click **Install Hayba.exe**.
4. Browse to your `.uproject`. The installer detects matching Unreal installations; select the engine folder manually if needed.
5. Optionally select **Claude Code** and/or **Claude Desktop**, then click **Install Hayba**.
6. Open Unreal and **Tools → Hayba MCP Toolkit**. Restart Claude. Claude Code may ask you to approve the project's MCP configuration.

Ask Claude: “Use Hayba to check the Unreal connection, then list the actors in the current level without changing anything.”

All runtime files are copied into your project's `Plugins/HaybaMCPToolkit`. You can delete the extracted installer folder after installation. No machine-wide Node installation, registry edits or permanent execution-policy changes are made.

## Compatibility and configuration

The installer checks the engine's exact build ID, not just its `5.9` label. A mismatched engine requires a new package compiled and tested for that engine. The installer does not upgrade projects or bypass the compatibility check.

Claude Code receives a project `.mcp.json` entry. Claude Desktop receives an entry in the config path shown in the installer. If the app uses a different location, use **Config...** to choose the file opened by **Settings → Developer → Edit Config**. Existing MCP servers and other settings are preserved. The new server is named `hayba-<project-id>`, with a distinct name per project. Its bundled launcher uses the project as its working directory for editor discovery. Keep machine-specific absolute paths out of your shared repository.

This follows the official [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp) and [Claude Desktop local-server configuration](https://modelcontextprotocol.io/docs/develop/connect-local-servers). Claude handles its own model account; these MCP entries contain no API keys. In-editor chat has separate provider settings.

## Updating and recovery

Close the project's editor, builds, Claude MCP sessions and Hayba sidecar before updating. The installer reports matching blocking process IDs; it never kills an application. Select **Update existing Hayba** to back up and replace a physical plugin folder. Junctions at the plugin destination or its checked ancestors are refused.

A nested developer link such as `ThirdParty/mcp_server` is different: the installer
moves the whole physical old plugin folder into its backup, preserving the link
there without following or modifying its checkout target. The new installation
is self-contained. This migrates away from the developer link, so subsequent
checkout edits need a new build/install. Keep the old backup until the new
installation works.

Backups and `receipt.json` are kept under `<Project>/Saved/HaybaInstaller/backups/<operation>`. Failed configuration writes restore the previous plugin and files when they have not been changed concurrently. A failure during rollback reports the backup location for manual recovery. Keep backups until the updated project has been verified.

To restore manually, close the applications, move the new plugin out of `Plugins`, and move the backed-up plugin back. The receipt maps project/MCP config files to their backups. Do not overwrite newer edits with an old full-file config backup.

## For maintainers

Files:

- `tools/installer/Install.ps1`: native project picker and command-line entry point.
- `tools/installer/Installer.Core.ps1`: shared validation, staging, installation and rollback.
- `tools/installer/Launcher.cs`: small Windows GUI launcher.
- `tools/installer/package-runtime.mjs`: copies the installed production dependency graph, preserving nested versions and package licenses.
- `tools/build-installer.mjs`: builds the portable distribution from an explicitly verified native artifact.
- `tools/installer.test.cjs`: disposable boundary/rollback and dependency-packaging tests.
- `tools/installer/smoke.mjs`: real installation into a new disposable project and bundled Node/MCP handshake.

Build the server first with `npm run build:server -w @hayba/mcp`. The native verification manifest must identify the tested DLL, report path/hash and artifact hashes; this matches the existing `Saved/chat-ui-build/workspace-install.json` format. The builder refuses a DLL different from the tested artifact.

```powershell
node tools/build-installer.mjs --artifact "D:/path/to/verified/HaybaMCPToolkit" --verification "D:/path/to/workspace-install.json" --engine "C:/Program Files/Epic Games/UE_5.9" --output "D:/NewHaybaInstallerBuild"
```

Use a new output folder. The builder verifies its Windows x64 Node executable against [Node's official release checksums](https://nodejs.org/dist/), includes the corresponding license, bundles installed production dependency versions, records per-file SHA256 hashes and emits a ZIP plus a ZIP checksum. It does not include personal settings, API keys, chats, workspace junctions or the repository's development dependencies. The optional visual sidecar and its Python/model downloads are not bundled.

Verification:

```powershell
node --test tools/installer.test.cjs
node tools/installer/smoke.mjs "D:/NewHaybaInstallerBuild/Hayba Setup" "C:/Program Files/Epic Games/UE_5.9" "D:/NewDisposableInstallTest"
```

The smoke test uses isolated Claude configuration and user-state directories, not real account settings. Use the resulting disposable project for a headless Unreal load check with `-HaybaAutomationChild`, `-nullrhi` and `-NoAssetRegistryCache`. Explicitly select an owned cache, as in the qualified runs:

```text
-DDC=(EnginePak=InstalledEnginePak,Local=(Type=FileSystem,Path=D:/YourOwnedTestCache/ddc)) -DDC-NoDefaultGraph
```

Choose a disposable cache path owned by the test. Default DDC startup can restart
a shared Zen service even when the project and user profile are isolated; see
[the recorded incident](audit/2026-11-13-editor-upgrade.md#test-isolation-and-known-incident).
Do not equate MCP startup or native automation with verification of every game's Play-in-Editor behavior.

CLI install/check mode uses the same core as the picker:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\installer\Install.ps1" -PackageRoot "." -Project "C:\Projects\Game\Game.uproject" -Engine "C:\Program Files\Epic Games\UE_5.9" -CheckOnly
```

Remove `-CheckOnly` to install. Optional switches are `-ClaudeCode`, `-ClaudeDesktop` and `-ReplaceExisting`; `-DesktopConfig` selects an explicit Claude Desktop config file.

This is currently an **unsigned maintainer-built development package**, not a newly published GitHub release. Share the ZIP checksum independently when distributing it. Source-tag installation remains available in [the source setup guide](team-setup.md).
