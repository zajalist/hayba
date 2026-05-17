# @hayba/architecture

Architecture generation kernel: schema, rule resolution, validation, and the Culture Studio authoring surface.

## Culture Studio

The Culture Studio is the authoring surface for cultures, eras, materials, ornaments, tag axes, and conditional rules. It replaces the prior style-guide viewer.

### Running the demo

```bash
cd packages/architecture
npm run build
node demo/serve.mjs
# open http://localhost:5184/demo/
```

Set `PORT=<n>` to override. The server auto-increments if the port is busy.

### Data layout

Per-culture, three JSON files under `src/data/cultures/<culture-id>/`:

- `culture.json` — structural data (id, name, region, climate, tag axes, rules, eras with defaults / typologyMix / era-rules), plus `{id, name}` indexes into the libraries.
- `materials.json` — full `Material[]`.
- `ornaments.json` — full `Ornament[]` (each may carry `referenceImagePaths` + `pbrTexturePath`).

Writes are atomic (temp-file + rename) and keys are alphabetically sorted for diff stability.

The 11 original style guides were migrated into 6 cultures, each with multiple eras:

| Culture | Eras |
|---|---|
| `andean` | Tiwanaku, Inca |
| `edo-japanese` | Early Edo, Late Edo |
| `hausa` | Classic, Colonial-era |
| `industrial-revolution-english` | Early Industrial, High Victorian |
| `medieval-european` | Romanesque, Gothic |
| `tang-chinese` | Early Tang, High Tang, Late Tang |

### MCP tools

The Studio exposes these tools through `@hayba/hayba`:

- `architecture_list_cultures` / `_get_culture` / `_resolve_rules` / `_validate_culture`
- `architecture_create_culture` / `_update_culture` / `_delete_culture`
- `architecture_add_era` / `_update_era` / `_delete_era`
- `architecture_add_material` / `_update_material` / `_delete_material`
- `architecture_add_ornament` / `_update_ornament` / `_delete_ornament`
- `architecture_add_tag_axis` / `_update_tag_axis` / `_delete_tag_axis`
- `architecture_add_rule` / `_update_rule` / `_delete_rule` (rule scope: `'culture'` or `{ era: eraId }`)

Edits made via MCP propagate to the open Studio tab over SSE within ~250 ms.

### REST endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/cultures` | List all cultures |
| `POST` | `/api/cultures` | Create culture |
| `GET` | `/api/cultures/:id` | Get culture |
| `PATCH` | `/api/cultures/:id` | Update culture |
| `DELETE` | `/api/cultures/:id` | Delete culture |
| `POST` | `/api/cultures/:id/eras` | Add era |
| `PATCH` | `/api/cultures/:id/eras/:eraId` | Update era |
| `DELETE` | `/api/cultures/:id/eras/:eraId` | Delete era |
| `POST` | `/api/cultures/:id/materials` | Add material |
| `POST` | `/api/cultures/:id/ornaments` | Add ornament |
| `POST` | `/api/cultures/:id/tag-axes` | Add tag axis |
| `POST` | `/api/cultures/:id/rules` | Add rule |
| `POST` | `/api/cultures/:id/resolve` | Resolve rules for scenario |
| `GET` | `/api/sse` | SSE stream for live reload |

### v2 backlog

- In-Studio PBR texture editor.
- 3D preview of a sample building per era.
- Element-binding rewiring against the new schema.
- Typology authoring in-Studio.
- Drag-to-resize era blocks; resolved-grid live filter chips.
