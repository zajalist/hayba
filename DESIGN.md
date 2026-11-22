---
name: Hayba embedded chat workspace
description: Warm charcoal workspace for conversation and reviewed Unreal project work.
colors:
  bg: "#1d1b19"
  raised: "#292623"
  sunken: "#171615"
  hover: "#34302b"
  line: "#3d3833"
  strong: "#5e554d"
  text: "#eae6e1"
  secondary: "#bcb4ab"
  muted: "#9b9187"
  focus: "#d0aa73"
  pass: "#9bc5a6"
  fail: "#e49790"
  popover: "#262320"
typography:
  headline:
    fontFamily: "Hayba, 'Segoe UI', sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Hayba, 'Segoe UI', sans-serif"
    fontSize: "16px"
    fontWeight: 600
  body:
    fontFamily: "Hayba, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "Hayba, 'Segoe UI', sans-serif"
    fontSize: "12px"
    fontWeight: 400
  supporting:
    fontFamily: "Hayba, 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 400
  code:
    fontFamily: "Consolas, 'Cascadia Code', monospace"
    fontSize: "12px"
    lineHeight: 1.6
rounded:
  chip: "6px"
  button: "7px"
  field: "8px"
  container: "9px"
  popover: "11px"
  user: "12px"
  composer: "13px"
spacing:
  tight: "6px"
  control: "8px"
  content: "12px"
  panel: "18px"
  page: "24px"
components:
  button-primary:
    backgroundColor: "{colors.focus}"
    textColor: "{colors.sunken}"
    rounded: "{rounded.button}"
    typography: "{typography.label}"
  button-ghost:
    textColor: "{colors.secondary}"
    rounded: "{rounded.button}"
    padding: "5px 9px"
  button-ghost-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.text}"
  button-send:
    backgroundColor: "{colors.text}"
    textColor: "{colors.sunken}"
    rounded: "{rounded.field}"
    width: "31px"
    height: "31px"
  composer:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.composer}"
    padding: "12px 10px 8px"
  field:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    padding: "10px 11px"
  context-chip:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.secondary}"
    rounded: "{rounded.chip}"
    padding: "4px 4px 4px 7px"
  user-turn:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.user}"
    padding: "12px 15px"
  popover:
    backgroundColor: "{colors.popover}"
    rounded: "{rounded.popover}"
    padding: "6px"
    width: "330px"
---

# Design System: Hayba embedded chat workspace

## Overview

**Creative North Star: "The retained warm-charcoal workspace"**

Scope is the bundled HTML workspace embedded in Unreal, including its transcript, composer, menus and sheets. This records the existing user-pinned palette and typography as implemented in `unreal/HaybaMCPToolkit/Resources/chat/chat.css`, `workspace.css` and `icons.js`. It does not govern the marketing website, other product domains or the native fallback's separate styling.

The surface is compact and quiet: conversation occupies the flexible center, while a small task header and pinned composer keep the current task accessible. The Hayba logo supplies identity. Repeated tonal layers, modest rounding and line icons carry controls without turning each assistant paragraph into a card.

**Key Characteristics:**

- Warm dark surfaces and light text, with restrained sand-colored focus and action states.
- Raised user turns and composer; unboxed assistant prose.
- One bundled stroke-icon vocabulary and compact functional labels.
- Popovers for local choices; side sheets for longer workflows.

## Colors

Warm neutrals form the working surface; light sand distinguishes focus, attention and selected actions.

### Primary

`focus` is the active sand tone for keyboard outlines, selected options, links and generation/approval actions. The source also retains an ochre `--accent` declaration (`#c47a28`), but the sampled CSS does not consume it; it is not promoted here into an additional active component token. The bundled Hayba mark preserves the ochre identity.

### Neutral

`bg` is the canvas, `raised` supports the composer and user turns, and `sunken` separates code and raw data. `line` and `strong` distinguish quiet divisions from interactive boundaries. `text`, `secondary` and `muted` establish reading hierarchy; `popover` supports elevated menus.

### State

`pass` and `fail` accompany readable success/failure labels. State is not communicated by color alone.

**The Focus Rule.** Use the existing sand treatment for active choices and focus; preserve text labels for status.

## Typography

**Body Font:** bundled Noto Sans, registered as `Hayba` at 400 and 600, with Segoe UI/sans-serif fallbacks. The display heading uses that same bundled face; the system fallback is not the intended display face.

**Code Font:** Consolas, Cascadia Code, monospace.

The empty-state headline uses `headline`; sheet and transcript headings use `title`. Conversation text uses `body`, controls use `label`, and supplementary rows use `supporting`. Task/menu titles use 13px/600, with the wide task title at 14px. Metadata occasionally uses 9–10px; this density is observed, not a default for new body copy. The composer uses 14px/1.6 and fields 13px/1.55.

## Layout

The workspace is a full-height flex column: header, independently scrolling conversation, pinned composer. Transcript content caps at 760px; the composer region caps at 808px including its padding. Empty-state content caps at 480px. The header is 66px high; conversation padding is 24px 24px 28px. User turns indent 26px and messages separate by 28px.

At widths up to 390px, the header is 61px, transcript padding is 17px 19px 25px, and composer gutters are 10px. Up to 380px, user indentation drops to 12px and activity summaries can wrap. From 760px, the header is 70px and composer padding increases. At heights up to 600px, the header is 56px, the welcome mark and empty note hide, and the prompt minimum height drops to 45px.

Popovers cap to the viewport minus 16px horizontally and 20px vertically. Sheets are 440px wide, capped at the viewport, with independently scrolling bodies. Code and tables scroll locally instead of widening the page.

**The Stable Reading Rule.** Preserve unchanged message blocks, selected text, expanded details and the reader's scroll position during updates. Offer jump-to-latest when the reader is above the newest content.

## Elevation & Depth

The base workspace uses tonal layers and 1px borders. Overlays use soft shadows: popovers `0 10px 28px #0005`, toast `0 6px 24px #0005`, sheets `-8px 0 32px #0003`; the sheet shade is `#0005`. These are real overlay treatments, so a blanket shadow prohibition would misdescribe this world.

## Shapes

Rounded rectangles use the role-specific radii in frontmatter. Sheets remain flush with the viewport edge. Chips are compact and removable; the composer is the largest persistent rounded enclosure. No hard offset shadow is used.

## Components

### Buttons and icons

Ghost controls gain hover fill and visible keyboard focus. Send uses a light surface, switching to an outlined stop state during work. Generation/approval actions use the sand primary treatment. Disabled controls remain recognizable with reduced opacity. Common state transitions are 150ms ease-out; reduced-motion preferences disable them.

Icons are local inline SVGs from `icons.js`: 24-unit viewBox, normally 1.65 stroke, round caps/joins, currentColor and an 18px default rendering size. The more icon uses a heavier dot stroke; stop is filled. Smaller controls scale icons to 10–17px. Icon-only buttons retain accessible labels; icons themselves are hidden from assistive technology.

### Composer and fields

The raised composer groups prompt, attachments, model, effort and send controls. Its border strengthens on focus-within; text inputs have a sand caret. Context chips sit above it and access state below it. Form fields use visible sand borders on focus. Preserve draft text through auxiliary menu/sheet interactions.

### Navigation and menus

History sits beside the task identity. Find, New conversation, Create media and More are compact header actions. Models use searchable popovers with readable option details. A 430px left navigator titled Conversations groups Threads, This chat and Agents, with bounded lists, search and explicit pagination. Main-agent delegation appears inline with status and detail access. Agents only browses delegated work: no task form or manual launch button. More includes Activity, Subagents, Connections, Settings and keyboard help. World browsing is removed while inspection remains a chat action; Checks belongs under Activity.

### Transcript and activity

User turns use the raised surface. Assistant text remains unboxed with a speaker label, logo and contextual copy action. Code has a raised header and sunken body. Activity uses semantic disclosures with step states and expandable raw input/result sections. Review actions come from structured state; generated prose cannot create an approval authority.

### Sheets

Connections and Create media use the same edge-aligned sheet, header, close control and scrollable content. Generation groups 3D model, Video and Splat world before showing supported providers. Provider rows combine line symbols, status text and explicit actions; job rows show real output kind and progress. Subagent details retain task identity, read-only status, tool calls and findings. Context chips reveal their captured reference and source on activation. Payment/connection copy belongs to the current workflow, not a reusable design claim.

## Do's and Don'ts

- **Do** reuse the bundled Noto Sans and Hayba logo.
- **Do** keep task, context, access and review state legible in narrow docks.
- **Do** preserve focus, drafts and reading position as state updates.
- **Do** use the shared SVG family with accessible control names.
- **Don't** box ordinary assistant paragraphs or promote incidental microtext into a new display hierarchy.
- **Don't** let generated prose authorize editor operations or equate preview simulation with a connected provider.

Not canonized: approval-strip visibility, preview simulation disclosure and current-history accuracy were still receiving final verification when this system was recorded. They are behavior/evidence gaps, not reusable design exceptions. Native editor rendering and paid-provider execution remain unverified here.
