# Architectural Decision Records

Lightweight [Nygard-style](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
ADRs. One decision per file. Status: `Accepted` · `Superseded` ·
`Proposed`. Don't re-litigate an `Accepted` ADR without superseding it.

| # | Decision | Status |
|---|---|---|
| [0001](0001-monorepo-restructure-and-re-emulation-doctrine.md) | Monorepo restructure + re-emulation doctrine | Accepted |
| [0002](0002-website-at-top-level.md) | Website lives at top-level `website/` | Accepted |
| 0003 | *(tectonics — moved to [hayba-explorer](https://github.com/zajalist/hayba-explorer) with the split)* | — |
| [0004](0004-ue-plugin-location.md) | UE plugin lives at `unreal/HaybaMCPToolkit/` | Accepted |
| [0005](0005-tectonic-stack-split-to-hayba-explorer.md) | Tectonic stack split out to `hayba-explorer` | Accepted |
| [0006](0006-one-visual-sidecar.md) | One visual sidecar, one interface | Accepted |
| [0007](0007-static-checks-must-know-every-call-form.md) | A static check must know every form of the call it guards | Accepted |
| [0008](0008-satellite-plugins-earn-their-place.md) | A satellite plugin has to add capability the always-available surface cannot | Accepted |
| [0009](0009-one-verdict-language-profile-rule-recipe.md) | One verdict language: Profile, Rule, Recipe | Proposed |

An ADR describing code that moves **out** of this repo gets copied to both
repos, not moved. 0005 was moved, and `CHANGELOG.md` spent two months citing a
file that was not here; 0003 is listed above rather than silently skipped for
the same reason.
