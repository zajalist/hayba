# PIE input coordinate-space correction

The widget tree reports Slate geometry in absolute desktop coordinates. A
previous `editor_pie_mouse` path added the game window origin to every input
coordinate. That was correct only for window-relative values; using coordinates
from `editor_pie_widget_tree` counted the origin twice and moved clicks away
from their targets. `editor_pie_click_widget` already passed the widget
center to Slate in absolute space.

The contract should state which coordinate space each command accepts. When
driving a widget found through the tree, pass its absolute center through
without adding the window origin. Convert only caller-provided
window-relative coordinates. Verify both routes in a scratch project with a
small test widget near the window edge, where an offset cannot be hidden by a
large target.

An initial click into an unfocused PIE window may only activate the window.
Check `focused_widget_after` before treating that first click as a coordinate
failure; repeat the interaction after focus is established.
