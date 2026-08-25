// The Fab tools call plugin commands that do not exist.
//
// `fab_login_status`, `fab_library_list`, `fab_marketplace_search` and
// `fab_download` are all sent to the editor, and no handler declares any of
// them — not on this branch, and not in any branch's history. They were
// written TypeScript-first against a C++ side that was never built (the
// download tool's own schema still refers to "the 10min cap on the C++ side").
//
// All four are registered and advertised to agents, so an agent reads four
// capabilities in the catalogue, calls one, and gets `Unknown command:
// fab_download` — which now reads as "your plugin is out of date", because
// that is exactly what an unknown command usually means. It sends people to
// reinstall a plugin that was never going to have this.
//
// Saying so plainly is the least this can do. Whether the four should stay in
// the catalogue at all is a product decision: a tool that cannot succeed still
// costs an agent tokens to read and a moment to consider.

export function fabUnavailable(command: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [{
      type: 'text',
      text:
        `${command} is not available: the Hayba plugin does not implement it. ` +
        `The Fab tools were built against an editor-side integration that has ` +
        `not been written, so this is not a version mismatch and updating the ` +
        `plugin will not help. Download Fab content through the Epic Games ` +
        `Launcher or the Fab plugin in-editor, then use the asset tools ` +
        `(asset_import, asset_browse) on the result.`,
    }],
    isError: true,
  };
}
