// Gather what `doctor` reasons about. Everything impure lives here so the
// judgement in doctor.ts stays testable without a UE install or a network.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DoctorFacts } from './doctor.js';
import { CLIENT_SPECS, entryPointsAtHayba } from './configure.js';
import { configPathFor } from './configure-facts.js';

/** Find HaybaMCPToolkit under <project>/Plugins, at any nesting depth of one. */
export function findPluginDir(projectPath: string): string | null {
  const pluginsRoot = join(dirname(projectPath), 'Plugins');
  if (!existsSync(pluginsRoot)) return null;

  const direct = join(pluginsRoot, 'HaybaMCPToolkit');
  if (existsSync(direct)) return direct;

  // Teams commonly nest vendored plugins one level down.
  try {
    for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nested = join(pluginsRoot, entry.name, 'HaybaMCPToolkit');
      if (existsSync(nested)) return nested;
    }
  } catch { /* unreadable Plugins dir is the same as no plugin */ }
  return null;
}

/** Dependencies the plugin declares. UE enables these itself, so this is the
 *  list that matters -- not whatever the .uproject happens to name. */
export function readDeclaredDependencies(pluginDir: string): string[] {
  const uplugin = join(pluginDir, 'HaybaMCPToolkit.uplugin');
  if (!existsSync(uplugin)) return [];
  try {
    const j = JSON.parse(readFileSync(uplugin, 'utf8')) as { Plugins?: Array<{ Name?: string }> };
    return (j.Plugins ?? []).map((x) => x.Name).filter((n): n is string => typeof n === 'string');
  } catch { return []; }
}

export function readPluginVersion(pluginDir: string): string | null {
  const uplugin = join(pluginDir, 'HaybaMCPToolkit.uplugin');
  if (!existsSync(uplugin)) return null;
  try {
    const j = JSON.parse(readFileSync(uplugin, 'utf8')) as { VersionName?: string };
    return j.VersionName ?? null;
  } catch { return null; }
}

/** Plugin names the .uproject has enabled. An absent Plugins array means the
 *  project enables nothing explicitly, which is not the same as "unreadable". */
export function readEnabledPlugins(projectPath: string): string[] {
  try {
    const j = JSON.parse(readFileSync(projectPath, 'utf8')) as {
      Plugins?: Array<{ Name?: string; Enabled?: boolean }>;
    };
    return (j.Plugins ?? [])
      .filter((p) => p.Enabled !== false && typeof p.Name === 'string')
      .map((p) => p.Name as string);
  } catch { return []; }
}

/** The version this package reports, read from its own package.json. */
export function readServerVersion(here: string): string {
  // Walk up: dist/cli/ in a published install, src/cli/ in the repo.
  let dir = here;
  for (let i = 0; i < 5; i++) {
    const p = join(dir, 'package.json');
    if (existsSync(p)) {
      try {
        const j = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; version?: string };
        if (j.name?.includes('hayba')) return j.version ?? 'unknown';
      } catch { /* keep walking */ }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return 'unknown';
}

export interface ProbeResult {
  reachable: boolean;
  pluginVersion: string | null;
  protocolVersion: number | null;
}

/**
 * Ask the editor whether it is there, and what plugin version it is running.
 *
 * Deliberately tolerant: any answer at all means reachable. A doctor that
 * reported "unreachable" because a version field was missing would be blaming
 * the wrong thing.
 */
export async function probeEditor(
  send: (cmd: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<ProbeResult> {
  try {
    const data = await send('editor_get_state', {});
    const v = (data as { plugin_version?: string; version?: string; protocol_version?: number } | undefined);
    return {
      reachable: true,
      pluginVersion: v?.plugin_version ?? v?.version ?? null,
      protocolVersion: typeof v?.protocol_version === 'number' ? v.protocol_version : null,
    };
  } catch {
    return { reachable: false, pluginVersion: null, protocolVersion: null };
  }
}

export async function gatherFacts(opts: {
  projectPath: string | null;
  port: number;
  here: string;
  send: (cmd: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Where to look for client configs. Defaults to the cwd, which is where a
   *  user running `doctor` on their project almost always is. */
  projectRoot?: string;
}): Promise<DoctorFacts> {
  const pluginDir = opts.projectPath ? findPluginDir(opts.projectPath) : null;
  const probe = await probeEditor(opts.send);
  const clientSearchRoot = resolve(opts.projectRoot ?? process.cwd());
  const clients = findConfiguredClients(clientSearchRoot);
  return {
    projectPath: opts.projectPath,
    pluginDir,
    pluginVersion: pluginDir ? readPluginVersion(pluginDir) : null,
    declaredDependencies: pluginDir ? readDeclaredDependencies(pluginDir) : [],
    enabledPlugins: opts.projectPath ? readEnabledPlugins(opts.projectPath) : [],
    editorReachable: probe.reachable,
    port: opts.port,
    serverVersion: readServerVersion(opts.here),
    reportedPluginVersion: probe.pluginVersion,
    reportedProtocolVersion: probe.protocolVersion,
    configuredClients: clients.configured,
    detectedClients: clients.detected,
    clientSearchRoot,
  };
}

/** Which detected clients already name this server in their config. */
export function findConfiguredClients(projectRoot: string): {
  configured: string[];
  detected: string[];
} {
  // Imported lazily-ish at module scope is fine here -- both are pure-ish and
  // cheap, and doctor must keep working when none of this exists.
  const detected: string[] = [];
  const configured: string[] = [];
  try {
    for (const spec of CLIENT_SPECS) {
      const path = configPathFor(spec, projectRoot);
      if (!existsSync(path)) continue;
      detected.push(spec.id);
      try {
        const j = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        const map = j[spec.serversKey];
        if (typeof map === 'object' && map !== null) {
          // By the path it launches, not by the entry's name. Older docs said
          // `hayba-toolkit`; a name check would call those installs broken.
          const entries = Object.entries(map as Record<string, unknown>);
          const hit = entries.find(([, v]) => entryPointsAtHayba(v));
          if (hit) configured.push(`${spec.id} (as "${hit[0]}")`);
        }
      } catch {
        // A config we cannot parse is a config we cannot vouch for. It counts
        // as detected but not configured, which is the honest answer.
      }
    }
  } catch { /* never let diagnosis fail because diagnosis failed */ }
  return { configured, detected };
}
