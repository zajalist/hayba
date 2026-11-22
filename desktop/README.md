# Hayba Desktop for Windows

![Hayba Desktop workspace with conversation history, project sharing and provider setup](media/workspace.png)

Install Hayba with `Hayba-Desktop-Setup.exe`. To add the chat panel to Unreal, close the editor and select your project's `.uproject` in the same wizard. You can also install Desktop on its own. The bundled editor plugin requires the Windows x64 Unreal build used to compile it.

Open **Provider settings** in the sidebar in Desktop, choose OpenAI or Anthropic, and enter your API key and a model ID available to your account. Windows protects the saved key with DPAPI. Changing the model within the same provider keeps your saved key. Messages go to the selected provider when you send them.

Press **Ctrl+K** to find a conversation. Select **Share Unreal level** in the composer and choose an open project. Hayba verifies the editor’s identity before sharing the map name, package path, actor count and play state with your provider. Expand **Read level** in the reply to see what the editor returned. Sharing applies to that conversation until you disconnect it or quit Desktop.

The Unreal panel has its own conversations, provider settings and review controls for editor changes. The [desktop workflow comparison](agent-workflows.md) describes which actions are available on each surface and what remains to connect them.

## Build on Windows x64

Install Node.js, the matching Unreal Engine and Inno Setup 6. From the repository root, run:

```powershell
npm ci
npm ci --prefix desktop
npm run build:server -w @hayba/mcp
& "$Engine/Engine/Build/BatchFiles/RunUAT.bat" BuildPlugin "-Plugin=$PWD/unreal/HaybaMCPToolkit/HaybaMCPToolkit.uplugin" "-Package=$PWD/desktop/bin/native" -TargetPlatforms=Win64 -NoTargetPlatforms -Rocket
node tools/build-installer.mjs --desktop --artifact desktop/bin/native --engine "$Engine" --output desktop/bin/setup
```

Set `$Engine` to your engine installation directory before running these commands. The output directory contains the setup executable and its SHA-256 checksum.

## Exercise the installed app and editor

Run `node desktop/smoke.cjs "path/to/installed/Hayba.exe"` to check the provider settings, encrypted key storage and a streaming reply with an offline fixture.

For the editor test, install the plugin in a disposable project, select the mock provider and mock model, and open its Hayba tab with Unreal launched with `-cefdebug=39783`. Run `node desktop/test-editor.cjs "path/to/project.uproject" 39783` to send a message and inspect the current scene.
