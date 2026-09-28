# @hayba/brain-protocol

The wire protocol between the Hayba sidecar (`@hayba/mcp`) and the hosted
Hayba Pro service: Zod schemas and TypeScript types for every WebSocket frame
(`hello`, `welcome`, `resume`, `turn`, `tool_call`, `tool_result`, `event`,
`done`, ...), the activity-event vocabulary streamed to the editor panel, and
the argument hash used to bind local approvals to one exact tool call.

```ts
import { parseFrame, PROTOCOL_VERSION } from '@hayba/brain-protocol';

const parsed = parseFrame(raw);
if (parsed.ok) handle(parsed.frame); // malformed frames are rejected, never trusted
```

`fixtures/valid` and `fixtures/invalid` hold example frames the schemas are
tested against.

## Versioning

Every frame carries `v`, the protocol version (`PROTOCOL_VERSION`).

- **Breaking frame changes** bump `PROTOCOL_VERSION` and the package's major
  version. The schemas are strict, so this means any change a peer on the
  previous version would reject or misread: a new, removed or renamed frame,
  field or event type, a changed field type or meaning, or tighter validation.
- Changes that leave the wire format untouched (helpers, type exports,
  documentation) keep `PROTOCOL_VERSION` and bump the package's minor or patch
  version.

## License

MIT
