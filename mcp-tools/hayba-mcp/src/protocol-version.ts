// The one number the two halves of the install agree to speak.
//
// The npm server and the UE plugin ship separately and version separately —
// the plugin is on 0.3.0 while this package is on 1.0.0, and neither number
// says anything about whether they can talk to each other. Comparing them
// reports skew on every healthy install, which is how `doctor` first behaved.
//
// This is different: it is not a product version. It changes ONLY when the
// wire contract changes in a way that breaks an older peer — a command
// removed or renamed, a required parameter added, a response field a caller
// depends on removed. Adding a command, adding an optional parameter, or
// adding a response field does NOT bump it, because an older peer keeps
// working.
//
// Kept in step by hand with HaybaMCPProtocol.h. Two constants rather than one
// generated from the other, because the alternative is a build-time dependency
// between an npm package and a UE plugin that are deliberately independent —
// and a mismatch here is exactly what the check is for.
export const HAYBA_PROTOCOL_VERSION = 1;

export interface ProtocolCompatibility {
  compatible: boolean;
  /** Plain-language account of what to do. Empty when compatible. */
  advice: string;
}

/**
 * Judge whether a peer's protocol version can be talked to.
 *
 * Says which side is behind, because "update Hayba" is useless when the whole
 * problem is that there are two things to update and only one of them is
 * wrong.
 */
export function checkProtocol(peerVersion: number | null): ProtocolCompatibility {
  if (peerVersion === null || !Number.isFinite(peerVersion)) {
    // Silence means a peer old enough to predate this field. That is itself a
    // mismatch, and saying so beats reporting nothing.
    return {
      compatible: false,
      advice:
        `the editor plugin did not report a protocol version, so it predates this check `
        + `(server speaks v${HAYBA_PROTOCOL_VERSION}). Update the plugin.`,
    };
  }
  if (peerVersion === HAYBA_PROTOCOL_VERSION) {
    return { compatible: true, advice: '' };
  }
  return {
    compatible: false,
    advice: peerVersion < HAYBA_PROTOCOL_VERSION
      ? `the editor plugin speaks protocol v${peerVersion}, this server speaks v${HAYBA_PROTOCOL_VERSION}. `
        + `Update the plugin — a newer server calling an older plugin fails one command at a time, `
        + `which looks like a bug in that command rather than a version gap.`
      : `the editor plugin speaks protocol v${peerVersion}, this server speaks v${HAYBA_PROTOCOL_VERSION}. `
        + `Update the npm server (npm i -g @hayba/mcp) — the plugin is ahead.`,
  };
}
