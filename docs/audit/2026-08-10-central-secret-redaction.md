# Central bounded secret redaction (#383)

## Outbound boundary inventory

One non-mutating policy now covers the Node server's actual egress paths and
the native plugin's final serialized envelope:

1. `wrapToolHandlerForStream` filters every native and deferred MCP tool return
   and thrown error, then mirrors that same already-safe value and safe params.
2. Chat `emit` filters before SSE frames enter the reconnect buffer or fan out;
   tool inputs/results stored in the final trace are safe copies.
3. Shared Express middleware wraps `res.json` for dashboard/chat and Sliver HTTP
   routes. Overlapping app/route middleware recognizes an already-wrapped
   response and does not filter twice.
4. `OperationJournal` filters before memory and disk. Replay also sanitizes and
   rewrites legacy JSONL records that contain secret material.
5. Process console methods are wrapped once before server startup. The ordinary
   logger also filters independently for library/test callers.
6. `HaybaMCPSecretRedaction::RedactFinalEnvelope` filters the native TCP
   envelope in `JsonToString`, immediately before `FJsonSerializer`; its stable
   fact lives at `_meta["hayba/security_redaction"]`.

MCP catalog resources and static files contain repository artifacts rather than
handler-owned dynamic results; binary/static response bodies are deliberately
not decoded or rewritten.

## Policy and bounds

`src/security/secret-redaction.ts` recognizes mixed-case, snake, camel, and
closed-vocabulary concatenated credential keys; bearer/JWT/provider-key text;
authorization/API-key/cookie assignments; URL userinfo; and secret query
parameters. Serialized property names are scanned by the same bounded text
policy; a sensitive name is replaced wholesale by a deterministic,
collision-safe placeholder that contains no raw substring. Categories and
counts are stable diagnostics. Values, matched text, and raw keys never appear
in metadata.

Default traversal bounds are 16 levels, 10,000 nodes, 256 array items, 256
object keys, 256 key characters, 64 KiB per ordinary string, and 1 MiB total
ordinary string text. Cycles and every exceeded budget fail closed with a
machine-readable truncation reason. Errors and mandatory recovery keys are
prioritized when an object-key budget is exhausted. Warnings are not treated as
errors or removed. Accessors are never invoked; accessor and hostile-proxy
subtrees fail closed with an `accessor` truncation fact.

Buffers and typed arrays remain byte-identical. Explicitly named base64 fields
and image/audio/blob `data` are opaque only when their value is complete
standard-base64 with ASCII alphabet and valid trailing padding. A key/type is
an encoding hint, never permission to bypass scanning malformed prose. An exact
AWS access-key id overrides opacity because that credential is also valid
base64 syntax. Secret-named keys are masked before either rule. The existing
transport response-size cap remains the allocation boundary for opaque
artifacts.

The native object selector holds at most `MaxObjectKeys` candidates while it
scans a JSON hash map. It gives mandatory error/recovery fields priority and
keeps the lexicographically stable best candidates with a bounded heap; it
never copies an overlong key in full or reserves every dropped key merely to
choose a placeholder. Thus the object-key setting bounds working memory and
collision attempts, not only the number of emitted fields.

## Invariants

- Handler-owned results are never mutated; safe payloads retain identity and
  serialized bytes.
- Filtering an already-filtered value is idempotent and does not create nested
  metadata.
- Only exact, closed-vocabulary redaction/truncation marker strings are trusted.
  Attacker prose that merely starts with or contains a marker is scanned again.
- MCP redaction facts live under `_meta["hayba/security_redaction"]`; ordinary
  JSON/SSE objects use `_security_redaction`; bounded arrays carry a final fact.
- Error and `mandatory_recovery` prose survives with only credential spans
  replaced.

The remaining acceptance step is a disposable-process smoke proving sentinels
are absent from real MCP, Tool Stream, SSE/HTTP, journal, stderr, and crash-test
artifacts. No user-owned editor process is used for that proof.
