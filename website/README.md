# website — Hayba public site

The public marketing/landing site. **Static HTML/CSS/JS — no framework, no
build step.** Vercel serves the `website/` directory as-is (see
[`../vercel.json`](../vercel.json), `outputDirectory: "website"`).

Lives at the repo top level by decision — see
[`../docs/adr/0002-website-at-top-level.md`](../docs/adr/0002-website-at-top-level.md).

## Structure

```
index.html        landing page          main.js    nav/scroll behaviour
style.css         global styles         config.js   runtime config (see below)
brainstorm.html   standalone page

about/   admin/   app/   docs/   forum/   gaea/   login/   pcgex/
showcase/   waitlist/                      ← each an index.html subpage
assets/   Gaea + PCGex imagery, logos
lib/      gl-quad.js · hero-field.js · ripples.js · starfield.js ·
          page-toc.js · hayba-client.js   (vanilla helpers, no bundler)
```

## Runtime config

[`config.js`](config.js) is loaded before everything else on every page and
sets `window.HAYBA_CONFIG = { url, anonKey }`. The committed file contains
**placeholder tokens** (`__VERCEL_PUBLIC_HAYBA_API_URL__`,
`__VERCEL_PUBLIC_HAYBA_ANON_KEY__`), not secrets. Vercel rewrites this file
at deploy time by substituting the corresponding `VERCEL_PUBLIC_*`
environment variables (the `vercel-build` step performs the envsubst).

> Never commit real values into `config.js`. The `anonKey` is a public
> Supabase anon key by design, but it is still injected at deploy time, not
> stored here.

## Routing

[`../vercel.json`](../vercel.json) rewrites:

| Source | Destination |
|---|---|
| `/app/:path*` | `/app/index.html` |
| `/lang/:id` | `/app/index.html` |
| `/waitlist` | `/waitlist/index.html` |
| `/login` | `/login/index.html` |
| `/admin` | `/admin/index.html` |

## Deferred placeholders

`/app` and `/lang/:id` both resolve to `app/index.html`, which is a graceful
on-brand **placeholder**, not the real linguistics workbench. The conlang
workbench is being integrated into **Hayba Explorer** (the Tauri desktop
app), not rebuilt as a website build step. This is a recorded decision —
see [`../docs/adr/0003-defer-linguistics-explorer-integration.md`](../docs/adr/0003-defer-linguistics-explorer-integration.md).
The website intentionally has **no** build coupling to a worldbuilding
package.

## Local preview

No build/install. Serve the directory with any static file server from the
repo root so absolute paths (`/config.js`, `/style.css`, `/assets/...`)
resolve:

```bash
npx serve website
# or
python -m http.server -d website 8000
```

For local preview, `config.js` keeps its placeholder tokens — pages that
need the backend (login/admin/waitlist) won't reach a real API; the static
content renders fine. See [`../CONTEXT.md`](../CONTEXT.md) for repo
orientation.
