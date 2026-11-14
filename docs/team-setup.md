# Install Hayba in Unreal and connect Claude

**Have a Hayba Setup ZIP from your teammate?** Use the [Windows installer](windows-installer.md): extract it, open **Install Hayba.exe**, choose your project, and click Install. It recompiles Hayba on that PC (needs Visual Studio C++ tools), then you enter an API key in Hayba Settings to use in-editor chat. The source-build instructions below are the fallback.

For teammates on **Windows with Unreal Engine 5.9**. Run the commands in **PowerShell**, in order, keeping the same window open. Stop if a command reports an error.

This guide installs the published **v0.4.3** source release. A first installation requires compiling the Unreal plugin. Local, unpublished changes are not included; use the team's agreed release tag when a newer build is published. See the [release](https://github.com/zajalist/hayba/releases/tag/v0.4.3).

## 1. Check the prerequisites

- Unreal Engine **5.9** and your project.
- **Node.js 22.5 or newer** and **Git**.
- Visual Studio's **Game development with C++** workload, including the compiler and Windows SDK required by your Unreal installation. This is needed even for a Blueprint-only project when building this source plugin. Follow [Epic's setup instructions](https://dev.epicgames.com/documentation/en-us/unreal-engine/setting-up-visual-studio-development-environment-for-cplusplus-projects-in-unreal-engine).
- Claude Code or the Claude desktop app, installed and signed in.

If Node or Git is missing:

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
```

Reopen PowerShell after installing them. Check:

```powershell
git --version
node --version
```

For Claude Code, follow [Anthropic's installation instructions](https://code.claude.com/docs/en/setup). You can use `winget install --id Anthropic.ClaudeCode -e`, then reopen PowerShell and run `claude` to sign in.

## 2. Download and build Hayba

Set these paths first. **Change the project path** to your actual `.uproject` file. Change the engine path if Unreal is installed elsewhere.

```powershell
$ErrorActionPreference = 'Stop'
$ProjectFile = 'C:\Projects\MyGame\MyGame.uproject'
$Engine = 'C:\Program Files\Epic Games\UE_5.9'
$HaybaRepo = 'C:\Tools\hayba'

if (-not (Test-Path -LiteralPath $ProjectFile)) { throw 'Fix the .uproject path first.' }
$ProjectDir = Split-Path -Parent $ProjectFile

git clone --branch v0.4.3 https://github.com/zajalist/hayba.git $HaybaRepo
if ($LASTEXITCODE -ne 0) { throw 'Clone failed. Stop and check the message above.' }
Set-Location $HaybaRepo
npm install
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
npm run build:server -w @hayba/mcp
if ($LASTEXITCODE -ne 0) { throw 'Server build failed.' }
```

This builds the MCP server and its workspace dependency. The separate web dashboard build is not required for Claude's MCP connection.

## 3. Add Hayba to your project

Save your work and close Unreal before compiling. These commands create local folder links; they do not copy or replace an existing plugin. If Hayba is already installed, ask the teammate maintaining that installation before changing it.

```powershell
$Plugin = Join-Path $ProjectDir 'Plugins\HaybaMCPToolkit'
if (Test-Path -LiteralPath $Plugin) { throw 'Hayba already exists in this project. Do not overwrite it.' }

New-Item -ItemType Directory -Path "$ProjectDir\Plugins" -Force | Out-Null
New-Item -ItemType Junction -Path $Plugin -Target "$HaybaRepo\unreal\HaybaMCPToolkit" | Out-Null
New-Item -ItemType Directory -Path "$Plugin\ThirdParty" -Force | Out-Null
New-Item -ItemType Junction -Path "$Plugin\ThirdParty\mcp_server" -Target "$HaybaRepo\mcp-tools\hayba-mcp" | Out-Null
```

Keep `C:\Tools\hayba` in place: both links depend on it. The second link makes the built server available to the plugin's in-editor chat. Each teammate creates their own links; do not copy another person's junctions as a plugin distribution.

Compile the editor target:

```powershell
$EditorTarget = 'UnrealEditor'
& "$Engine\Engine\Build\BatchFiles\Build.bat" $EditorTarget Win64 Development "-Project=$ProjectFile" -WaitMutex
if ($LASTEXITCODE -ne 0) { throw 'Unreal build failed. Read the first error above before continuing.' }
```

For a project with its own C++ editor target, use that target instead of `UnrealEditor`—for example, `MyGameEditor` for `Source\MyGameEditor.Target.cs`. Your project's existing build instructions should identify it.

Open the project. In **Edit → Plugins**, search for **Hayba MCP Toolkit** and enable it if needed. Restart when prompted. Open **Tools → Hayba MCP Toolkit**.

In Unreal's **Output Log**, search for `TCP server started on port`. Note the port—normally **52342**—and leave this project open. For the first connection, keep other Unreal projects closed.

## 4. Connect Claude — choose one

### Claude Code

Run this from your **game project's folder**, not the Hayba checkout:

```powershell
Set-Location $ProjectDir
claude mcp add --scope local --transport stdio hayba-toolkit -- node "$HaybaRepo\mcp-tools\hayba-mcp\dist\bootstrap.js"
claude mcp list
claude
```

Inside Claude Code, enter `/mcp` and check that `hayba-toolkit` is connected. Local scope keeps this setup private to you in this project. Always start Claude Code from the game folder so Hayba can discover that project's running editor. These commands follow [Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp).

If an entry with this name already exists, inspect it with `claude mcp get hayba-toolkit` before replacing it.

### Claude Desktop

Open **Settings → Developer → Edit Config**. On Windows this normally opens `%APPDATA%\Claude\claude_desktop_config.json`; use the app's Edit Config button to locate the active file.

Add the entry below. **Keep any existing servers**: merge `hayba-toolkit` into the existing `mcpServers` object rather than replacing the file. Set `UE_TCP_PORT` to the port shown in Unreal's Output Log.

```json
{
  "mcpServers": {
    "hayba-toolkit": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["C:/Tools/hayba/mcp-tools/hayba-mcp/dist/bootstrap.js"],
      "env": {
        "UE_TCP_PORT": "52342"
      }
    }
  }
}
```

If Node is installed elsewhere, run `(Get-Command node).Source` in PowerShell and use that absolute path. Forward slashes are valid in these JSON paths.

Save the file, **fully quit Claude Desktop**, and reopen it. Check its local MCP server settings for `hayba-toolkit`. This uses the [official local MCP setup](https://modelcontextprotocol.io/docs/develop/connect-local-servers). It is a local process connection, not a website URL to paste into Claude's remote connector dialog.

## 5. Confirm it works

With Unreal open, ask Claude:

> Use Hayba to run hayba_check_ue_status. Tell me whether Unreal is connected and report its engine and plugin versions. Then list the actors in the current level without changing anything.

You should get a successful connection and real actor names from the level. An MCP server showing “connected” only confirms Claude can reach the Node process; this prompt checks the Unreal connection too.

For later edits, approve Claude's requested tools and any operation review shown by Hayba in Unreal. A request waiting for editor approval has not completed yet.

**No separate Anthropic API key is needed in Hayba for this MCP setup.** Claude handles its own model access. Hayba's optional in-editor chat has separate provider/model/key settings.

## If something goes wrong

| Symptom | Fix |
| --- | --- |
| `node`, `git`, or `claude` is not recognized | Reopen PowerShell after installation. Check the corresponding `--version` command. |
| Plugin modules are missing or built for another engine | Close Unreal and rebuild with the engine installation and editor target used by this project. Do not reuse another engine version's DLL. |
| Build says Live Coding is active or a DLL is locked | Close the editor holding that module, then rerun the build. |
| MCP connects but Unreal does not, or the wrong project responds | Verify the intended project is open. In Claude Code, launch from its project folder. In Desktop, match `UE_TCP_PORT` to that editor's Output Log and restart Claude after changing it. A fallback port can change after reopening Unreal. |
| Claude Code needs an explicit port | From the game folder, remove the old local entry with `claude mcp remove --scope local hayba-toolkit`, then register with `claude mcp add --scope local --env UE_TCP_PORT=52343 --transport stdio hayba-toolkit -- node "$HaybaRepo\mcp-tools\hayba-mcp\dist\bootstrap.js"`, using the actual port. |
| Claude Desktop cannot start Node | Use the full Node executable path returned by `(Get-Command node).Source`; check that `dist/bootstrap.js` exists. |
| In-editor chat says its sidecar is unavailable | Check `Plugins\HaybaMCPToolkit\ThirdParty\mcp_server\dist\index.js` exists, the server build succeeded, and Node is installed. Restart Unreal after linking. Record the exact error if it persists. |
| An edit waits for approval | Review it in Hayba's Chat panel in Unreal. |

When reporting a problem, send the failed step, exact error, engine version, and relevant Hayba Output Log lines. Do not include API keys.

## Updating the team

Agree on one published tag or commit. Close Unreal and Claude's Hayba MCP sessions, update the checkout, rerun `npm install` and the server build, then rebuild the Unreal target. Reopen Unreal and Claude and repeat the connection check. Keep plugin source and MCP server on the same revision.

Release `v0.4.3` is the in-editor Chat workspace and the standalone Hayba app that serves the same HTML. Teammates should install that tag, not an older `v0.4.1` clone.
