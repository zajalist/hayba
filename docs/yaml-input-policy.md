# YAML input policy

Hayba parses YAML only for CLI specs and the built-in workflow-pack manifest.
Both consumers use `src/security/bounded-yaml.ts`; adding a third direct
`js-yaml` call would create a second policy and is intentionally unsupported.

The shared policy deliberately selects js-yaml 5's YAML 1.2 `CORE_SCHEMA`.
That means legacy YAML 1.1 booleans such as `yes` and `on` and timestamps remain
strings. A leading-zero integer such as `012` is decimal 12 (rather than YAML
1.1's octal 10), and YAML 1.2's explicit `0o12` is octal 10. JSON-style `true`,
`false`, `null`, decimal numbers, arrays, and objects retain their usual types.

Aliases and merge keys are not part of Hayba's configuration language. Alias
count and total merge-key work are both limited to zero; `<<` is rejected even
though `CORE_SCHEMA` otherwise treats it as an ordinary string key. Duplicate
and complex mapping keys are rejected. Collection depth is capped at 32.

Input is also bounded before construction:

- CLI specs: 1 MiB before either the JSON or YAML parser runs
- workflow-pack manifest: 256 KiB, checked from file metadata before reading

Parser exceptions can include source excerpts. Hayba never forwards those
excerpts: callers receive a fixed input label and, when available, line/column
coordinates. This keeps malformed configuration diagnostics useful without
echoing credentials or other document content.

These choices intentionally differ from js-yaml 4's behavior: empty YAML now
fails as empty input, merge inheritance is unavailable, and complex keys no
longer stringify silently. The checked-in `packs.yaml` and existing valid CLI
spec shapes are otherwise preserved.
