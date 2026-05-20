# @hayba/design-tokens

Shared design tokens for Hayba's UI surfaces. A single `index.ts` of typed,
`as const` token objects so the Hayba Explorer chrome matches the marketing
site exactly (palette + type stack are the marketing site verbatim; the
editorial discipline — generous whitespace, accent-only emphasis — comes from
the Gaea reference).

Private workspace package (`@hayba/design-tokens`, not published). `main` and
`types` both point at [`index.ts`](index.ts) — consumers import the
TypeScript source directly; there is no build step.

## Exports

| Export | Shape | Notes |
|---|---|---|
| `colors` | object of hex strings | Backgrounds (`bgDeep`…`bgElevated`, `bgTopBar`, `bgStatusBar`, `bgCategoryStrip`, `bgPanelHeader`), accent (`accent` = `#B56A1D`, `accentHover`, `accentText`, `accentDim`, `accentGlow`), text (`textPrimary/Secondary/Muted`), borders (`borderMid`, `borderSoft`, `rule`), beige foreground (`beige`, `beigeMuted`), reserved `secondary`/`secondaryHover` |
| `fonts` | `{ sans, ipa, mono }` | `sans` = Segoe UI stack, `mono` = Consolas stack, `ipa` reserved for IPA samples |
| `radii` | `{ xs, sm, md, lg }` | Tight Gaea/UE5-style — `2px`/`3px`/`4px`/`8px` |
| `shadows` | `{ sm, md }` | Panel drop shadows |
| `easings` | `{ out, spring }` | `cubic-bezier` curves |

Every object is declared `as const`, so member access is fully typed and
literal-narrowed (e.g. `colors.accent` is `"#B56A1D"`, not `string`).

## Consuming it

Add the workspace dependency, then import the tokens you need:

```ts
import { colors, fonts, radii } from "@hayba/design-tokens";

const panelStyle: React.CSSProperties = {
  background: colors.bgPanel,
  color: colors.textPrimary,
  fontFamily: fonts.sans,
  borderRadius: radii.md,
};
```

Primary consumer today is **Hayba Explorer**
(`apps/hayba-explorer`), where panel and chrome components import `colors` /
`fonts` / `radii` from this package (declared as a `file:` workspace
dependency in its `package.json`). See [`../../CONTEXT.md`](../../CONTEXT.md)
for repo orientation.
