# Hayba UE5 Plugins — Setup Wizard & Mode Selection Design

> **Status:** Approved  
> **Date:** 2026-04-04  
> **Scope:** HaybaGaea plugin + HaybaPCGEx (Hayba_PcgEx_MCP) plugin

---

## 1. Overview

Both UE5 plugins get a unified setup experience:

1. **First-launch wizard** — a paged onboarding flow that explains the plugin and guides the user through initial configuration. Shown once; preferences saved per page as the user advances.
2. **Mode selection screen** — shown every time the panel opens. Lets the user switch between Integrated AI Tools mode and API Key mode. Re-accessible via a "⚙ Setup" button.
3. **PCGEx UI reskin** — the existing PCGEx chat/wizard UI is reskinned to match UE5's native dark editor aesthetic (FAppStyle throughout, no custom colors, no branding).

---

## 2. Two Operating Modes

### Mode A — Integrated AI Tools
The user runs the Hayba MCP Node.js server alongside their AI coding tool (Claude Code, Cline, OpenCode, etc.). The AI drives UE5 directly via MCP commands over TCP. The plugin panel shows connection status and an activity log — no chat UI.

### Mode B — API Key
The user interacts directly inside UE5. The plugin calls the AI API itself using a stored key. Shows the chat/prompt UI. For HaybaGaea this adds an API key field above the terrain prompt. For PCGEx this is the existing wizard chat (reskinned).

---

## 3. Flow

```
Panel opens
    │
    ├─ bHasSeenWizard == false ──► Wizard (paged, full-panel)
    │                                   └─► saves bHasSeenWizard=true + OperationMode + ApiKey
    │
    └─ bHasSeenWizard == true  ──► Mode Selection Screen
                                        ├─ [Integrated AI Tools] ──► MCP Status Screen
                                        └─ [API Key]             ──► Chat / Prompt UI

All screens: "⚙ Setup" button (top-right) re-opens Mode Selection Screen
```

---

## 4. GConfig Keys

Stored in `GEditorPerProjectIni` under section `[HaybaGaea]` / `[HaybaPCGEx]`:

| Key | Type | Description |
|-----|------|-------------|
| `bHasSeenWizard` | bool | True after wizard completes once |
| `OperationMode` | string | `"Integrated"` or `"ApiKey"` |
| `ApiKey` | string | Shared across both plugins (`[HaybaShared]` section) |
| `ServerHost` | string | TCP host (default `127.0.0.1`) |
| `ServerPort` | int | TCP port (55558 for Gaea, 52342 for PCGEx) |

`ApiKey` lives in a shared `[HaybaShared]` section so setting it in one plugin auto-populates the other.

---

## 5. Paged Wizard

### HaybaGaea — 3 pages

**Page 1 — Welcome**
- Title: "HaybaGaea"
- Subtitle: "Generate terrain from a text prompt, directly in UE5."
- ASCII/Slate diagram: `Prompt → AI → Gaea graph → BuildManager → Heightmap → ALandscape`
- Button: [Next →]

**Page 2 — How do you want to use it?**
- Two selectable cards (full-width, UE5 style):
  - **Integrated AI Tools** — "Use Claude Code, Cline, or OpenCode. Your AI assistant drives UE5 automatically via MCP. No typing in UE required."
  - **API Key** — "Type terrain prompts directly in this panel. Provide your API key and generate landscapes without leaving UE5."
- Selection persists to GConfig `OperationMode` immediately on click.
- Buttons: [← Back] [Next →]

**Page 3a — Setup: Integrated (if Mode A chosen)**
- Title: "Connect your AI tool"
- Subheading per tool with exact copy-paste command:
  - **Claude Code:** `claude mcp add hayba-gaea-server -- node "<resolved-path>"`
  - **Cline (VS Code):** JSON snippet for `cline_mcp_settings.json`
  - **OpenCode:** JSON snippet for `.opencode/config.json`
- Path resolved at runtime: `FPaths::ConvertRelativePathToFull(PluginDir / "ThirdParty/gaea_server/dist/index.js")`
- [Copy] button per snippet.
- Buttons: [← Back] [Finish]

**Page 3b — Setup: API Key (if Mode B chosen)**
- Title: "Enter your API key"
- Single `SEditableTextBox` (password mask), label "AI API Key"
- Saved to `[HaybaShared] ApiKey` in GConfig on change.
- Small note: "Compatible with Anthropic Claude, OpenAI, and any OpenAI-compatible endpoint."
- Buttons: [← Back] [Finish]

### HaybaPCGEx — 3 pages (same structure)

**Page 1 — Welcome**
- Title: "HaybaPCGEx"
- Subtitle: "Author PCG graphs with AI, directly in UE5."
- Diagram: `Prompt → AI → PCGEx node graph → UE5 PCGGraph asset`
- Button: [Next →]

**Page 2** — identical structure to HaybaGaea page 2, same two mode cards.

**Page 3a / 3b** — identical structure, paths resolve to PCGEx MCP server:
- Claude Code: `claude mcp add hayba-pcgex -- node "<resolved-path>"`
- Path: `PluginDir / "ThirdParty/mcp_server/dist/index.js"`

---

## 6. Mode Selection Screen (every panel open)

Shown after wizard completes. Same two cards as wizard Page 2, but smaller — takes the top portion of the panel, with the last-used mode pre-highlighted.

- Clicking a card immediately transitions to that mode's UI.
- "⚙ Setup" button in the panel header re-shows this screen from any mode.

---

## 7. MCP Status Screen (Mode A)

Replaces the chat/prompt UI entirely. Layout:

```
┌─ Status bar ────────────────────────────────────────────┐
│  ● LISTENING   127.0.0.1:52342   [Stop] [Restart]       │
├─ Setup commands ────────────────────────────────────────┤
│  Claude Code:  claude mcp add hayba-pcgex -- node "..." │
│                                              [Copy]      │
│  Cline:        { "hayba-pcgex": { ... } }   [Copy]      │
│  OpenCode:     { "mcpServers": { ... } }    [Copy]      │
├─ Activity log ──────────────────────────────────────────┤
│  [12:04:31] create_pcg_graph           → ok             │
│  [12:03:18] list_pcg_assets            → 4 assets       │
│  [12:02:55] check_ue_status            → connected      │
└─────────────────────────────────────────────────────────┘
```

Status dot colors: green = connected client, yellow = listening/idle, red = error/stopped.

---

## 8. PCGEx UI Reskin

The existing `SPCGExWizardWidget` is reskinned:

- **Remove:** Hayba logo, "HAYBA PCGEx MCP" orange title bar, all custom `FLinearColor` definitions, chat bubble colored backgrounds.
- **Replace with FAppStyle:**
  - Panel borders: `FAppStyle::GetBrush("ToolPanel.GroupBorder")`
  - Text: `FAppStyle::GetWidgetStyle<FTextBlockStyle>("NormalText")` and `"SmallText"`
  - Font: `FAppStyle::GetFontStyle("SmallFont")` for messages, `"NormalFont"` for labels
  - Buttons: plain `SButton` with no `ButtonColorAndOpacity` override
  - Input box: plain `SMultiLineEditableTextBox` with no custom border color
- **Chat messages:** Replace colored bubble `SBorder` widgets with plain `SHorizontalBox` rows — role label ("You" / "AI") left-aligned in muted color, message text right of it. No background color per row.
- **Status indicators:** Small 8x8 colored `SBorder` circle only (green/red/grey). No colored banners.
- **Header:** Replace orange title bar with a simple `STextBlock` using `"NormalFont"`, white text, no background. Keep "⚙ Setup" button right-aligned.

---

## 9. Wizard Widget Per Plugin

Each plugin gets its own `SHaybaGaeaSetupWizard` / `SPCGExSetupWizard` — UE5 doesn't support cross-plugin Slate widget sharing cleanly. Both follow identical structure, parameterized by plugin-specific values (port, MCP path, GConfig section). Code duplication is minimal (~150 lines each) and avoids build dependency issues.

```
SHaybaGaeaSetupWizard / SPCGExSetupWizard
    ├─ CurrentPage     (int32)    — 0/1/2
    ├─ ChosenMode      (EHaybaOperationMode)
    ├─ McpServerPath   (FString)  — resolved at construction
    └─ OnFinished      (delegate) — passes chosen mode to parent panel
```

---

## 10. File Changes

### HaybaGaea plugin
- **Modify:** `SHaybaGaeaPanel.h/.cpp` — add paged wizard, mode selection, MCP status screen, API key field
- **Add:** `HaybaSetupWizard.h/.cpp` — shared wizard widget (used by both plugins)
- **Modify:** `HaybaGaeaSettings.h/.cpp` — add `bHasSeenWizard`, `OperationMode`, shared `ApiKey`
- **Modify:** `HaybaGaeaModule.cpp` — pass `bHasSeenWizard` check to panel on spawn

### HaybaPCGEx plugin  
- **Modify:** `PCGExWizardWidget.h/.cpp` — reskin to FAppStyle, integrate setup wizard
- **Modify:** `PCGExBridgeSettings.h/.cpp` — add `bHasSeenWizard`, `OperationMode`, shared `ApiKey`
- **Modify:** `PCGExBridgeModule.cpp` — pass wizard check to panel on spawn

---

## 11. What Does Not Change

- TCP server implementation in both plugins (unchanged)
- MCP Node.js servers (unchanged)
- All existing tool implementations
- GConfig keys for `ServerHost`, `ServerPort`, `HeightmapOutputFolder`
