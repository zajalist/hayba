# Verify PIE wheel and captured drag

This is a scratch-project verification recipe, not a record of a completed
in-editor check. Rebuild and restart the scratch editor before testing a native
input change. Confirm the loaded plugin binary is the one under review.

The original defects shared a cause: input was sent to the game viewport while
the intended UMG widget listened through Slate. Mouse wheel events must reach
`FSlateApplication::ProcessMouseWheelOrGestureEvent` so the widget under the
cursor can handle or decline them. A viewport fallback can handle unclaimed
input.

A synthetic drag also needs a real cursor delta and held-button state.
`SetCursorPos` updates both current and previous Slate pointer positions, so
capture the origin before moving, then construct the move event with those two
positions. Preserve Slate's pressed mouse buttons in the event. Do not fake
mouse capture; the widget should request it in response to the press.

Create a scratch UMG panel with a scroll box, scroll bar, and slider. For each
gesture, compare the widget's property before and after the command:

1. Wheel over scroll content: `handled_by` should identify Slate and the
   scroll offset should change in the expected direction.
2. Press and drag the scroll bar: `captor_after_press` should identify the
   expected widget, `moves_delivered` should be positive, and a nonzero
   `cursor_delta_x/y` should accompany the new offset.
3. Drag a slider: held-button state and its value should agree with the
   dispatched movement.

An attempted dispatch alone is insufficient evidence of a successful gesture.
