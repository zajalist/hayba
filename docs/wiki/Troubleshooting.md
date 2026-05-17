# Troubleshooting

Common issues, with the authoritative references.

## TCP port conflicts (multi-instance)

The UE plugin's `FHaybaMCPTcpServer` listens on `:52342` and auto-falls back
through `:52343–52350` when the port is taken — so multiple UE editors can
coexist. Each instance publishes its actual port to
`Saved/HaybaMCP/instances/<pid>.json`.

- **Symptom:** the Node server can't reach UE, or talks to the wrong editor.
- **Fix:** point the Node side at the right port via `UE_TCP_PORT` (and
  `UE_TCP_HOST`) — see `mcp-tools/hayba-mcp/src/config.ts`. Check
  `Saved/HaybaMCP/instances/` for which pid owns which port. The Node
  dashboard defaults to `:52343` (`DASHBOARD_PORT`), which can itself
  collide with a fallback TCP port — change one of them if so.

## Node version (`< 22.5` crash)

`@hayba/mcp` requires **Node ≥ 22.5** (`engines` in
`mcp-tools/hayba-mcp/package.json`). Older Node crashes on the
`node:sqlite`-adjacent native dependencies.

- **Symptom:** the server crashes on startup with a native/sqlite error.
- **Fix:** upgrade to Node ≥ 22.5. (`@hayba/gaea-server` only needs
  Node ≥ 20.)

## GitHub Actions is non-functional

Every Actions run for this repo fails with zero step output — an
account/runner/billing condition, not a code defect. "CI green" is
unachievable here.

- **Do not** block work on red GitHub checks.
- The **authoritative gate is local** — see
  [`../adr/0005-github-actions-nonfunctional-local-gate.md`](../adr/0005-github-actions-nonfunctional-local-gate.md):

```bash
npm install
npm run -w @hayba/linguistics build   # + @hayba/architecture, @hayba/planet-physics
npm --prefix mcp-tools/hayba-mcp test  # tsc --noEmit + vitest
```

## Workspace deps must be built before testing hayba-mcp

`@hayba/mcp` depends on `@hayba/architecture`, `@hayba/linguistics`, and
`@hayba/planet-physics`. Running `npm test -w @hayba/mcp` (or the local
gate) **before those packages are built** fails with unresolved-import /
missing-`dist` errors.

- **Fix:** build the workspace deps first (the gate command above does this),
  then run the hayba-mcp test.

## Visual sidecar unavailable

The Python visual sidecar is optional and degraded-mode aware. The server
background-probes it at startup and prints a 🟢/🔴 status line; if it's 🔴,
visual tools degrade gracefully — it is not fatal. Setup is Tier 2 in
[`../getting-started.md`](../getting-started.md).
