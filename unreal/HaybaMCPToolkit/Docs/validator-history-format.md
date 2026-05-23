# Validator history format

The MCP server persists every validator finding it produces (post-condition
or manual run) to a JSONL file. Each line is one self-contained JSON object.

## File location

Default: `<project_root>/.scratch/validator-history.jsonl`

Override with the environment variable `HAYBA_VALIDATOR_HISTORY` set to an
absolute file path. Both the MCP server and the UE plugin's Validator panel
honour the same override, so they see the same file.

## Schema

Each line:

```json
{
  "ruleId": "pcg_zero_instances_after_execute",
  "severity": "warning",
  "message": "PCG graph executed but produced 0 instances in the world",
  "hint": "The graph ran (componentsExecuted > 0) but no HISM/ISM instances exist...",
  "refs": ["[[pcg-surface-sampler-needs-landscape]]"],
  "context": {
    "graph": "/Game/MyGraph",
    "componentsExecuted": 1,
    "instances": 0
  },
  "timestamp": "2026-05-23T01:23:45.678Z",
  "toolName": "hayba_execute_pcg_graph",
  "resolved": false
}
```

Required fields: `ruleId`, `severity`, `message`, `hint`, `timestamp`, `toolName`.

Optional fields:
- `refs: string[]` — memory slugs the finding cross-references.
- `context: object` — rule-specific payload. The UE plugin looks at:
  - `actor_label` / `actorLabel` and `actor_id` / `actorId` for the
    "Jump to actor" button.
  - `graph` (PCG asset path) for context display.
  Anything else is ignored by the panel but preserved on round-trip.
- `resolved: boolean` — `true` once the user dismisses the finding via the
  plugin UI or the `validator_resolve` MCP tool.
- `resolvedAt: string (ISO)` — set when `resolved` becomes true.

## Round-tripping

The plugin reads, edits (resolved/resolvedAt), and rewrites the file in
full when the user clicks Dismiss / Restore / Clear All. All other fields,
including unknown keys, are preserved through the round-trip.

The MCP server appends new findings to the file as they happen; the
plugin watches the parent directory and re-reads on any change to the
file (debounce via the OS file watcher, not the plugin).

## Severity colours in the panel

| severity | colour          |
|----------|-----------------|
| error    | red (1, 0.3, 0.3)   |
| warning  | yellow (1, 0.85, 0.2) |
| info     | blue (0.55, 0.7, 1) |

## Manual testing the panel

1. Run the MCP server with the validator wired in (`npm run build && npm start`).
2. From an agent, trigger a known-floppy tool call — e.g. invoke
   `hayba_execute_pcg_graph` against a graph whose Surface Sampler is bound
   to a non-landscape source. The validator should produce a
   `pcg_zero_instances_after_execute` finding and write it to the JSONL
   file.
3. Open the Hayba MCP Toolkit panel in UE → Validation tab. The new
   finding should appear within ~1s.
4. Click "Dismiss" on the row. The `resolved` field flips to `true` and
   the row disappears (unless "Include resolved" is checked).
5. Click "Clear All" to truncate the history.

## Forward compatibility

When adding new fields to a finding on the TS side, mirror them in
`SHaybaValidatorPanel.h::FHaybaValidatorFinding` and update the parser /
serialiser in `SHaybaValidatorPanel.cpp`. The plugin already preserves
unknown fields via `RawJson`, so out-of-date plugin builds will still
round-trip findings without dropping data.
