import { execFile } from 'node:child_process';
import { ensureConnected } from '../tcp-client.js';
import { getCachedSidecarHealth, pingSidecar } from './visual/sidecar-client.js';

/**
 * The three Unreal-side process images relevant to "is the editor up, and
 * which flavor". `UnrealEditor.exe` is the GUI editor an author expects.
 * `UnrealEditor-Cmd.exe` is the headless variant used by automation/CI runs —
 * it opens the same MCP port and answers pings identically, so a stray one
 * left over from a prior run is indistinguishable from the GUI editor unless
 * something names it. `CrashReportClientEditor.exe` never holds the MCP port
 * but its presence after a crash can itself block the next launch.
 */
export const UE_PROCESS_NAMES = [
  'UnrealEditor.exe',
  'UnrealEditor-Cmd.exe',
  'CrashReportClientEditor.exe',
] as const;
export type UeProcessName = (typeof UE_PROCESS_NAMES)[number];

export interface UeProcessInfo {
  name: UeProcessName;
  pid: number;
}

export interface UeProcessIdentity {
  gui: UeProcessInfo[];
  headless: UeProcessInfo[];
  crash_reporter: UeProcessInfo[];
}

/** Injectable process-list source. Returns null when detection itself failed
 *  (tool unavailable) — distinct from an empty array (checked, found none). */
export type ProcessLister = () => Promise<UeProcessInfo[] | null>;

/** Parse `tasklist /FO CSV /NH` output into UE process rows. Exported so tests
 *  can exercise the real parser against captured tasklist output without
 *  shelling out. Unknown image names are dropped. */
export function parseTasklistCsv(csv: string): UeProcessInfo[] {
  const known = new Set<string>(UE_PROCESS_NAMES);
  const out: UeProcessInfo[] = [];
  for (const rawLine of csv.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // CSV row: "ImageName","PID","SessionName","Session#","MemUsage"
    const fields = line.split('","').map((f) => f.replace(/^"|"$/g, ''));
    const [name, pidStr] = fields;
    if (name && known.has(name)) {
      const pid = Number.parseInt(pidStr, 10);
      if (Number.isFinite(pid)) out.push({ name: name as UeProcessName, pid });
    }
  }
  return out;
}

/** Parse `ps -eo pid,comm` output (POSIX) into UE process rows. */
export function parsePsOutput(text: string): UeProcessInfo[] {
  const known = new Set<string>(UE_PROCESS_NAMES);
  const out: UeProcessInfo[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const comm = match[2].trim();
    // POSIX process names are typically unsuffixed; match either form.
    const name = UE_PROCESS_NAMES.find((n) => comm === n || comm === n.replace(/\.exe$/, ''));
    if (name && Number.isFinite(pid)) out.push({ name, pid });
  }
  return out;
}

/** Real (shelling-out) process lister. Cross-platform, short timeout, never
 *  throws — resolves null when detection itself fails. */
const realListUeProcesses: ProcessLister = () => {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'tasklist' : 'ps';
  const args = isWin ? ['/FO', 'CSV', '/NH'] : ['-eo', 'pid,comm'];
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 2000, windowsHide: true }, (err, stdout) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve(null);
        if (err && !stdout) return resolve(null);
        resolve(isWin ? parseTasklistCsv(stdout || '') : parsePsOutput(stdout || ''));
      });
    } catch {
      resolve(null);
    }
  });
};

export function classifyUeProcesses(processes: UeProcessInfo[]): UeProcessIdentity {
  return {
    gui: processes.filter((p) => p.name === 'UnrealEditor.exe'),
    headless: processes.filter((p) => p.name === 'UnrealEditor-Cmd.exe'),
    crash_reporter: processes.filter((p) => p.name === 'CrashReportClientEditor.exe'),
  };
}

function describe(procs: UeProcessInfo[], label: string): string {
  const pids = procs.map((p) => p.pid).join(', ');
  return `${label} (PID ${pids})`;
}

/** Human-readable identity summary, e.g. "GUI UnrealEditor.exe (PID 1234)",
 *  "headless UnrealEditor-Cmd.exe (PID 5678) + GUI UnrealEditor.exe (PID 1234)",
 *  or "none detected". Always names process flavor + PID, never a bare bool. */
export function describeProcessIdentity(id: UeProcessIdentity): string {
  const parts: string[] = [];
  if (id.gui.length) parts.push(describe(id.gui, 'GUI UnrealEditor.exe'));
  if (id.headless.length) parts.push(describe(id.headless, 'headless UnrealEditor-Cmd.exe'));
  if (id.crash_reporter.length) parts.push(describe(id.crash_reporter, 'CrashReportClientEditor.exe'));
  return parts.length ? parts.join(' + ') : 'none detected';
}

/**
 * Actionable diagnostic naming exactly what was found and whether it matches
 * what a caller expecting a GUI editor should see. `connected` reflects
 * whether the MCP ping actually succeeded — a headless process can be the one
 * answering it, which is precisely the "process nobody thought was running"
 * failure mode from issue #342.
 */
export function buildProcessDiagnostic(id: UeProcessIdentity, connected: boolean): string | undefined {
  const hasGui = id.gui.length > 0;
  const hasHeadless = id.headless.length > 0;
  const hasCrash = id.crash_reporter.length > 0;
  const hasAny = hasGui || hasHeadless || hasCrash;

  if (connected) {
    if (hasHeadless && !hasGui) {
      return (
        `Connected, but the process answering the MCP port is a headless ${describe(id.headless, 'UnrealEditor-Cmd.exe')} ` +
        `— if you expected a GUI editor, this is likely a stray automation run holding the port instead. ` +
        `Kill it (taskkill /PID ${id.headless[0].pid} /F) and launch the GUI editor.`
      );
    }
    if (hasHeadless && hasGui) {
      return (
        `Connected, but both a GUI ${describe(id.gui, 'UnrealEditor.exe')} and a headless ${describe(id.headless, 'UnrealEditor-Cmd.exe')} ` +
        `are running — cannot tell from here which one answered the MCP port. If you only expected the GUI editor, the headless ` +
        `process (PID ${id.headless[0].pid}) is probably a leftover automation run; consider killing it to remove the ambiguity.`
      );
    }
    return undefined; // GUI-only (or undetermined) and connected — nothing to flag.
  }

  // Not connected.
  if (hasHeadless) {
    return (
      `Not connected, but a headless ${describe(id.headless, 'UnrealEditor-Cmd.exe')} is running — it may be holding the MCP ` +
      `port or otherwise blocking a GUI editor from starting (this looks exactly like a slow boot). ` +
      `Kill it (taskkill /PID ${id.headless[0].pid} /F) if you expected a GUI editor.`
    );
  }
  if (hasGui) {
    return (
      `Not connected, but a GUI ${describe(id.gui, 'UnrealEditor.exe')} is running — the plugin TCP port is closed ` +
      `(HaybaMCPToolkit likely failed to load: check the editor log for a module load error / missing dependency, ` +
      `or the editor is still booting / shutting down).`
    );
  }
  if (hasCrash) {
    return (
      `Not connected. No editor process, but ${describe(id.crash_reporter, 'CrashReportClientEditor.exe')} is running ` +
      `— it does not hold the MCP port itself, but can block the next editor launch until it exits.`
    );
  }
  if (!hasAny) {
    return 'No UnrealEditor process found — launch the editor with the HaybaMCPToolkit plugin enabled.';
  }
  return undefined;
}

export interface UeStatus {
  connected: boolean;
  error?: string;
  visual_embeddings_available: boolean;
  active_models: string[];
  sidecar_url?: string;
  sidecar_error?: string;
  /** Legacy field, kept for back-compat: true when a GUI UnrealEditor.exe was
   *  detected. undefined when detection itself failed. */
  editor_process_detected?: boolean;
  /** Full breakdown by process flavor, each with PID(s). */
  ue_processes?: UeProcessIdentity;
  /** Human-readable "what did we find" summary — always names flavor + PID. */
  process_identity?: string;
  [key: string]: unknown;
}

export interface CheckUeStatusOpts {
  /** Fired exactly once, the first time a poll succeeds in this process. */
  onConnected?: () => void | Promise<void>;
  /** Test/injection seam: overrides the real (shelling-out) process lister. */
  listProcesses?: ProcessLister;
}

let connectedLatch = false;

/** Test-only: reset the once-only connected latch. */
export function __resetConnectedLatch(): void { connectedLatch = false; }

async function detectIdentity(listProcesses: ProcessLister): Promise<{
  identity: UeProcessIdentity | undefined;
  guiDetected: boolean | undefined;
}> {
  const processes = await listProcesses();
  if (processes === null) return { identity: undefined, guiDetected: undefined };
  const identity = classifyUeProcesses(processes);
  return { identity, guiDetected: identity.gui.length > 0 };
}

export async function checkUeStatus(opts: CheckUeStatusOpts = {}): Promise<UeStatus> {
  const listProcesses = opts.listProcesses ?? realListUeProcesses;

  // Sidecar — prefer cached snapshot (filled at startup); refresh on demand if
  // we've never probed. Don't block UE status on sidecar latency.
  let sidecar = getCachedSidecarHealth();
  if (!sidecar) {
    sidecar = await pingSidecar();
  }

  const sidecarFields = {
    visual_embeddings_available: sidecar.available,
    active_models: sidecar.active_models,
    sidecar_url: sidecar.url,
    sidecar_error: sidecar.error,
  };

  try {
    const client = await ensureConnected();
    const response = await client.send('ping', {}, 5000);
    if (response.ok && response.data) {
      if (!connectedLatch) {
        connectedLatch = true;
        try { await opts.onConnected?.(); } catch { /* ignore callback errors */ }
      }
      // Connected does NOT mean "the GUI editor answered" — a stray headless
      // UnrealEditor-Cmd.exe answers pings identically (issue #342). Always
      // check identity, even on the happy path.
      const { identity, guiDetected } = await detectIdentity(listProcesses);
      const diagnostic = identity ? buildProcessDiagnostic(identity, true) : undefined;
      return {
        connected: true,
        ...sidecarFields,
        ...(response.data as Record<string, unknown>),
        editor_process_detected: guiDetected,
        ue_processes: identity,
        process_identity: identity ? describeProcessIdentity(identity) : undefined,
        ...(diagnostic ? { diagnostic } : {}),
      };
    }
    const { identity, guiDetected } = await detectIdentity(listProcesses);
    return {
      connected: false,
      error: response.error,
      editor_process_detected: guiDetected,
      ue_processes: identity,
      process_identity: identity ? describeProcessIdentity(identity) : undefined,
      diagnostic: identity ? buildProcessDiagnostic(identity, false) : undefined,
      ...sidecarFields,
    };
  } catch (err) {
    const { identity, guiDetected } = await detectIdentity(listProcesses);
    return {
      connected: false,
      error: err instanceof Error ? err.message : 'Unknown error',
      editor_process_detected: guiDetected,
      ue_processes: identity,
      process_identity: identity ? describeProcessIdentity(identity) : undefined,
      diagnostic: identity ? buildProcessDiagnostic(identity, false) : undefined,
      ...sidecarFields,
    };
  }
}
