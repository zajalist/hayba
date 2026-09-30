# Versioning

One product version tracks across the three plugins' `VersionName`
(`HaybaMCPToolkit`, `HaybaMCPMetaSound`, `HaybaMCPGAS`), the MCP server
(`mcp-tools/hayba-mcp/package.json`) and the root `package.json`. Bump all
of them together; they never drift from each other.

Semver applies while the product is 0.x, with one addition: because the
product is pre-1.0, a **minor** version bump (`0.X.0`) may change the
wire protocol between the server and the plugin, not just add features.
A patch bump (`0.X.Y`) never changes the wire protocol.

Release candidates are tagged `vX.Y.Z-rc.N` (for example `v0.4.0-rc.1`).
An rc tag marks a build that has cleared the gate but not yet finished
its live deploy window; the plain `vX.Y.Z` tag marks the version once
every rc's deploy is done.

The P0 safety train is version **0.4.0**. Its deploys are numbered as
release candidates of that version:

- Deploy A → `v0.4.0-rc.1`
- Deploy B → `v0.4.0-rc.2`
- `v0.4.0` is tagged after Deploy C.

The first installer release is **0.5.0**.

`packages/*` (the worldbuilding libraries) version independently of the
product version above; each has its own `package.json` version.
