HAYBA FOR UNREAL - WINDOWS SETUP

1. Extract the entire ZIP to a normal folder. Do not run it inside the ZIP.
2. Save and close the Unreal project you want to install into.
3. Double-click "Install Hayba.exe" (the .cmd launcher is a fallback).
4. Choose your .uproject file and Unreal Engine installation folder.
5. Optionally check Claude Code and/or Claude Desktop, then click Install Hayba.
6. Open Unreal. Open Tools > Hayba MCP Toolkit.
7. Restart Claude. In Claude Code, open the game project and approve its MCP config.

Ask Claude: "Use Hayba to check the Unreal connection, then list the actors in
the current level without changing anything."

Node and the MCP server are included. You do not need Git, npm, Python, an
Anthropic API key in Hayba, or Visual Studio to install this matching prebuilt
editor plugin. Unreal and your chosen Claude app must already be installed.
Building your project's C++ code later still requires its normal build tools.

ENGINE COMPATIBILITY
The installer requires the exact engine version/build shown in its window.
A different engine build needs a matching Hayba package. The installer does
not upgrade your project or silently use an incompatible DLL.

CLAUDE
Claude Code uses this project's .mcp.json. Claude Desktop uses the config file
shown in the installer; use Config... to select the file opened by Claude's
Settings > Developer > Edit Config if it lives somewhere else.
Other MCP servers and settings are preserved. The new server is named
hayba-<project-id>. It starts in your game folder and discovers that project's
editor. Do not commit machine-specific absolute MCP paths to a shared repo.
Hayba's optional in-editor chat has separate provider and API-key settings.

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
