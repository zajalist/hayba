# Production dependency reachability — 2026-08-10

Issue #380 turns the production dependency audit from a point-in-time command
into an executable, expiring policy. The machine authority is
[`production-dependency-assessments.json`](production-dependency-assessments.json).

## Outcome

Compatible updates removed every currently fixable production finding:

- `js-yaml` 4.1.1 → 4.3.1;
- `@modelcontextprotocol/sdk` 1.29.0 → 1.30.0;
- compatible transitive updates for Hono/Node Server, Axios/FormData,
  Fast-URI, BodyParser, IP Address, Undici, and ProtobufJS.

`npm audit --omit=dev --json` fell from 15 production vulnerability nodes (12
high) to four high nodes. The gate expands transitive `via` chains into five
distinct package/advisory paths so an aggregate package cannot silently inherit
another package's exception.

#377 removed the reachable direct `adm-zip` path and the direct dependency.
External asset archives now use the bounded streaming extractor, and an `rg`
audit finds zero runtime `adm-zip`/`AdmZip`/`extractAllTo` references. The
package still appears transitively under ONNX Runtime, so the production audit
correctly remains non-zero rather than hiding it.

The other paths come from the optional Transformers text-embedding backend:

- ONNX Runtime's residual `adm-zip` path is installation-only. Hayba never
  invokes it at runtime; audit jobs install with scripts disabled and the
  lockfile pins integrity.
- Sharp's vulnerable image/SVG parser is outside Hayba's text-only
  `feature-extraction` call path. The backend accepts only strings.

Those decisions expire on 2026-09-09. Expiry fails CI even when the inventory
file is otherwise unchanged.

## Executable policy

Run from the repository root:

```powershell
npm run audit:production
```

The script itself launches `npm audit --omit=dev --json`; callers cannot
accidentally broaden it to a dev audit or weaken it with `--audit-level`. Raw
npm JSON is parsed in memory and never emitted. Output contains only stable
policy codes, package names, GHSA IDs, counts, and no dependency paths, request
data, environment, registry credentials, or raw advisory prose.

The policy fails on:

- any new/unassessed critical or high package/advisory path;
- an unresolved/cyclic npm `via` chain;
- malformed, duplicate, future-dated, expired, or stale assessments;
- severity or installed-version drift.

Moderate/low findings are reported as non-blocking warnings. The current report
contains none; every remaining current finding has an assessed high record.
Dev-only advisories do not enter this lane because the executable collector
always supplies `--omit=dev`.

CI runs the gate on every push/PR. A weekly scheduled workflow uses the same
script and creates or updates exactly one issue named
`[security] Production dependency audit drift`; it closes that issue when the
lane returns green.

## Reproducibility and install ordering

Dependency installation mutates the shared root `node_modules`, so install,
typecheck, test, and audit must be serialized. A transient typecheck executed
while npm was replacing SDK files observed missing declarations; the identical
typecheck passed after installation completed. CI naturally serializes these
steps, and local evidence for this change was collected only after the final
install process exited.
