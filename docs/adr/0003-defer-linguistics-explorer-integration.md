# 0003 — Defer the linguistics workbench → Hayba Explorer integration

**Status:** Accepted (2026-05-17)

## Context

On `feat/website-integration`, the website's `/app` and `/lang/:id`
routes are served from `@hayba/linguistics`'s `demo` build output (the
branch `vercel.json` builds the package and copies `dist`/`demo` into
`website/`). On the restructured layout that package is
`apps/hayba-explorer/packages/linguistics`. The long-term home for the
interactive workbench is **Hayba Explorer** (the Tauri app), not a
website build step.

## Decision

Do **not** wire the website→`@hayba/linguistics` build coupling now.
Bring the website in without it; `/app` and `/lang/:id` resolve to a
graceful on-brand placeholder (`website/app/index.html`). The real
workbench integration is a **dedicated future step**: surface the
linguistics workbench inside `apps/hayba-explorer`, then decide how (if
at all) the web exposes it.

## Consequences

- No website build-order coupling to a worldbuilding package now.
- `/app` + `/lang/:id` are placeholders until the integration step;
  tracked in the README roadmap.
- Revisit (supersede this ADR) when the explorer integration is scoped.
