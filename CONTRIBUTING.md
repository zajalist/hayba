# Contributing to Hayba MCP Toolkit

Thanks for considering a contribution. This document covers the dev loop, conventions, and what to expect from review.

## Dev setup

You need:
- **Unreal Engine 5.7** (Editor with C++ toolchain, Visual Studio 2022 17.10+).
- **Node 20+** and **npm 10+**.
- **Python 3.11+** if you're touching the visual-embeddings sidecar.

```bash
git clone https://github.com/zajalist/hayba.git
cd hayba
npm install        # installs all workspaces
npm run build      # builds the Node MCP server (TS → dist)
```

The UE plugin lives under `packages/hayba/Plugins/HaybaMCPToolkit/`. Drop it into your UE project's `Plugins/` folder (or symlink), regenerate VS files, recompile.

## Repo layout

```
packages/hayba/
  src/                              # Node MCP server (TS)
  Plugins/HaybaMCPToolkit/
    Source/HaybaMCPToolkit/         # UE C++ plugin
      Private/                      # implementation
      Public/                       # exported headers
    Resources/                      # icons, SVGs, HTML for cognitive map
    ThirdParty/mcp_server/dist/     # bundled Node server
  addons/visual-embeddings/         # Python sidecar (FastAPI + CLIP / SpatialCLIP / OWL-ViT)
docs/superpowers/specs/             # design documents
website/                            # landing page
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

The `.githooks/pre-commit` hook runs `tsc` and restages `packages/hayba/dist/` whenever `packages/hayba/src/` is part of the commit. Activated by `npm install` via the `prepare` script — if your hooks aren't firing, run:

```bash
git config core.hooksPath .githooks
```

## Pull request checklist

Before requesting review:
- [ ] `npm run build` is clean.
- [ ] `npm run lint` passes with zero warnings.
- [ ] If you added a TS file, it's registered with the Zod schema registry so `get_tool_signature` returns derived params.
- [ ] If you added a C++ command, it's listed in the handler's `GetCommands()` AND dispatched in `Handle()`.
- [ ] If you added a destructive command, it's classified in `IsDestructiveCommand()` in `HaybaMCPCommandHandler.cpp` so transactions wrap it.
- [ ] Tests added or updated for any new/modified TS modules.
- [ ] Spec doc updated if behaviour changes (`docs/superpowers/specs/2026-05-06-hayba-ue-expansion-design.md`).
- [ ] CHANGELOG.md has an entry under `[Unreleased]`.

## Adding a new MCP tool

1. **Node side** — register the tool in `packages/hayba/src/tools/index.ts` with a Zod shape. The schema registry will derive its docs automatically.
2. **UE side** — add the command name to a handler's `GetCommands()` array, route in `Handle()`, implement the method.
3. **Spec doc** — list the command under the relevant `4.X Domain` table in the design spec.
4. **Test** — fire the tool through Claude or via the MCP CLI; verify it appears in the Tool Stream panel and (if destructive) is undoable.

## Adding a new domain handler

Use one of the existing handlers as a template (e.g., `HaybaMCPProjectHandler` for read-only commands, `HaybaMCPMaterialHandler` for editor mutations). Register it in `HaybaMCPModule.cpp::StartupModule` via `CommandHandler->Register(MakeShared<FYourHandler>())`.

## Issue conventions

- **Bug reports** — please include the UE version, plugin version, and a reproducer. Attach the editor crash dump if applicable.
- **Feature requests** — explain the use case and any relevant competitor benchmark from the [market analysis](docs/superpowers/specs/2026-05-06-hayba-ue-expansion-design.md#9-market-positioning--gap-analysis-2026-update).

## License of contributions

By submitting a contribution you agree your changes are released under the project's MIT license.
