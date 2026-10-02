# Versioning

One product version tracks across the three plugins' `VersionName`
(`HaybaMCPToolkit`, `HaybaMCPMetaSound`, `HaybaMCPGAS`), the MCP server
(`mcp-tools/hayba-mcp/package.json`) and the root `package.json`. Bump all
of them together; they never drift from each other.

Candidate fields use the full prerelease version without a leading `v`
(for Deploy B, `0.4.0-rc.2`). Root lockfile product entries and the shipped
private dashboard package and its root lock metadata follow the same version.
The MCP server reads its own package version once, relative to its module,
for both `serverInfo.version` and the startup diagnostic in source and built code.

Each UE plugin's integer `Version` is a plugin-local, monotonically increasing
distribution revision, not an encoded semver value. Deploy B advances Toolkit
to 5, MetaSound to 3 and GAS to 3; subsequent distributed descriptor revisions
must increase each affected plugin's integer.

Semver applies while the product is 0.x, with one addition: because the
product is pre-1.0, a **minor** version bump (`0.X.0`) may change the
wire protocol between the server and the plugin, not just add features.
A patch bump (`0.X.Y`) never changes the wire protocol.

Release candidates are tagged `vX.Y.Z-rc.N` (for example `v0.4.0-rc.1`).
An rc tag marks a build that has cleared the gate but not yet finished
its live deploy window; the plain `vX.Y.Z` tag marks the version once
every rc's deploy is done.
Every release also receives a `CHANGELOG.md` section and an annotated tag.

The P0 safety train is version **0.4.0**. Its deploys are numbered as
release candidates of that version:

- Deploy A → `v0.4.0-rc.1`
- Deploy B → `v0.4.0-rc.2`
- `v0.4.0` is tagged after Deploy C.

The first installer release is **0.5.0**.

`packages/*` (the worldbuilding libraries) version independently of the
product version above; each has its own `package.json` version.
