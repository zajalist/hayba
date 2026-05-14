# Linguistics Workbench → Main Hayba Site — Integration Design

**Date**: 2026-05-13
**Status**: Approved, ready for implementation planning
**Closes**: extends `packages/linguistics/` (PRs #100, #110, #111) into a public product

---

## Context

We have a feature-complete conlang workbench at `packages/linguistics/demo/` — vanilla JS, ~3900 lines split across per-view modules, 264 passing tests. It runs end-to-end in a browser with localStorage as the only persistence layer. There is no auth, no multi-device, no share-by-link.

Three web surfaces exist in the repo today:

- `website/` — the public Hayba marketing landing page. Hand-rolled HTML/CSS/JS, Inter font, light marketing aesthetic. Currently positioned as a "terrain + PCG tool."
- `packages/hayba/dashboard/` — an internal React/Vite SPA with tabs Projects · PCG · Linguistics · Settings. Already themed for the UE plugin look. Has a stub `LinguisticsPage.tsx` that's just an IPA palette demo.
- `packages/linguistics/demo/` — the full workbench (the focus of this design).

This design integrates the linguistics workbench into the main Hayba site so logged-in users can create, persist, and share conlangs across devices. It also restyles the marketing site to match the workbench's visual identity and repositions Hayba as a worldbuilding toolset rather than a terrain tool with a linguistics afterthought.

The user has two physical servers — `srv-dev-01` and `srv-dev-02` — with ~500 GB combined storage and modest specs. Self-hosting is a hard requirement; the design must be free to operate and support 50 users from a managed waitlist.

## Goals

1. **Persistence per user** — a logged-in user can edit conlangs on one device and see them on another.
2. **Share by link** — flip a language public; visitors at `hayba.app/lang/:id` see a read-only workbench mirror, can fork into their own account if signed in.
3. **Waitlist + admin approval** — public waitlist form with a short questionnaire; admin queue at `/admin` lets a privileged user approve entries, which triggers a magic-link invite email.
4. **Marketing restyle** — `website/` is rewritten in the workbench's UE plugin theme and repositioned as a worldbuilding toolset. Linguistics gets first-class billing alongside tectonics, architecture, and the UE5 MCP plugin.
5. **Operate free at 50 users** — no paid services. Self-hosted Supabase on `srv-dev-01`, frontend on Vercel free tier, Cloudflare Tunnel for public access without inbound ports.
6. **Leave the existing dashboard SPA alone** — `packages/hayba/dashboard/` retains its Projects · PCG · Settings views for the other Hayba pillars; the linguistics stub is replaced with a link to the new workbench at `/app`.

## Non-goals

- No SSR. Every page is static HTML loaded into the browser; Supabase JS does the data fetching client-side.
- No password auth and no social login. Magic links only.
- No public discoverable conlang directory. Share-by-link only; users who haven't been linked don't see anyone else's work.
- No CRDT or operational-transform. Conflict resolution is last-write-wins per language. If we ever hit a real collision in practice we'll add a "this was edited elsewhere — reload?" prompt, not a merge engine.
- No rate limiting beyond Cloudflare's free-tier defaults.
- No HA load balancing. `srv-dev-02` is a warm spare with nightly backups, not a hot standby.
- No share-link OG preview cards in v1 (later phase).

---

## Section 1 — Architecture

```
USER BROWSER
  │
  ├──→ hayba.app                          (Vercel free tier)
  │      ├─  /                             static marketing
  │      ├─  /waitlist                     static form
  │      ├─  /login                        static magic-link page
  │      ├─  /app, /app/lang/:id           static workbench shell
  │      ├─  /lang/:id                     static read-only mirror
  │      └─  /admin                        static admin queue
  │
  └──→ api.hayba.app                       (Cloudflare Tunnel)
         │
         └→ srv-dev-01  (Docker Compose: Supabase OSS)
              ├─ postgres 15
              ├─ gotrue           — auth + magic links
              ├─ postgrest        — REST API
              ├─ kong             — gateway
              ├─ storage-api      — file blobs (unused in v1)
              ├─ studio           — DB admin UI
              └─ caddy            — reverse proxy

         srv-dev-02
              ├─ nightly pg_dump → 30-day rolling snapshots
              └─ warm spare; can promote to primary on disk failure
```

### Why this shape

- **50 users, all client-side compute.** The workbench's heaviest operations (PHOIBLE corpus loading, sound-change application, name generation, allophony rendering) run in the browser. Backend only handles auth + CRUD. Postgres + 6 supporting containers on one box is well under-loaded; the second box is insurance, not capacity.
- **Cloudflare Tunnel.** Free, no inbound firewall changes, automatic TLS, includes DDoS protection. Avoids Let's Encrypt cron, port-forward configuration, and dynamic DNS.
- **Vercel for frontend.** The workbench is purely static; SSR adds zero value. Vercel free tier covers 100GB bandwidth + unlimited static deploys — far beyond what 50 users will consume. Switching to self-hosted nginx on `srv-dev-02` later is a 30-minute migration if we want full self-host.

---

## Section 2 — URL surface

| Path | Audience | What it does | Source |
|---|---|---|---|
| `/` | Public | Marketing landing — hero, features, "Join the waitlist" CTA. Restyled to UE-plugin theme. | `website/index.html` |
| `/waitlist` | Public | Sign-up form: email + short questionnaire. POSTs to `waitlist_entries`. | `website/waitlist/index.html` |
| `/login` | Approved users | Email magic-link form. Calls `auth.signInWithOtp({ email })`. | `website/login/index.html` |
| `/app` | Signed in | Dashboard shell with the existing 11 workbench tabs. Loads user's languages from Postgres on mount. | `packages/linguistics/demo/` |
| `/app/lang/:id` | Signed in | Same shell, deep-linked to a specific language. | `packages/linguistics/demo/` |
| `/lang/:id` | Public if shared | Read-only mirror of a language whose `is_public = true`. Anonymous Supabase read via RLS. | `packages/linguistics/demo/` (readonly mode) |
| `/admin` | Admin only | Waitlist queue with Approve/Reject actions. | `website/admin/index.html` |

### Auth gates

- `/`, `/waitlist`, `/login` — public, no auth check.
- `/app/*` — requires `auth.getSession()` non-null; otherwise redirect to `/login`.
- `/lang/:id` — public if the language's `is_public` RLS policy allows; otherwise 404.
- `/admin` — requires the calling user's `profiles.is_admin = true`; otherwise 403.

---

## Section 3 — Database schema

Three new migrations layer on top of the existing 0001–0003 linguistics schema.

### New tables

**`profiles`** — mirrors `auth.users` 1:1, holds Hayba-specific user state.

```sql
profiles (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text,
  is_admin    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
)
```

RLS: read own row; admin reads all.

**`waitlist_entries`** — public waitlist queue.

```sql
waitlist_entries (
  id              bigserial PRIMARY KEY,
  email           text NOT NULL UNIQUE,
  questionnaire   jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL CHECK (status IN ('pending','approved','rejected')) DEFAULT 'pending',
  approved_by     uuid REFERENCES auth.users(id),
  approved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
)
```

RLS: `INSERT` open to anon role. `SELECT/UPDATE` requires `profiles.is_admin = true`. `email` uniqueness prevents duplicate submissions.

**`languages`** — top-level ownership wrapper.

```sql
languages (
  id           text PRIMARY KEY,                       -- slug, user-pickable
  owner_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  is_public    boolean NOT NULL DEFAULT false,
  snapshot     jsonb NOT NULL DEFAULT '{}'::jsonb,     -- whole-language blob
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
)
```

RLS: `SELECT` if `owner_id = auth.uid()` OR `is_public`. `INSERT/UPDATE/DELETE` if `owner_id = auth.uid()`.

### Existing tables — additive change

`language_lexicon`, `language_lexicon_stage`, and `language_wordlink` (already in migrations 0001 + 0003) get a `language_id text NOT NULL REFERENCES languages(id) ON DELETE CASCADE` foreign key added. RLS joins through `languages.owner_id`.

### Hybrid blob + normalized model

- **`languages.snapshot jsonb`** holds everything the workbench already serializes in `state.languages[id]` — phonology, romanization rules, grammar paradigms, typology, prosody, allophony, derivation rules, sound-change rules. Single read on load, single write on save. Zero schema churn when new features land.
- **Normalized tables** (lexicon, lexicon_stage, wordlink) stay for things that need cross-language queries: dictionary search, wordlink-by-concept lookup, the family-tree engine reading cognates. `PostgresLexicon` and `PostgresWordlinks` adapters from the linguistics package already speak these tables.
- **Conflict policy** — blob is the source of truth on workbench load; normalized tables are projections written-through on autosave. If they drift (rare), the blob wins on next load.

### Migrations to add

- `0004_auth_profiles.sql` — `profiles` table + admin flag + trigger to create profile on user signup.
- `0005_waitlist.sql` — `waitlist_entries` + RLS.
- `0006_languages.sql` — `languages` table + RLS + add `language_id` FK to existing linguistics tables.

---

## Section 4 — Workbench wrapper

The existing workbench is left structurally untouched. Five small new modules wrap it:

```
packages/linguistics/demo/
  index.html, main.js, state.js, views/, components/    ← unchanged
  auth.js         ← Supabase client, session bootstrap, route guards
  sync.js         ← localStorage ↔ Postgres bidirectional sync
  views/lang-picker.js    ← topbar language switcher with new/share/delete
  views/auth-gate.js      ← redirect-to-login if no session
  views/share.js          ← share-link panel (toggle is_public, copy URL, fork)
```

### Offline-first sync model

- User edits trigger `saveState()` as today → writes to localStorage immediately (zero latency, no UI stalls).
- `sync.js` debounces 2s of idle and ships the affected `languages.snapshot` to Postgres. Each language carries a `_meta.local_dirty` flag until the write succeeds.
- Offline: edits accumulate in localStorage. On reconnect, `sync.js` replays every dirty language. If a remote version is newer (compared by `updated_at`), the local version wins (last-write-wins per language; see non-goals).
- Normalized tables (lexicon, wordlinks) are projections of the snapshot — `sync.js` reconciles them server-side via a Postgres function invoked from the snapshot UPSERT.

### Boot flow

1. `auth.js` calls `supabase.auth.getSession()`. If null and the path is `/app/*` → redirect `/login`.
2. `sync.js` fetches all `languages` owned by the user (`SELECT * FROM languages WHERE owner_id = auth.uid()`). The list goes into `state.languages` (snapshots) and the topbar language switcher.
3. If a hash like `#lang/my-conlang` is present, load that. Otherwise load the most recently updated.
4. **First-time login from a browser with existing localStorage** — show a "Migrate your local conlangs" banner. One click uploads everything in `state.languages` to Postgres, owned by the new account. localStorage stays as the offline cache.

### State shape — minimal change

Today: `state.languages = { "my-conlang": { selected, lexicon, rules, … } }`.

Tomorrow: same shape, but each entry gains:

```js
{
  ...existing fields...,
  _meta: {
    id: string,            // slug, matches languages.id PK
    owner_id: string,      // uuid as string
    is_public: boolean,
    updated_at: string,    // ISO timestamp
    local_dirty: boolean,
  }
}
```

Every existing renderer keeps reading the same fields. Only `sync.js` looks at `_meta`.

### Share-link flow

1. The Share button in the language picker menu sets `languages.is_public = true` and returns the public URL `hayba.app/lang/:id`.
2. The public route loads the language as anonymous; RLS allows the read; the UI mounts in read-only mode (writes disabled, "Sign in to fork" button visible).
3. Fork copies the snapshot into a new `languages` row owned by the visitor (if signed in). The clone gets a `wordlinks` row of `kind: 'cognate'` back to the source as audit trail.

---

## Section 5 — Admin queue + waitlist form

### Waitlist form (`/waitlist`)

Four fields, in order:

1. **Email** — required.
2. **What are you making?** — required dropdown: Game (indie/studio/mod) · Novel/fiction/comics · TTRPG/setting book · Animation/film/visual project · Worldbuilding as a hobby · Academic/research · Just curious.
3. **Which tools sound most useful?** — optional multi-select chips, 22 chips across 4 groups:
   - **Geology · planet**: Planet physics · Tectonics · Terrain · Hydrology · Atmosphere · Cartography
   - **Life · societies**: Biomes · Flora & fauna · Linguistics · Cultures · History · Religion · Naming
   - **Built environment**: Architecture · Economy · Politics · Magic systems
   - **Pipelines**: UE5 plugin · MCP toolkit, Gaea integration, Houdini/Blender export, AI agents · MCP for LLMs, Other
4. **Tell us about your project** — optional free-text textarea.

Stored as `waitlist_entries.questionnaire jsonb`:

```json
{
  "making": "game",
  "tools": ["linguistics", "ue5-plugin", "tectonics"],
  "notes": "Stone-age fantasy creole — wants tone marks"
}
```

### Admin queue (`/admin`)

- Status counters at top: Pending · Approved · Remaining slots (50 minus approved).
- Filter dropdown: Pending / Approved / All.
- Card per entry: email + status pill + relative time + Approve / Reject buttons + the questionnaire answers inline.
- Tool chips render inline on each card so the admin can scan "5 of the last 10 want Linguistics + UE5 plugin" at a glance.

### Approval mechanics

- Click **Approve** → backend RPC `approve_waitlist_entry(id)` → updates `status='approved'` + `approved_by` + `approved_at` → triggers `auth.admin.inviteUserByEmail(entry.email)` → user gets a magic-link email with a 24h link.
- Click **Reject** → status update only, no email.
- Re-approving an existing email is a no-op.

---

## Section 6 — Marketing restyle

The current `website/index.html` is rewritten in the workbench's design language. No new framework — the site stays a pile of hand-rolled HTML + CSS + JS, but the theme tokens swap to the UE-plugin palette.

### What changes

- **Theme** — Inter → Segoe UI / Noto Sans (matches workbench). Light → slate-base `#1b1e24`. Marketing-sharp typography → orange accent `#B56A1D`. Charis SIL for any IPA samples in marketing copy.
- **Copy** — repositioning from "AI-powered terrain + PCG tool" to "worldbuilding toolset." Linguistics gets first-class billing alongside tectonics, architecture, and the UE5 MCP plugin.
- **Primary CTA** — "Get Started" (which opened docs) becomes "Join the waitlist." Secondary CTA "See the linguistics tool" deep-links into `/lang/demo-conlang` — a public read-only share so visitors poke around without an account.
- **Hero animation** — the existing isometric terrain canvas is kept but recoloured to slate + orange to fit the new palette.

### What doesn't change

- The marketing site stays a static HTML deploy. No React, no Next.js.
- Vercel free tier remains the deploy target.
- All existing content blocks (features grid, product cards, footer) are recoloured and re-typed, not rewritten from scratch.

---

## Error handling

- **Auth failure** (expired magic link, invalid session) — clear session, redirect to `/login` with a non-modal hint banner.
- **Network failure during sync** — `sync.js` marks the language `local_dirty: true` and shows a small "saving locally" indicator in the topbar. On reconnect, queued writes replay automatically; indicator clears.
- **RLS denial** (e.g. someone forks a URL that's been un-shared) — surface a "this language is no longer public" page with a link back to the user's own dashboard.
- **Postgres unavailable on app load** — fall back to localStorage-only mode with a banner. Writes still work locally; sync resumes when the backend returns.
- **Schema migration failure** during deploy — automated rollback via the seed-then-apply pattern in supabase migrations. The deploy script runs `--dry-run` first, only applies on clean output.
- **Admin RLS bypass attempt** (regular user calling `/admin` endpoints) — Postgres rejects via RLS, frontend redirects to `/app`.

---

## Testing

- **Engine tests** — keep all 264 existing linguistics tests passing. No change.
- **Auth + sync tests** (~20 new) — mock Supabase client; verify offline → online replay; verify conflict detection (last-write-wins); verify RLS-violation handling on the client side.
- **Browser smoke tests via browser-harness** — full path: visit `/`, submit `/waitlist`, log in as admin, approve, magic-link arrives in dev mailbox, sign in, create language, edit, sign out, sign in on another browser session, verify state persists, flip share-link, anonymous visit, fork.
- **Self-host smoke** — `docker-compose up` on srv-dev-01, verify Cloudflare Tunnel routes `api.hayba.app/auth/v1/health` end-to-end, basic load test with 5 concurrent users editing.
- **RLS verification** — explicit Postgres test: anonymous role cannot SELECT private languages, cannot SELECT or UPDATE waitlist entries; non-admin user cannot SELECT other users' profiles or waitlist entries.

---

## Rollout

1. **Week 1** — schema migrations + auth wrapper + waitlist form + admin page. No public deploy yet. srv-dev-01 only, accessed via LAN, admin bootstrapped via direct SQL (`UPDATE profiles SET is_admin = true WHERE …`).
2. **Week 2** — marketing restyle + Vercel deploy + Cloudflare Tunnel for prod. Public waitlist opens.
3. **Week 3** — invite first 10 from waitlist. Watch for sync bugs and RLS misconfigurations. Iterate.
4. **Week 4** — invite remaining 40 in batches of 10.

---

## Open follow-ups (post-v1)

- Share-link OG preview cards (`og.html` template that reads from query params).
- Public discoverable conlang directory (if user demand emerges).
- Rejection emails with a custom reason field.
- Password auth + social login if magic-link fatigue surfaces.
- Promote srv-dev-02 from warm spare to a Postgres read replica if read load becomes a real signal.
- A proper offline conflict-resolution UI ("this was edited elsewhere — reload?") if last-write-wins causes user-visible data loss.

---

## File layout summary

```
docs/superpowers/specs/
  2026-05-13-linguistics-website-integration-design.md     (this document)

packages/linguistics/migrations/
  0001_lexicon.sql                  (existing)
  0002_lexicon_pos.sql              (existing)
  0003_wordlinks.sql                (existing)
  0004_auth_profiles.sql            ← new
  0005_waitlist.sql                 ← new
  0006_languages.sql                ← new

packages/linguistics/demo/
  index.html, main.js, state.js     (existing — unchanged)
  views/, components/               (existing — unchanged)
  auth.js                           ← new (Supabase client + session)
  sync.js                           ← new (local ↔ remote)
  views/lang-picker.js              ← new
  views/auth-gate.js                ← new
  views/share.js                    ← new

website/
  index.html                        (restyle in place)
  style.css                         (token swap to UE-plugin theme)
  waitlist/index.html               ← new
  login/index.html                  ← new
  admin/index.html                  ← new

infra/                              ← new directory
  docker-compose.supabase.yml       (Supabase OSS stack for srv-dev-01)
  caddy.conf                        (reverse proxy config)
  cloudflared.yml                   (tunnel config)
  backup.sh                         (nightly pg_dump → srv-dev-02)
```

No changes to `packages/hayba/dashboard/` — it stays as the home for the other Hayba pillars (Projects · PCG · Settings). Its `LinguisticsPage` stub gets a one-line update: link out to `/app`.
