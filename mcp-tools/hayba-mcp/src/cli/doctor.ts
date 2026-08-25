import { checkProtocol, HAYBA_PROTOCOL_VERSION } from '../protocol-version.js';

// `hayba-cli doctor` — answer "why isn't this working" before anyone has to ask.
//
// Install is two artifacts that update independently: this npm server, and a
// compiled UE editor plugin that has to reach a project's Plugins/ folder. npm
// alone gives you a server connected to nothing, and the failure looks like
// "unknown command" or a silent timeout rather than "the plugin is not there".
//
// So this checks the four things that actually break, and each check says what
// to DO, not just what is wrong. A diagnosis with no next step is a slower way
// of saying it failed.
//
// The checks are pure functions of facts gathered elsewhere, so the judgement
// is testable without a UE install, an editor, or a network.

export type CheckStatus = 'ok' | 'problem' | 'unknown';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it. Present whenever status is not 'ok'. */
  fix?: string;
}

export interface DoctorFacts {
  /** Absolute path to the .uproject, when one was given or found. */
  projectPath: string | null;
  /** Plugin directory found inside the project, if any. */
  pluginDir: string | null;
  /** Plugin .uplugin VersionName, when readable. */
  pluginVersion: string | null;
  /** Dependencies the plugin's own .uplugin declares. Read, not assumed --
   *  an earlier version of this file listed five from memory and got three of
   *  them wrong, then reported a working install as broken. */
  declaredDependencies: string[];
  /** Plugins the .uproject enables explicitly. Informational only: UE enables
   *  a plugin's declared dependencies itself, so absence here proves nothing. */
  enabledPlugins: string[];
  /** Whether the editor answered on the MCP port. */
  editorReachable: boolean;
  /** Port that was probed. */
  port: number;
  /** Version this npm package reports. */
  serverVersion: string;
  /** Plugin version the editor reported over the wire, when it answered. */
  reportedPluginVersion: string | null;
  /** Protocol version the editor reported. Null when it is old enough not to
   *  have the field, which is itself a mismatch. */
  reportedProtocolVersion: number | null;
}

function checkPlugin(f: DoctorFacts): CheckResult {
  if (!f.projectPath) {
    return {
      name: 'plugin installed',
      status: 'unknown',
      detail: 'no .uproject given, so there is no project to look in',
      fix: 'run: hayba-cli doctor --project <path to your .uproject>',
    };
  }
  if (!f.pluginDir) {
    return {
      name: 'plugin installed',
      status: 'problem',
      detail: `no HaybaMCPToolkit under ${f.projectPath}`,
      // The single most common cause: npm installed, plugin never copied.
      fix: 'the npm package is only half the install — unpack the plugin release zip for your engine version into <project>/Plugins/, then restart the editor',
    };
  }
  return {
    name: 'plugin installed',
    status: 'ok',
    detail: `${f.pluginDir}${f.pluginVersion ? ` (v${f.pluginVersion})` : ''}`,
  };
}

function checkDependencies(f: DoctorFacts): CheckResult {
  const declared = f.declaredDependencies;

  // UE refuses to load a plugin whose declared dependencies are unavailable.
  // So a reachable editor is PROOF the dependencies resolved -- a stronger
  // signal than reading the .uproject, which only lists plugins somebody
  // toggled by hand and says nothing about ones enabled transitively.
  if (f.editorReachable) {
    return {
      name: 'plugin dependencies enabled',
      status: 'ok',
      detail: declared.length > 0
        ? `${declared.length} declared (${declared.join(', ')}); the plugin loaded, so they resolved`
        : 'the plugin declares none',
    };
  }

  if (!f.pluginDir) {
    return {
      name: 'plugin dependencies enabled',
      status: 'unknown',
      detail: 'not checked — the plugin itself was not found',
    };
  }

  return {
    name: 'plugin dependencies enabled',
    status: 'unknown',
    detail: `not checked — the editor is not running, and the .uproject alone cannot tell us${
      declared.length ? ` (declared: ${declared.join(', ')})` : ''
    }`,
    fix: 'start the editor; if a dependency is missing the plugin will fail to load and say which',
  };
}

function checkEditor(f: DoctorFacts): CheckResult {
  if (f.editorReachable) {
    return { name: 'editor reachable', status: 'ok', detail: `answered on :${f.port}` };
  }
  return {
    name: 'editor reachable',
    status: 'problem',
    detail: `nothing answered on :${f.port}`,
    fix: f.pluginDir
      ? 'start the Unreal editor for this project — the plugin opens the port at startup, so a closed editor means no commands at all'
      : 'install the plugin first; there is nothing to open the port yet',
  };
}

function checkVersions(f: DoctorFacts): CheckResult {
  if (!f.editorReachable) {
    return {
      name: 'versions',
      status: 'unknown',
      detail: 'not checked — the editor is not running',
    };
  }

  // Judged on the PROTOCOL version, never on the two product versions: those
  // have never shared a scheme (plugin 0.3.0, server 1.0.0), so comparing them
  // flags every healthy install. The protocol number exists precisely so this
  // question has an answer.
  const compat = checkProtocol(f.reportedProtocolVersion);
  const products = `server ${f.serverVersion}, plugin ${f.reportedPluginVersion ?? 'unreported'}`;

  if (compat.compatible) {
    return {
      name: 'versions',
      status: 'ok',
      detail: `protocol v${HAYBA_PROTOCOL_VERSION} on both (${products})`,
    };
  }
  return {
    name: 'versions',
    status: 'problem',
    detail: products,
    fix: compat.advice,
  };
}

export function diagnose(f: DoctorFacts): CheckResult[] {
  return [checkPlugin(f), checkDependencies(f), checkEditor(f), checkVersions(f)];
}

/** Exit code: 0 when nothing is broken. `unknown` is not failure — it means a
 *  check could not run, usually because an earlier one already failed. */
export function exitCodeFor(results: readonly CheckResult[]): number {
  return results.some((r) => r.status === 'problem') ? 1 : 0;
}

const MARK: Record<CheckStatus, string> = { ok: 'ok  ', problem: 'FAIL', unknown: '??  ' };

export function formatReport(results: readonly CheckResult[]): string {
  const lines = ['hayba doctor', ''];
  for (const r of results) {
    lines.push(`  [${MARK[r.status]}] ${r.name}: ${r.detail}`);
    if (r.fix) lines.push(`         → ${r.fix}`);
  }
  lines.push('');
  lines.push(
    results.some((r) => r.status === 'problem')
      ? 'Something above needs fixing before the tools will work.'
      : 'Everything checked out.',
  );
  return lines.join('\n');
}
