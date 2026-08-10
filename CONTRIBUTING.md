# Contributing to Hayba MCP Toolkit

Thanks for considering a contribution. This document covers the dev loop, conventions, and what to expect from review.

## Dev setup

You need:
- **Unreal Engine 5.7** (Editor with C++ toolchain, Visual Studio 2022 17.10+).
- **Node ≥ 22.5** (see [`.nvmrc`](.nvmrc) — the codebase uses `node:sqlite`).
- **Python 3.10+** and [`uv`](https://docs.astral.sh/uv/) if you're touching
  the visual sidecar.

```bash
git clone https://github.com/zajalist/hayba.git
cd hayba
npm install                               # installs all workspaces
npm --prefix mcp-tools/hayba-mcp test     # tsc --noEmit + vitest (the gate)
npm --prefix mcp-tools/hayba-mcp run build:server   # TS -> dist (not `run build`, see below)
```

The UE plugin lives under `unreal/HaybaMCPToolkit/`. Copy or symlink it into
your UE project's `Plugins/` folder, regenerate VS files, recompile.

## Repo layout

```
mcp-tools/
  hayba-mcp/                        # Node MCP server (TS) — the core product
    src/                            # tool surface, schemas, TCP client
    addons/visual-embeddings/       # Python sidecar (FastAPI + CLIP / SpatialCLIP / OWL-ViT + SAM)
    addons/workflows/                # Claude Code skill bundles (Tier 3)
  pcgex/                            # PCGEx node-registry tooling
unreal/
  HaybaMCPToolkit/                  # UE C++ plugin (always loaded)
    Source/HaybaMCPToolkit/
      Private/                     # implementation, handlers/
      Public/                      # exported headers
    Resources/                     # icons, SVGs, HTML for cognitive map
  HaybaMCPGAS/, HaybaMCPMetaSound/  # optional satellite plugins (ADR-0008)
website/                            # landing page
supabase/, infra/                   # self-host backend
```

## Branching

- Feature branches off `main`: `feat/<scope>` or `fix/<scope>`.
- One logical change per branch. Small PRs are easier to review.
- Push to your branch, open a PR against `main`.

## Commit conventions

We follow Conventional Commits:

```
feat(mcp):    new MCP tool / capability
fix(ue):      bug fix in the UE plugin
refactor:    behaviour-preserving restructuring
chore:       tooling, dependencies, build scripts
docs:        documentation only
test:        adding tests
```

Scopes: `mcp` (Node server), `ue` (UE plugin), `sidecar` (visual-embeddings), `docs`, `workflows`.

**Don't include a Claude / AI co-author trailer.** Per project policy, those are omitted.

## Linting & formatting

Hayba uses **ESLint** (flat config) for TypeScript linting and **Prettier** for code formatting:

```bash
npm run lint          # Check for lint errors
npm run lint:fix      # Auto-fix lint errors
npm run format        # Check formatting
npm run format:fix    # Auto-format all files
```

These run in CI on every push/PR. Make sure `npm run lint` passes with zero warnings.

## Pre-commit

The `.githooks/pre-commit` hook runs `tsc --noEmit` (nothing else — it does
not restage `dist/`) whenever `mcp-tools/hayba-mcp/src/`, `tsconfig.json`, or
`package.json` is part of the commit. Activated by `npm install` via the
`prepare` script — if your hooks aren't firing, run:

```bash
git config core.hooksPath .githooks
```

## Pull request checklist

Before requesting review:
- [ ] `cd mcp-tools/hayba-mcp && npx tsc --noEmit && npm test` is clean — the
      authoritative gate. CI on this repo is unreliable; don't rely on it
      instead of running the gate locally.
- [ ] `npm run lint` passes with zero warnings.
- [ ] If you added a TS file, it's registered with the Zod schema registry so `get_tool_signature` returns derived params.
- [ ] If you added a C++ command, it's listed in the handler's `GetCommands()` AND dispatched in `Handle()`.
- [ ] If you added a destructive command, it's classified in `IsDestructiveCommand()` in `HaybaMCPCommandHandler.cpp` so transactions wrap it.
- [ ] Tests added or updated for any new/modified TS modules, and mutation-tested (break the code, watch the test go red, revert) — see `docs/WORKFLOW-improving-the-mcp.md`.
- [ ] Docs updated if behaviour changes.
- [ ] CHANGELOG.md has an entry under `[Unreleased]`.

## Adding a new MCP tool

1. **Node side** — register the tool in `mcp-tools/hayba-mcp/src/tools/index.ts` with a Zod shape. The schema registry will derive its docs automatically.
2. **UE side** — add the command name to a handler's `GetCommands()` array, route in `Handle()`, implement the method.
3. **Changelog** — add an entry under `[Unreleased]` in `CHANGELOG.md`.
4. **Test** — fire the tool through Claude, or against a running editor via `hayba-cli` (`mcp-tools/hayba-mcp/src/cli`); verify it appears in the Tool Stream panel and (if destructive) is undoable.

## Adding a new domain handler

Use one of the existing handlers as a template (e.g., `HaybaMCPProjectHandler` for read-only commands, `HaybaMCPMaterialHandler` for editor mutations). Register it in `HaybaMCPModule.cpp::StartupModule` via `CommandHandler->Register(MakeShared<FYourHandler>())`.

## Issue conventions

- **Bug reports** — please include the UE version, plugin version, and a reproducer. Attach the editor crash dump if applicable.
- **Feature requests** — explain the use case and the problem it solves.

## License of contributions

By submitting a contribution you agree your changes are released under the project's MIT license.
