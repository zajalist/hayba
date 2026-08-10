# Principal-scoped idempotency ledger (#378)

## Boundary

`hayba_invoke.idempotency_key` is gateway metadata. It is not part of the
target tool's `args` object and is never forwarded to a TypeScript or Unreal
handler. A keyed call is admitted only when the MCP SDK supplies validated
`authInfo.clientId`; stdio and other unauthenticated transports fail closed and
point to #379. Session IDs, request IDs, access-token text, and caller arguments
are never treated as identity.

The slot is a length-prefixed SHA-256 digest of authenticated principal, logical
tool name, and key. Its request fingerprint is a separate digest of tool name
and canonical validated arguments, including the selected dispatch route. The
ledger retains neither the raw key nor raw parameters and exposes only aggregate
diagnostics. A conflict can expose a 64-bit prefix of the one-way slot digest for
correlation; it never exposes either fingerprint or the prior request.

## State and replay rules

- `in_flight`: identical retries join one Promise. Changed arguments fail with a
  stable conflict. In-flight entries are never evicted.
- `completed`: replay is allowed only for advisory state `success`, or for a
  quiet response with explicit `readback_verified:true`, `verified:true`,
  `compiled_clean:true`, or `saved:true` evidence and no contradictory failure.
- `success_needs_verification`, partial/refused/retryable/unknown/suspect/fatal
  states, bare `ok:true`, `saved:false`, thrown failures, and uncloneable
  receipts are removed instead of cached.
- Conventional machine contradictions also veto quiet replay: finite
  `failed>0`, non-empty `error`/`errors`, `save_verified:false`, `valid:false`,
  or `dirty:true` alongside otherwise-positive save/readback evidence. Warnings
  remain advisory and do not veto a verified receipt.
- Cancelling one MCP waiter does not cancel or remove the shared mutation. A
  retry with the same identity continues to join it.

The ledger is deliberately bounded: 128 distinct in-flight slots, 1,024
completed receipts, and a 24-hour completed TTL. Capacity pressure may evict
only completed receipts. At the in-flight limit, a different slot fails closed;
an identical slot can still join.

## Durability and acceptance boundary

Receipts have `scope:"process_lifetime"`. They survive an authenticated client
disconnect/reconnect while the same MCP server process remains alive, but not an
MCP server restart. This implementation does not claim a durable journal or a
stable authenticated identity for stdio; #379 owns that transport boundary.

Source-only verification covers simultaneous dedupe, replay, principal
isolation, canonicalization, conflicts, expiry/capacity, cancellation, failure
retry, secret-safe diagnostics, MCP envelopes, and every #370 advisory state.
The disposable-editor mutation proof remains a coordinated acceptance step; no
editor was touched while the user-owned process held the MCP port.
