HAYBA FOR UNREAL - WINDOWS SETUP

1. Extract the entire ZIP to a normal folder. Do not run it inside the ZIP.
2. Save and close the Unreal project you want to install into.
3. Double-click "Install Hayba.exe" (the .cmd launcher is a fallback).
4. Choose your .uproject file and Unreal Engine installation folder.
5. Optionally check Claude Code and/or Claude Desktop, then click Install Hayba.
6. Wait for Unreal to compile Hayba on this PC. A previous plugin build from
   another computer is discarded so this engine's tools rebuild it here.
7. Double-click Plugins\HaybaMCPToolkit\Hayba.exe for the standalone chat app
   (no Unreal window required). Or open Unreal → Tools > Hayba MCP Toolkit.
8. Open Settings, choose a provider, enter your API key, then send a message.
9. Restart Claude. In Claude Code, open the game project and approve its MCP config.

Ask Claude: "Use Hayba to check the Unreal connection, then list the actors in
the current level without changing anything."

Node and the MCP server are included. You do not need Git or npm. You do need
Visual Studio's Game development with C++ workload so this PC can compile the
plugin for its Unreal install. Unreal and your chosen Claude app must already
be installed. In-editor chat uses the API key you enter in Hayba Settings; it
is stored in the editor vault, not in the HTML page.

ENGINE COMPATIBILITY
The installer matches the Unreal 5.9 series (not an exact editor BuildId from
the package machine). It always recompiles Hayba on the destination PC, even
if an older Hayba folder is already present. The installer does not upgrade
your project to a different engine.

CLAUDE
Claude Code uses this project's .mcp.json. Claude Desktop uses the config file
shown in the installer; use Config... to select the file opened by Claude's
Settings > Developer > Edit Config if it lives somewhere else.
Other MCP servers and settings are preserved. The new server is named
hayba-<project-id>. It starts in your game folder and discovers that project's
editor. Do not commit machine-specific absolute MCP paths to a shared repo.

UPDATING / BACKUPS
Close this project's Unreal editor, Claude MCP sessions and Hayba sidecar
before updating. The installer reports the process ID if something is using it;
it never terminates your applications. Check "Update existing Hayba" to replace
a normal plugin folder. Developer junctions are deliberately not replaced.
Backups and a receipt are kept in <Project>/Saved/HaybaInstaller/backups.
Keep the backup until you have verified the new installation. To undo an update,
close the apps, move the new plugin out, and restore the backed-up plugin and
the config files named in receipt.json. Restore entire config backups only if
you have not made newer changes to those files.

This is an unsigned development distribution, not a published release or a
guarantee that every project/Play-in-Editor workflow is crash-free. Verify the
ZIP checksum through the teammate who supplied it. The PowerShell execution
policy override applies only to this installer process; no system policy changes.
