# PIE text input routing lesson

An early PIE automation implementation reported successful character dispatch
while a focused UMG `EditableTextBox` remained empty. Sending characters
through `UGameViewportClient::InputChar` reached the game-input pipeline but
not the focused Slate widget. Text now goes through
`FSlateApplication::ProcessKeyCharEvent`; keys go through Slate key-down/up
events, with the viewport as fallback when UI declines them.

Backspace and submit also need companion character events (`\b` and `\r`).
A synthetic key-down alone can report success without changing text. Responses
therefore expose `characters_accepted_by_ui`, `handled_by_ui`, and
`focused_widget`, so callers can distinguish attempted delivery from UI
acceptance.

For a scratch regression, start PIE with a simple form containing an
`EditableTextBox`, click it by widget text, type a known string, then inspect
the focused widget and screenshot. Check Tab and Backspace separately. A valid
screenshot may still be black while the first frame renders; wait for render
readiness before using pixels as evidence. Avoid concurrent editor rebuilds.
