# Scratch editor and lease safety

Use a disposable Unreal project under a directory named `UEScratch` for live
tool verification. Copy the plugin into that host; close its editor before a
full build. Set `HAYBA_SCRATCH_HOST_DIR` to the project directory and
`HAYBA_SCRATCH_PROJECT` to its `.uproject` file. The live ladder also accepts
`--host-dir`; it verifies that path and the editor heartbeat before connecting.

Headless automation should pass `-HaybaAutomationChild=<unique-token>` so it
does not claim a live MCP port. For an interactive scratch run, check which of
ports 52342–52350 are occupied, read the scratch editor's own
`Saved/HaybaMCP/instances/<pid>.json` heartbeat, and point clients to that
editor with `UE_TCP_PORT` and `HAYBA_AGENT_ID`. Do not infer the port from the
server fallback or drive a different editor.

Python-backed tool descriptors declare `read_only` only for verified reads.
An undeclared Python tool is treated as a write and needs the appropriate
lease. Commands that inspect or wait without mutation are classified as reads
and may run during PIE, subject to the editor's separate unsafe-state policy.
The command classification and lease tests are the source of truth when adding
or changing a tool.

Lease IDs are reusable client handles, but must not expose the session salt or
an older `token` field. A redaction marker in the generic request envelope is
treated as an absent lease ID. A marker passed directly as `editor_batch`'s
`lease_id` is an explicit redacted value and is refused. These two cases must
stay distinct when changing routing or redaction behavior.
