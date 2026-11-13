# Fab integration (UE 5.9)

Hayba searches Fab's real catalog and the signed-in user's library, and lets a
user open the native Fab window from chat. Acquisition, license acceptance and
Add to Project remain explicit actions in Fab. A completed search is never an
import receipt.

## Supported interfaces

Verified against installed UE 5.9 Preview CL 60351404, Fab plugin 0.0.22:

- `Fab/Public/FabModule.h`: `IFabModule::SearchCatalog` and `SearchLibrary`.
- `Fab/Public/FabCatalogTypes.h`: query filters, paging cursors, listing IDs,
  formats, supported engine versions and library downloadability.
- These interfaces promise game-thread callbacks while the module runs. Module
  shutdown may drop a callback; Hayba's query deadline handles that case.
- Library search restores persisted login silently. Hayba does not call the
  separate interactive `SignIn()` interface or expose credentials/download URLs.

`HaybaFab::OpenBrowser(FString& OutError)` invokes Epic's existing editor action.
`Fab/Private/FabBrowser.cpp::SetupEntryPoints` registers `OpenFabTab` in the
`GetContent` section of `MainFrame.MainMenu.Window`. Public section lookup finds
the entry; Hayba copies only that entry into a transient menu, uses public
`UToolMenus::GenerateWidget` and `SMultiBoxWidget::GetMultiBox`, then executes the
matching block's `GetDirectActions()`. No temporary menu is displayed or
registered. This avoids private menu fields and guessed tab IDs: UE 5.9 registers
numbered Fab tabs only when it opens them. A true return means action dispatched,
not that sign-in or page loading succeeded. This opener is a user UI action, not
an MCP tool.

## Query contract and limits

`fab_search` accepts strict catalog/library source, query up to 500 characters,
limit 1–24, opaque cursor up to 4096 characters, and catalog-only `free_only`.
It returns a running job. `fab_search_status` exposes results only to that caller;
unknown, expired and other-owner jobs share an error. Search states are running,
done and failed. Retention is 120 seconds, completion deadline 60 seconds,
capacity 32 jobs globally and four pending jobs per caller. No editor-thread wait.

Results retain at most the requested rows, 16 formats and 32 engine versions per
format. Truncation flags make bounds explicit; oversized cursors fail instead of
silently breaking pagination. Catalog ownership is unknown. Library ownership is
explicit, with live-listing and downloadability metadata. Only validated HTTPS
Fab listing URLs are returned; live library URLs require a complete UUID.
Seller titles and other metadata are untrusted data. Both tools use shared
read-only command admission and empty effects metadata.

## Optional packaging and imports

Build rules detect the public search declaration and add Fab include-path module
metadata, without a linked or startup dependency. An absent/older API compiles a
recoverable search error. The optional disabled plugin reference acknowledges
headers without forcing Fab on or off independently: UBT `UEBuildTarget.AddPlugin`
ignores disabled references, validation accepts the optional reference, and
runtime `PluginManager` skips that dependency edge. Fab itself is enabled by
default in the verified engine installation.

`InstallAsset` returns void and exposes no workflow/completion handle. An idle
`IsAssetOperationInProgress` cannot prove success. Imported-object receipts and
listing-to-local mappings live behind private workflow code. Automatic installs
are therefore deferred; no private API, authenticated scraping or guessed REST
endpoint is used.

The supported user flow is search, open native Fab, use **My Library → Add to
Project**, select the imported content, then attach selection to chat. Existing
asset tools can inspect those project paths. See Epic's [Fab window guide](https://dev.epicgames.com/documentation/en-us/unreal-engine/fab-window-in-unreal-engine)
and [acquisition/download guide](https://dev.epicgames.com/documentation/en-us/fab/purchasing-and-downloading-assets-in-fab).

## Verification

TypeScript typecheck and 32 focused tests passed. The Fab service/opener, handler
and tests compiled against UE 5.9 (three translation units, exit 0). Native tests
cover public menu action dispatch, disabled actions, input/URL boundaries,
read-only classification, job ownership, deadlines, expiry and metadata bounds.
Macro-disabled compilation without Fab include paths passed; final DLL import
inspection found no Fab DLL dependency. All three Fab native tests passed in a
Fab-disabled disposable editor (the complete focused gate: 45 tests, zero failures,
exit 0; one expected sidecar-identity warning). Native source:
`28686520d708d29e32e2314843b8349088b3f191`.

A separate real MCP stdio client connected to the built server, listed the Fab
tools, and called `fab_search` against an owned Fab-disabled editor. It returned
the actionable disabled-plugin error. The final wire gate passed 14 assertions,
also covering real Chooser pagination and preservation of arbitrary Python review.
Editor and client exited cleanly with no dirty packages or Content files. This
check used the same native source above and DLL SHA256
`B5AAEEB3F327A3D9C0767939A74B725C9B372F03083B85808632739DC59CEA7F`.
Live catalog/library responses, actual Fab browser opening and imports have not
been exercised. These checks do not establish sign-in, acquisition or import success.
