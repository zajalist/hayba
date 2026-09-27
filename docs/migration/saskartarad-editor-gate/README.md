# saskartarad: editor_gate.py on Hayba leases

A proposed change to `D:/UnrealEngine/saskartarad`, kept here because that
project's editor is live and another agent works in it. Nothing in saskartarad
was edited. See [ADR-0010](../../adr/0010-multi-agent-editor-leases.md).

| File | Goes to |
| --- | --- |
| `editor_gate.py` | `Tools/GameFlow/editor_gate.py` |
| `tests/test_editor_gate.py` | `Tools/GameFlow/tests/test_editor_gate.py` |
| `editor_gate.patch` | both of the above, as one `git apply` patch against saskartarad's current files |

Install the script and its test **together**. The old test file sets no
`HB_PORT`, so against the new script it would ping the live editor on 52342
and take real leases. The new test points every run at a closed port or a fake
Hayba server.

## What changes

- `acquire` asks Hayba `ping` for `capabilities.lease_manager`. When it is
  there, `acquire` is `lease_acquire` and `release` is `lease_release`, sent with
  the envelope `owner` set to `--owner`.
  - No `--scope`: `global`, exclusive (the whole editor, as the file lock was).
  - `--scope world:<pkg> | wp-region:<pkg>:<minX>,<minY>,<maxX>,<maxY> | actor:<path> | asset:<path>`
    (repeatable) narrows it, so agents on different regions work side by side.
  - Queued requests poll with their ticket at the editor's `poll_after_s`. On
    timeout the ticket is withdrawn.
  - The lease is requested with `bind_connection: false`: the script's
    connection closes as soon as it exits.
  - The editor caps a lease at 15 minutes (`--ttl-min 30` becomes 900 s, and the
    script says so). As before, re-running `acquire` with the same owner renews
    in place, now through `lease_renew`.
- The token is printed as `HAYBA_LEASE=<token>`. `editor_gate.py token --owner X`
  prints just the token, for `export HAYBA_LEASE=$(...)`.
- `lock.json` is still written, as a mirror (`mode: "lease"`, one entry per
  holder), so `status` works without an editor. A file lock taken while the
  editor was down still blocks a lease acquire, and the other way round.
  `status` shows the editor's `lease_status` next to the mirror when the editor
  answers.
- The PIE log check is unchanged. While PIE runs, the script does not start
  queueing. It keeps polling a ticket it already holds, and a lease granted
  during PIE is used only once PIE stops (or is given back on timeout).
- No editor, or a plugin without `lease_manager`: the file lock, byte for byte
  as before. `EDITOR_GATE_MODE=file|lease` forces a backend.

Tests: `python -m pytest tests -q` here, and 22 pass. The six original tests are
kept unchanged in intent: they run against a closed port, which is also the
"editor is down" fallback.

## Passing the lease in the envelope

`owner` and `lease` are top-level envelope fields, next to `cmd`, `id` and
`params`, not inside `params`. A command that carries `lease` acts as that
lease's owner. Without either field the editor names the caller `conn:<id>`,
a new owner for every connection.

**`Tools/Look/apply_look.py`**: `python_run()` opens a connection per call and
sends no owner. Under a lease held by the gate, each call would then be a
stranger to that lease: `lease_warning` in Advisory mode, refused in Enforced
mode. Change it to one connection per client (one `HaybaClient` for the whole
run, like bpgraph's) and add both fields to every envelope:

```python
envelope = {"cmd": cmd, "id": next_id(), "params": params}
if os.environ.get("HAYBA_LEASE"):
    envelope["lease"] = os.environ["HAYBA_LEASE"]
if os.environ.get("HAYBA_AGENT_ID"):
    envelope["owner"] = os.environ["HAYBA_AGENT_ID"]
```

Keeping one connection also keeps the fallback owner (`conn:<id>`) stable for
the whole run. A `python_run` with `deadline_s` above 5 is refused unless the
caller holds an exclusive lease on the world, so pass `lease` there too.

**`Tools/GameFlow/bpgraph.mjs`** (`HaybaClient.send`) and the `py.mjs` helper
that imports the same client:

```js
constructor(port, timeoutMs = 60_000) {
  // ...
  this.lease = process.env.HAYBA_LEASE || null;
  this.owner = process.env.HAYBA_AGENT_ID || null;
}
send(cmd, params = {}) {
  const envelope = { cmd, id, params };
  if (this.lease) envelope.lease = this.lease;
  if (this.owner) envelope.owner = this.owner;
  const payload = Buffer.from(JSON.stringify(envelope), 'utf8');
  // ...
}
```

A session then reads:

```bash
python Tools/GameFlow/editor_gate.py acquire --owner L3 --scope world:/Game/Maps/Saskarta
export HAYBA_LEASE=$(python Tools/GameFlow/editor_gate.py token --owner L3)
node Tools/GameFlow/bpgraph.mjs ...        # every command acts under the lease
python Tools/Look/apply_look.py --key dusk
python Tools/GameFlow/editor_gate.py release --owner L3
```

Hayba's own Node MCP server reads `HAYBA_LEASE_TOKEN` at start-up, or uses the
`lease_*` tools directly, which renew in the background.

World Partition load/unload sequences should move from `python_run` scripts to
`editor_batch` with `wp_region_load` / `wp_region_unload` steps. The batch owns
the loader adapters and releases every region it loaded. This replaces the
"separate calls per step, save in chunks of 20" routine.
