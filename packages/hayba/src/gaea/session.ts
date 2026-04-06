import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { SwarmHostClient, type SwarmHostConfig } from "./swarmhost.js";

export class SessionManager {
  readonly client: SwarmHostClient;
  readonly outputDir: string;
  readonly gaeaExePath: string;
  terrainPath: string | null = null;
  gaeaPid: number | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(config: SwarmHostConfig) {
    // If port is 35771 (Gaea's network API), use HTTP mode instead of CLI
    if (config.port === 35771) {
      this.client = new SwarmHostClient(config.port);
    } else {
      this.client = new SwarmHostClient(config);
    }
    this.outputDir = config.outputDir;
    this.gaeaExePath = config.gaeaExePath ?? "";
    mkdirSync(config.outputDir, { recursive: true });
    this._loadGaeaSession();
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => fn());
    this.queue = next.catch(() => {});
    return next;
  }

  setTerrainPath(p: string | null): void {
    this.terrainPath = p;
    if (p) this.client["_currentTerrainPath"] = p;
  }

  saveGaeaSession(): void {
    const f = this._sessionFilePath();
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ terrainPath: this.terrainPath, gaeaPid: this.gaeaPid }), "utf-8");
  }

  clearGaeaSession(): void {
    try { unlinkSync(this._sessionFilePath()); } catch { /* ok */ }
    this.terrainPath = null;
    this.gaeaPid = null;
  }

  private _loadGaeaSession(): void {
    try {
      const data = JSON.parse(readFileSync(this._sessionFilePath(), "utf-8"));
      if (typeof data.terrainPath === "string") {
        this.terrainPath = data.terrainPath;
        this.client["_currentTerrainPath"] = data.terrainPath;
      }
      if (typeof data.gaeaPid === "number") this.gaeaPid = data.gaeaPid;
    } catch { /* no saved session */ }
  }

  private _sessionFilePath(): string {
    return path.join(
      process.env.APPDATA ?? os.homedir(),
      "QuadSpinner", "Gaea", "gaea_mcp_session.json"
    );
  }

  async shutdown(): Promise<void> {}
}
