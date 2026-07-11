import { execFile } from 'node:child_process';

/**
 * Best-effort "is the UnrealEditor process alive?" probe, mirroring the signal
 * used by hayba_check_ue_status so a heavy-op transport failure can be
 * described accurately as "editor busy" (process up) vs "editor gone" (process
 * down). Cross-platform, short timeout, never throws — resolves null when the
 * detection itself is unavailable.
 *
 * Kept dependency-light (child_process only) so the executor can lazy-import it
 * without dragging in the TCP client / sidecar.
 */
export function probeEditorProcess(): Promise<boolean | null> {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'tasklist' : 'pgrep';
  const args = isWin
    ? ['/FI', 'IMAGENAME eq UnrealEditor.exe', '/NH']
    : ['-f', 'UnrealEditor'];
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 2000, windowsHide: true }, (err, stdout) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve(null);
        const out = (stdout || '').toLowerCase();
        resolve(isWin ? out.includes('unrealeditor.exe') : out.trim().length > 0);
      });
    } catch {
      resolve(null);
    }
  });
}
