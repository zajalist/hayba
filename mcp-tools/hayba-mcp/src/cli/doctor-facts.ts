// Gather what `doctor` reasons about. Everything impure lives here so the
// judgement in doctor.ts stays testable without a UE install or a network.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DoctorFacts } from './doctor.js';

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
    const v = (data as { plugin_version?: string; version?: string } | undefined);
    return { reachable: true, pluginVersion: v?.plugin_version ?? v?.version ?? null };
  } catch {
    return { reachable: false, pluginVersion: null };
  }
}

export async function gatherFacts(opts: {
  projectPath: string | null;
  port: number;
  here: string;
  send: (cmd: string, params: Record<string, unknown>) => Promise<unknown>;
}): Promise<DoctorFacts> {
  const pluginDir = opts.projectPath ? findPluginDir(opts.projectPath) : null;
  const probe = await probeEditor(opts.send);
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
  };
}
