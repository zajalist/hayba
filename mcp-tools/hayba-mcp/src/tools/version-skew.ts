// Turn "unknown command" into "your plugin is out of date".
//
// The two halves of the install ship and update independently, so a newer
// server routinely talks to an older plugin. When it does, the failure arrives
// one command at a time as `Unknown command: foliage_scatter_paint` — which
// reads as a bug in that command, or a typo in the tool name, and sends people
// to look at the wrong thing entirely. The version gap is never mentioned,
// because nothing on the failing path knows to look.
//
// `checkProtocol` already knows how to say this well. Until now only `doctor`
// called it, so the advice existed and never reached the person hitting the
// problem — they would have had to already suspect a version gap to run the
// command that tells them about it.
//
// Pure: the caller supplies the peer's protocol version. Fetching and caching
// it lives with the executor.

import { checkProtocol, HAYBA_PROTOCOL_VERSION } from '../protocol-version.js';

/** Does this UE error mean "no handler declares that command"? */
export function isUnknownCommand(message: string): boolean {
  // Two spellings, both real: the router says "Unknown command: x" and each
  // handler says "<Domain>Handler: unknown command x" when a command routes
  // to it but it has no branch for it.
  return /unknown command/i.test(message);
}

export interface SkewExplanation {
  /** The message to show instead of the raw UE error. */
  message: string;
  /** True when a version gap explains it; false when the command is simply wrong. */
  versionGap: boolean;
}

/**
 * Reframe an unknown-command failure.
 *
 * `peerProtocol` is what the editor reported, or null if it did not say.
 *
 * When the versions agree, this deliberately does NOT invent a version story:
 * a matched pair failing on an unknown command means the command name is
 * wrong, and blaming the version there would send someone to reinstall a
 * perfectly good plugin.
 */
export function explainUnknownCommand(
  cmd: string,
  ueMessage: string,
  peerProtocol: number | null,
): SkewExplanation {
  const compat = checkProtocol(peerProtocol);

  if (compat.compatible) {
    return {
      versionGap: false,
      message:
        `${ueMessage}\n\n` +
        `The editor plugin speaks the same protocol version as this server ` +
        `(v${HAYBA_PROTOCOL_VERSION}), so this is not a version gap — "${cmd}" is not a ` +
        `command this build declares. Check the name against hayba_list_tool_categories, ` +
        `or docs/CAPABILITIES.md.`,
    };
  }

  return {
    versionGap: true,
    message:
      `"${cmd}" is not available on the connected editor, and the two halves of the ` +
      `install do not match: ${compat.advice}\n\n` +
      `Run \`hayba-cli doctor --project <your.uproject>\` for the full picture. ` +
      `The original error was: ${ueMessage}`,
  };
}
