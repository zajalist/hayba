// Write the MCP server entry into an editor's config, instead of asking a
// user to hand-edit JSON with an absolute path in it.
//
// Hand-editing that JSON is the single biggest onboarding failure: the path is
// absolute, machine-specific, and wrong in a way that produces no error --
// the client simply lists no tools, and the user has nothing to search for.
//
// Everything here is PURE. It takes the config file's current text and returns
// the text that should replace it, plus a verdict. Reading and writing lives
// in configure-facts.ts, so every branch below is testable without touching a
// real machine's config -- including the branches that must refuse to write.

/** Clients we know how to configure. */
export type ClientId = 'claude-code' | 'claude-desktop' | 'cursor' | 'vscode';

export interface ServerEntry {
  command: string;
  args: string[];
}

export interface ClientSpec {
  id: ClientId;
  label: string;
  /**
   * The JSON key holding the server map. VS Code uses `servers`; the others
   * use `mcpServers`. Getting this wrong writes a well-formed file that the
   * client ignores completely -- the exact silent failure this command exists
   * to remove -- so it is data on the spec, never a default.
   */
  serversKey: 'mcpServers' | 'servers';
  /** VS Code wants an explicit transport; the others infer stdio. */
  needsExplicitStdio: boolean;
  /** Config location relative to a project root, or null if user-scoped only. */
  projectRelativePath: string | null;
}

export const CLIENT_SPECS: readonly ClientSpec[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    serversKey: 'mcpServers',
    needsExplicitStdio: false,
    projectRelativePath: '.mcp.json',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    serversKey: 'mcpServers',
    needsExplicitStdio: false,
    projectRelativePath: '.cursor/mcp.json',
  },
  {
    id: 'vscode',
    label: 'VS Code',
    serversKey: 'servers',
    needsExplicitStdio: true,
    projectRelativePath: '.vscode/mcp.json',
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    serversKey: 'mcpServers',
    needsExplicitStdio: false,
    projectRelativePath: null, // user-scoped; see configure-facts
  },
] as const;

/**
 * The entry name we write.
 *
 * Older docs used `hayba-toolkit`, so an install that followed them has a
 * working server under a different key. Detection must NOT key off this name
 * -- see {@link entryPointsAtHayba} -- or doctor reports a perfectly good
 * install as unconfigured, which is precisely the false alarm this whole
 * feature exists to remove.
 */
export const CANONICAL_SERVER_NAME = 'hayba';

/** Names we have historically written or documented. */
export const KNOWN_SERVER_NAMES = ['hayba', 'hayba-toolkit'] as const;

/**
 * Does this config entry launch *our* server, whatever it is called?
 *
 * Keyed on the path it runs, because that is the thing that makes it ours.
 * A user is free to name the entry anything.
 */
export function entryPointsAtHayba(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const args = (entry as { args?: unknown }).args;
  if (!Array.isArray(args)) return false;
  return args.some(
    (a) =>
      typeof a === 'string' &&
      /hayba[-_]?mcp[\\/](dist[\\/])?index\.(js|ts)$/i.test(a.replace(/\\/g, '/')),
  );
}

export type Verdict =
  /** No entry by that name; we added one. */
  | 'added'
  /** An entry exists and already matches what we would write. */
  | 'already-current'
  /** An entry exists and differs. We do NOT overwrite without being told to. */
  | 'differs'
  /** Our server is already configured, under a different entry name. */
  | 'exists-under-other-name'
  /** The file exists but is not JSON we can safely rewrite. */
  | 'unparsable';

export interface ConfigPlan {
  verdict: Verdict;
  /** The text to write. Absent when there is nothing to do, or nothing safe to do. */
  nextText?: string;
  /** What is already there, when the verdict is `differs`. */
  existing?: unknown;
  /** The name it is configured under, for `exists-under-other-name`. */
  foundAs?: string;
  /** Why we refused, when we refused. */
  reason?: string;
}

/** The entry we would write for this client. */
export function buildEntry(spec: ClientSpec, entry: ServerEntry): Record<string, unknown> {
  const built: Record<string, unknown> = {
    command: entry.command,
    args: [...entry.args],
  };
  if (spec.needsExplicitStdio) built.type = 'stdio';
  return built;
}

function sameEntry(a: unknown, b: Record<string, unknown>): boolean {
  if (typeof a !== 'object' || a === null) return false;
  const x = a as Record<string, unknown>;
  if (x.command !== b.command) return false;
  if (b.type !== undefined && x.type !== b.type) return false;
  const xa = Array.isArray(x.args) ? x.args : null;
  const ba = b.args as unknown[];
  if (!xa || xa.length !== ba.length) return false;
  return xa.every((v, i) => v === ba[i]);
}

/**
 * Decide what to write.
 *
 * `currentText` is the file's existing content, or null when the file does not
 * exist. The returned text preserves every key we did not touch: a client
 * config is the user's file and usually holds other servers, so this merges
 * into it and never authors a replacement from scratch.
 */
export function planConfigChange(
  currentText: string | null,
  spec: ClientSpec,
  serverName: string,
  entry: ServerEntry,
): ConfigPlan {
  const desired = buildEntry(spec, entry);

  let root: Record<string, unknown>;
  if (currentText === null || currentText.trim() === '') {
    root = {};
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(currentText);
    } catch {
      // Refusing is the whole point. A config with a trailing comma or a
      // comment is still a config someone depends on; rewriting it from our
      // own model would silently drop whatever we failed to understand.
      return {
        verdict: 'unparsable',
        reason:
          'the existing config is not valid JSON — refusing to rewrite it, ' +
          'because doing so would discard anything in it we could not parse',
      };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        verdict: 'unparsable',
        reason: 'the existing config is valid JSON but not an object',
      };
    }
    root = parsed as Record<string, unknown>;
  }

  const rawMap = root[spec.serversKey];
  const servers: Record<string, unknown> =
    typeof rawMap === 'object' && rawMap !== null && !Array.isArray(rawMap)
      ? { ...(rawMap as Record<string, unknown>) }
      : {};

  const existing = servers[serverName];
  if (existing !== undefined) {
    if (sameEntry(existing, desired)) return { verdict: 'already-current' };
    return {
      verdict: 'differs',
      existing,
      reason:
        `"${serverName}" is already configured for ${spec.label} with different ` +
        'settings — not overwriting it without --force',
    };
  }

  // No entry by our name -- but the server may already be configured under a
  // different one. Older docs said `hayba-toolkit`, and a user may have picked
  // their own. Adding ours anyway would leave two entries launching the same
  // process: the client starts both, the tool list is duplicated, and nothing
  // reports an error.
  const otherName = Object.entries(servers).find(([, v]) => entryPointsAtHayba(v))?.[0];
  if (otherName !== undefined) {
    return {
      verdict: 'exists-under-other-name',
      foundAs: otherName,
      reason:
        `${spec.label} already launches this server as "${otherName}" — not adding a ` +
        `second entry, which would start it twice. Rename it to "${serverName}" if you ` +
        'want the canonical name, or leave it as is; both work.',
    };
  }

  servers[serverName] = desired;
  const next = { ...root, [spec.serversKey]: servers };
  return { verdict: 'added', nextText: `${JSON.stringify(next, null, 2)}\n` };
}

/** Force-write variant: same merge, but an existing entry is replaced. */
export function planConfigOverwrite(
  currentText: string | null,
  spec: ClientSpec,
  serverName: string,
  entry: ServerEntry,
): ConfigPlan {
  const plan = planConfigChange(currentText, spec, serverName, entry);
  if (plan.verdict !== 'differs') return plan;

  // Re-run the merge with the old entry removed. Parsing succeeded on the
  // first pass, so this cannot throw.
  const root = JSON.parse(currentText as string) as Record<string, unknown>;
  const rawMap = root[spec.serversKey];
  const servers =
    typeof rawMap === 'object' && rawMap !== null && !Array.isArray(rawMap)
      ? { ...(rawMap as Record<string, unknown>) }
      : {};
  servers[serverName] = buildEntry(spec, entry);
  const next = { ...root, [spec.serversKey]: servers };
  return { verdict: 'added', nextText: `${JSON.stringify(next, null, 2)}\n` };
}
