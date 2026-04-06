import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import os from "os";

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");

export const GAEA_CANDIDATE_PATHS = [
  path.join(LOCALAPPDATA, "Programs", "Gaea 2.0", "Gaea.exe"),
  path.join(LOCALAPPDATA, "Programs", "Gaea 2.2", "Gaea.exe"),
  path.join(LOCALAPPDATA, "Programs", "Gaea", "Gaea.exe"),
  "C:\\Program Files\\QuadSpinner\\Gaea 2\\Gaea.exe",
];

export const GAEA_SWARM_CANDIDATE_PATHS = [
  path.join(LOCALAPPDATA, "Programs", "Gaea 2.0", "Gaea.Swarm.exe"),
  path.join(LOCALAPPDATA, "Programs", "Gaea 2.1", "Gaea.Swarm.exe"),
  path.join(LOCALAPPDATA, "Programs", "Gaea 2.2", "Gaea.Swarm.exe"),
  path.join(LOCALAPPDATA, "Programs", "Gaea 2.3", "Gaea.Swarm.exe"),
  path.join(LOCALAPPDATA, "Programs", "Gaea", "Gaea.Swarm.exe"),
  "C:\\Program Files\\QuadSpinner\\Gaea 2\\Gaea.Swarm.exe",
];

export function detectGaeaPath(): string | null {
  return GAEA_CANDIDATE_PATHS.find(p => existsSync(p)) ?? null;
}

export function detectSwarmPath(): string | null {
  return GAEA_SWARM_CANDIDATE_PATHS.find(p => existsSync(p)) ?? null;
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
