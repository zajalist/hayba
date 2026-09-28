# website — Hayba public site

The public marketing/landing site. **Static HTML/CSS/JS — no framework, no
build step.** Vercel serves the `website/` directory as-is (see
[`../vercel.json`](../vercel.json), `outputDirectory: "website"`).

This README lives in `docs/` rather than `website/` so it is not served
publicly. Keep repo-only files (READMEs, `.gitignore`, notes) out of
`website/`: everything in that directory is published.

Lives at the repo top level by decision — see
[`adr/0002-website-at-top-level.md`](adr/0002-website-at-top-level.md).

## Structure

```
index.html        landing page          main.js    nav/scroll behaviour
style.css         global styles

about/   app/   docs/   showcase/          ← each an index.html subpage
assets/   logos (Logo.svg, Logo-white.svg) · fonts/ (Noto Sans woff2 + OFL.txt)
lib/      gl-quad.js · hero-field.js · ripples.js · starfield.js ·
          page-toc.js   (vanilla helpers, no bundler)
```

The site collects no data: there are no forms, accounts or backend calls.
Calls to action point at GitHub (source, releases, issues). Fonts are
self-hosted (`assets/fonts`, SIL OFL 1.1), so pages make no third-party
requests; only the outbound GitHub links leave the site.

## Routing

[`../vercel.json`](../vercel.json) rewrites:

| Source | Destination |
|---|---|
| `/app/:path*` | `/app/index.html` |
| `/lang/:id` | `/app/index.html` |

`/app` and `/lang/:id` both resolve to `app/index.html`, a placeholder
saying the conlang workbench is not hosted on the site. The website has
**no** build coupling to a worldbuilding package.

## Deploys

Git deploys are off (`"git": { "deploymentEnabled": false }`), so merging
to `main` does not redeploy. A production deploy has to be run explicitly.

## Local preview

No build/install. Serve the directory with any static file server so
absolute paths (`/style.css`, `/assets/...`, `/lib/...`) resolve:

```bash
npx serve website
# or
python -m http.server -d website 8000
```

See [`../CONTEXT.md`](../CONTEXT.md) for repo orientation.
