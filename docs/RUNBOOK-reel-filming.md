# Scratch reel checklist

This historical reel checklist is retained for its generic production lessons.
Use a throwaway Unreal project with copied Hayba plugins, a small clean map,
and assets you have permission to redistribute. Build the editor plugin with
the editor closed, then reconnect the MCP server before checking tool
availability.

1. Verify tool availability with `list_tool_categories` and the current
   editor connection. A catalog entry alone does not prove it is callable.
2. Add a few lightweight vegetation meshes before scaling a scatter. Validate
   PCG pins and property import against the installed engine and plugin build.
   Nested export-text properties need a live readback before trusting the graph.
3. Capture and inspect a frame after each scene change. Wait for a rendered
   frame and a stable editor connection before relying on the result.
4. Save the scratch map and measure asset memory and frame cost before filming.

Do not bulk-scatter very large hero meshes. Use a small count of deliberate
placements, then profile the result before adding detail.
