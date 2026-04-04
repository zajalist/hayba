import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import os from "os";

export const GAEA_CANDIDATE_PATHS = [
  path.join(process.env.LOCALAPPDATA ?? os.homedir(), "Programs", "Gaea 2.0", "Gaea.exe"),
  path.join(process.env.LOCALAPPDATA ?? os.homedir(), "Programs", "Gaea 2.2", "Gaea.exe"),
  path.join(process.env.LOCALAPPDATA ?? os.homedir(), "Programs", "Gaea", "Gaea.exe"),
  "C:\\Program Files\\QuadSpinner\\Gaea 2\\Gaea.exe",
];

export function detectGaeaPath(): string | null {
  return GAEA_CANDIDATE_PATHS.find(p => existsSync(p)) ?? null;
}

export function launchGaea(gaeaExePath: string, terrainPath: string): number {
  if (!existsSync(gaeaExePath)) {
    throw new Error(`Gaea.exe not found at ${gaeaExePath}. Update gaeaExePath in swarmhost.config.json.`);
  }
  const child = spawn(gaeaExePath, [terrainPath], { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid!;
}

export function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
