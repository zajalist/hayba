# Versioning

Hayba ships one product version. The Unreal plugins (`VersionName` in each
`.uplugin`), the MCP server (`@hayba/mcp`) and the root workspace all carry the
same number. Each `.uplugin` integer `Version` goes up by one per release.
Library packages under `packages/` version on their own.

- **Semver while 0.x.** A minor bump (0.3 → 0.4) may change the wire protocol
  between the server and the plugins, so upgrade both together. A patch bump
  does not.
- **Release candidates** are tagged `vX.Y.Z-rc.N`.
- Every release gets a `CHANGELOG.md` section and an annotated `vX.Y.Z` tag.

## Planned

| Version | Contents |
| --- | --- |
| 0.4.0-rc.1 | P0 safety train, deploy A |
| 0.4.0-rc.2 | P0 safety train, deploy B |
| 0.4.0 | P0 safety train, final after deploy C |
| 0.5.0 | First installer release |
