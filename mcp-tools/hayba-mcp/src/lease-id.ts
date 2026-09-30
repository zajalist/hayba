// Lease ids as the editor issues them (docs/adr/0010, "Lease ids"):
// ls_<seq>_<mac12> for a lease, lq_<seq>_<mac12> for a queued ticket. Only
// [a-z0-9_], so neither redaction layer can mistake one for a secret. Kept in
// its own module so tcp-client can apply the rule without importing the keeper.

export const LEASE_ID_PATTERN = /^ls_[a-z0-9_]+$/;

const REDACTION_MARKER_PREFIX = '[REDACTED:';

/** A lease_id this server can renew, release and send as the envelope lease. */
export function isUsableLeaseId(id: unknown): id is string {
  return typeof id === 'string' && LEASE_ID_PATTERN.test(id);
}

/** A value a redaction layer wrote in place of a secret-shaped one. */
export function isRedactionMarker(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(REDACTION_MARKER_PREFIX);
}
