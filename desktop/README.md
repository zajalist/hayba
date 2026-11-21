# Hayba Desktop for Windows

This preview opens Hayba’s Unreal HTML chat in a standalone window. Choose **Hayba → Provider settings**, select Anthropic or OpenAI, and enter a model ID available to your API account. Keys are encrypted through Windows DPAPI. Conversations and drafts are saved locally. Sending a message sends the conversation to the selected provider.

The setup executable installs the desktop app per user. The optional Unreal integration runs the bundled Hayba 0.4.2 project setup and can be opened later from Start. Desktop and the Unreal tab currently keep separate conversations. Scene inspection and approved editor operations run in the Unreal tab.

## Build and verify

On Windows x64, install Node, GitHub CLI and Inno Setup 6. From the repository root run `npm ci`, then from this directory run `npm ci`, `npm test`, and `npm run build`. Set `HAYBA_ISCC` if Inno Setup is outside its default per-user location. The build verifies the pinned Unreal installer by SHA-256.

Open `bin/Hayba-Desktop-Setup.exe` to install. Run `node smoke.cjs` to exercise the compiled desktop host with a fixture provider response and an isolated user profile.
