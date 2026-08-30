# Track D — Distribution: install friction and repo hygiene

Two problems that share a root: **the repo is the product's front door, and
right now it is a workshop, not a shopfront.** Adoption dies at install; and
what a visitor sees first is a 2.3 GiB clone.

Facts established 2026-08-23 (all verified against the repo).

---

## D1 — Install friction

### What a new user faces today
From `README.md:43-68`:

1. Copy `unreal/HaybaMCPToolkit/` into their project's `Plugins/`
2. Regenerate Visual Studio project files
3. **Recompile the project** (UE 5.7+, VS 2022)
4. Hand-edit their MCP client's JSON config with an absolute path to
   `mcp-tools/hayba-mcp/dist/index.js`
5. …which does not exist until they build the Node server (`dist/` is not
   committed — verified: 0 tracked files)

That is: a C++ toolchain requirement, a manual build, a manual second build,
and hand-edited JSON with an absolute path. Every step is a drop-off point,
and step 3 excludes anyone on a Blueprint-only project without VS installed.

### What the field does better
- **Zero-plugin path** (runreal): two settings toggles, no build at all.
- **Prebuilt binaries per engine version** (GenOrca, ChiR24): no compiler needed.
- **In-editor client auto-configurator** (Unity-MCP, 13.6k★): a Window menu
  item detects Claude Code / Cursor / VS Code / Claude Desktop and **writes
  their MCP config for them**. This single feature kills the worst step.
- **One-line CLI registration** (remiphilippe): `npx`-style, no JSON editing.
- **`uvx`-style installer** (blender-mcp, 26.2k★): one command, done.

### The plan, in order of value

**D1.1 — Publish the server to npm.** `package.json` already declares
`@hayba/mcp` v1.0.0 with a `bin` entry, so the work is mostly release
plumbing. Then step 4-5 collapse to:
```
claude mcp add hayba -- npx -y @hayba/mcp
```
No clone, no build, no absolute path. **Highest single win available.**

**D1.2 — Ship prebuilt plugin binaries per engine version.** Attach
`HaybaMCPToolkit-UE5.x-Win64.zip` to GitHub Releases (one release exists,
`v0.1.0`, with no binaries). Removes the VS/recompile requirement for anyone
whose engine version matches — which is the majority. Keep source-build
documented for the rest.

**D1.3 — In-editor client auto-configurator** (this is P5 in the master plan;
it belongs here too). A Settings action that detects installed MCP clients and
writes their config. Steal the Unity-MCP flow wholesale — it is the
best-proven onboarding fix in the field.

**D1.4 — First-run honesty.** The wizard currently claims "7 panels" (there
are 11), names three that do not exist, and ends on "Coming soon." Covered by
W6; listing here because first-run *is* install friction.

**D1.5 — A 60-second path in the README.** Lead with the npx line and a
prebuilt-plugin download. Move "regenerate project files and recompile" into a
**Building from source** section further down. The first thing a reader sees
should be the fastest thing that works.

### Deliberately NOT doing
A zero-plugin fallback (Python Remote Execution, runreal-style). The Node
server owns the validator, recipes, routing and the world model — a
plugin-free mode would be a different, much thinner product. Better to make
the plugin trivially installable than to fake not needing it.

---

## D2 — Repo hygiene

### Findings

| Check | Result |
|---|---|
| Packed size | **2.32 GiB** — a clone is punitive |
| Tracked `Binaries/`/`Intermediate/` | **0** — correctly gitignored (both root and `unreal/**`) |
| Tracked binaries | 1 (`Resources/pcgex_registry.db`, 446 KB — legitimate, it is shipped data) |
| `website/assets/` | **53 MB across 46 files** — a single 5.6 MB PNG, multiple 3 MB JPEGs |
| Committed `dist/` | none (correct) |
| CI | `ci.yml`, `codeql.yml`, `production-dependency-audit.yml` |
| Releases | one (`v0.1.0`), **no attached binaries** |

### The 2.32 GiB question — investigate before acting
A previous cleanup established that the bloat was *unreachable* objects, not
history, and `gc` was the fix (not `filter-repo`). Packed size is now 2.32 GiB
against ~53 MB of obvious large assets, so **something else dominates the
pack** — most likely historical blobs from before the repo split, or earlier
generations of the website imagery.

Do this in order, and **measure before you rewrite anything**:
1. `git count-objects -vH` and a largest-blobs-in-history report.
2. Run `gc --prune=now --aggressive` first and re-measure — the last time this
   looked catastrophic, garbage was the whole story.
3. Only if reachable history genuinely holds tens of large dead blobs, and
   only with an explicit decision to rewrite, consider `filter-repo`.
   **History rewriting breaks every existing clone and tag** — this repo owns
   the `hayba-explorer-v0.*` tags that must never be lost.

### Website assets
53 MB of source-resolution PNG/JPEG in the repo. Options, cheapest first:
- Compress in place (WebP/AVIF at display resolution) — a 5.6 MB PNG for a web
  page is a bug regardless of git.
- If the site is deployed from this repo (it is — `vercel.json`), compression
  also improves the live site. Do this one for its own sake.
- Only consider moving them out of git if compression is insufficient.

### Front-door polish (cheap, high signal)
The repo has `README`, `CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY`,
`CHANGELOG`, `LICENSE`, ADRs, and `CONTEXT.md` — genuinely better hygiene than
most of the field. What is missing is *presentation*:
- README opens with install steps, not with **what this is and a picture of it
  working**. Lead with a screenshot or short capture of the new UI (available
  after P3a).
- Publish `CAPABILITIES.md` (F7) and `RELIABILITY.md` (R4) and link both from
  the README — those two documents are the differentiators, and nothing in the
  field has either.
- Pin the honest tool count in one generated place so it stops drifting.

### CI honesty
Per the standing note, CI reliability is a known internal issue and is **not**
to be documented as broken in-repo. Verify locally before releasing; do not
add public commentary about CI state.

---

## Sequencing

```
D1.1 npm publish        ── independent, do first (biggest win, least work)
D1.2 prebuilt binaries  ── needs a release process; pairs with D1.1
D2 asset compression    ── independent, improves the live site too
D2 pack investigation   ── measure first, act only on evidence
D1.5 README rewrite     ── after D1.1/D1.2 exist to point at
D1.3 auto-configurator  ── with P3b (it is a Settings surface)
D1.4 wizard honesty     ── with W6
README screenshots      ── after P3a
```

## Definition of done
- A new user can go from zero to a working agent connection **without a
  compiler and without editing JSON by hand**.
- `git clone` is not a punishment.
- The README's first screen answers "what is this?" with a picture, and its
  first instruction is one line long.
