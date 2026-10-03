# UMG authoring contract

Hayba exposes `ui_create_widget`, `ui_add_element`, and `ui_query` through
the native UI handler and TypeScript wrappers. The native handler is the source
of truth for parameter names: `ui_add_element` uses `slot_props`, and
`ui_query` uses `path`. `ui_create_widget.parent_class` is optional and
defaults to `UserWidget`.

Use a scratch project to verify the authoring flow:

```text
ui_create_widget { path:"/Game/LanternPuzzle/UI", name:"WBP_PuzzlePanel", parent_class:"/Script/UMG.UserWidget" }
ui_add_element  { widget_blueprint_path:"/Game/LanternPuzzle/UI/WBP_PuzzlePanel", child_class:"CanvasPanel", name:"Root" }
ui_add_element  { widget_blueprint_path:"/Game/LanternPuzzle/UI/WBP_PuzzlePanel", child_class:"TextBlock", parent_widget_name:"Root", name:"Hint", slot_props:{ x:40, y:40 } }
ui_query        { path:"/Game/LanternPuzzle/UI/WBP_PuzzlePanel" }
```

Check the returned tree against the Content Browser, then compile and save the
Widget Blueprint before using it in PIE. Structural modification alone does
not prove persistence across editor restart. For fonts, choose a composite
`UFont` asset; a raw `UFontFace` passed directly to `FSlateFontInfo` can
show its preview tile instead of usable text.
