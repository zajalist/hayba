// mcp_server/src/config.ts
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve a PCGEx resource (node_catalog.json, pcgex_registry.db, …) by
 * walking a list of sensible fallback locations. Returns the first
 * existing path, or the first candidate (so callers can produce a useful
 * error referencing the canonical location).
 *
 * Order:
 *  1. Explicit env override (HAYBA_NODE_CATALOG / HAYBA_PCGEX_DB)
 *  2. New plugin layout: <pkg>/Plugins/HaybaMCPToolkit/Resources/<name>
 *  3. Workspace-root Resources: <pkg>/Resources/<name>
 *  4. Plugin-co-located Resources: <pkg>/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Resources/<name>
 *  5. Legacy layout (Hayba_PcgEx_MCP) — kept so existing installs keep working
 */
function resolveResource(filename: string, envVar?: string): string {
  const candidates: string[] = [];
  if (envVar && process.env[envVar]) candidates.push(process.env[envVar] as string);

  // packages/hayba is one level above dist/
  const pkgRoot = resolve(__dirname, '..');
  candidates.push(
    resolve(pkgRoot, 'Plugins', 'HaybaMCPToolkit', 'Resources', filename),
    resolve(pkgRoot, 'Resources', filename),
    resolve(pkgRoot, 'Plugins', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Resources', filename),
    resolve(pkgRoot, 'Plugins', 'Hayba_PcgEx_MCP', 'Resources', filename),
    resolve(pkgRoot, '..', 'Plugins', 'Hayba_PcgEx_MCP', 'Resources', filename),
  );

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

export const config = {
  /** UE TCP server port */
  ueTcpPort: parseInt(process.env.UE_TCP_PORT || '52342', 10),

  /** UE TCP server host */
  ueTcpHost: process.env.UE_TCP_HOST || '127.0.0.1',

  /** Web dashboard port */
  dashboardPort: parseInt(process.env.DASHBOARD_PORT || '52343', 10),

  /** Dashboard host */
  dashboardHost: process.env.DASHBOARD_HOST || '127.0.0.1',

  /** Path to PCGEx node catalog JSON (override with HAYBA_NODE_CATALOG) */
  get catalogPath() {
    return resolveResource('node_catalog.json', 'HAYBA_NODE_CATALOG');
  },

  /** Path to PCGEx SQLite registry produced by hayba_scrape_node_registry (override with HAYBA_PCGEX_DB) */
  get pcgexDbPath() {
    return resolveResource('pcgex_registry.db', 'HAYBA_PCGEX_DB');
  },

  /**
   * Code Mode (progressive tool discovery).
   * On (default): server exposes only 3 meta-tools (list_tool_categories,
   *   get_tool_signature, python_run). Claude pulls schemas on demand and
   *   invokes domain commands through python_run. Spec target: ~92% token
   *   reduction on multi-domain tasks.
   * Off: every tool is registered eagerly. Override with HAYBA_CODE_MODE=off.
   */
  codeMode: process.env.HAYBA_CODE_MODE !== 'off',

  /** Terrain critique threshold — complexity score above which self-critique triggers */
  critiqueThreshold: parseFloat(process.env.HAYBA_CRITIQUE_THRESHOLD || '15.0'),

  /** Whether terrain critique is enabled */
  critiqueEnabled: process.env.HAYBA_CRITIQUE_ENABLED !== 'false',
};
