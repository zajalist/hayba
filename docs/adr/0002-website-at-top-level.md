# 0002 — Website lives at top-level `website/`

**Status:** Accepted (2026-05-17)

## Context

The public website (from `feat/website-integration`) is a static
HTML/CSS/JS site (no framework, no build). The repo's root `vercel.json`
already declares `{"outputDirectory":"website"}`. Alternative: place it
under `apps/hayba-web/` for monorepo symmetry.

## Decision

Keep the website at **top-level `website/`**. It is *not* a JS workspace
(no `package.json`, static assets only). `vercel.json` keeps
`outputDirectory: website` and the static rewrites.

## Consequences

- Zero Vercel reconfiguration; deploy stays trivial.
- `website/` is not covered by the workspace globs — intentional; it has
  no build/test of its own.
- The website build has no coupling to any workspace package.
