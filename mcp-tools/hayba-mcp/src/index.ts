// mcp_server/src/index.ts
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { listCatalogResources, readCatalogResource } from './resources.js';
import { registerTools } from './tools/index.js';
import { startDashboard } from './dashboard/server.js';
import { startHttpServer } from './http/server.js';
import { pingSidecar } from './tools/visual/sidecar-client.js';

/**
 * Print a banner to stderr (visible to Claude Code's MCP server log and to
 * the `/mcp` status panel) showing this build's age and — critically — warn
 * if any source file is newer than the compiled dist this binary was built
 * from. Pre-fix, the MCP server would silently run a stale build long
 * after a `git pull` + plugin rebuild, and the agent would chase ghosts
 * (e.g. "why isn't hayba_propose_plan a tool?"). This makes the staleness
 * visible the moment the server starts.
 */
function reportBuildFreshness(): void {
  try {
    const distFile = fileURLToPath(import.meta.url);              // .../dist/index.js
    const distRoot = dirname(distFile);
    const pkgRoot  = dirname(distRoot);                            // .../hayba-mcp
    const srcRoot  = join(pkgRoot, 'src');
    const distMs   = statSync(distFile).mtimeMs;

    // Walk src/ for any .ts file newer than the running dist build.
    let newestSrc = 0;
    let newestPath = '';
    const stack: string[] = [srcRoot];
    while (stack.length) {
      const cur = stack.pop()!;
      let entries: import('node:fs').Dirent[];
      try { entries = readdirSync(cur, { withFileTypes: true }); }
      catch { continue; }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '__tests__') continue;
        const full = join(cur, e.name);
        if (e.isDirectory()) { stack.push(full); continue; }
        if (!e.name.endsWith('.ts') || e.name.endsWith('.d.ts')) continue;
        try {
          const m = statSync(full).mtimeMs;
          if (m > newestSrc) { newestSrc = m; newestPath = full; }
        } catch { /* ignore */ }
      }
    }

    const distAt = new Date(distMs).toISOString();
    process.stderr.write(`[hayba-mcp] build: ${distAt}\n`);
    if (newestSrc > distMs) {
      const lagMin = ((newestSrc - distMs) / 60000).toFixed(1);
      process.stderr.write(
        `[hayba-mcp] ⚠️  STALE BUILD — source is ${lagMin} min newer than dist.\n` +
        `[hayba-mcp]    newest src: ${newestPath} (${new Date(newestSrc).toISOString()})\n` +
        `[hayba-mcp]    fix: cd mcp-tools/hayba-mcp && npm run build:server, then /mcp reconnect\n`,
      );
    }
  } catch (e) {
    // Never fail startup just because we couldn't stat src/. Worst case,
    // user just doesn't see the banner.
    process.stderr.write(`[hayba-mcp] (build freshness probe failed: ${(e as Error).message})\n`);
  }
}

// ── MCP server setup ─────────────────────────────────────────────────────────
const server = new McpServer({
  name: 'hayba-mcp',
  version: '1.0.0'
});

// Register catalog resources (PCGEx node catalog)
const catalogTemplate = new ResourceTemplate('pcgex://catalog/{category}', {
  list: async () => {
    const resources = await listCatalogResources();
    return { resources: resources.map(r => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType })) };
  }
});

server.resource('pcgex_catalog', catalogTemplate, async (uri, { category }) => {
  const content = await readCatalogResource(category as string);
  return {
    contents: [{ uri: uri.href, mimeType: 'application/json', text: content }]
  };
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function main() {
  // FIRST thing — before tool registration or transport setup — print the
  // build banner. If dist is stale relative to src, the operator (and the
  // agent reading the MCP log) sees it immediately instead of after hours
  // of "why isn't <tool> registered?" debugging.
  reportBuildFreshness();

  // Register all tools. The legacy SessionManager arg is a typed-shim no-op
  // until the worldbuilding-hub roadmap reaches the terrain integration phase.
  // Must complete before server.connect — γ-hybrid routing registers its
  // meta-tools asynchronously and the MCP SDK rejects post-connect registration.
  const routing = await registerTools(server, {});

  await startDashboard(config.dashboardPort, '127.0.0.1');
  console.error(`Dashboard: http://127.0.0.1:${config.dashboardPort}`);

  // HTTP server for the UE plugin (Slivers panel). Stdio remains the primary
  // MCP transport — this is a parallel surface for the same SliverSystem.
  if (routing?.slivers) {
    startHttpServer(routing.slivers);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Hayba MCP Toolkit v1.0.0 started on stdio`);
  console.error(`UE TCP target: ${config.ueTcpHost}:${config.ueTcpPort}`);

  // Probe visual sidecar in the background — populates the cache so subsequent
  // hayba_check_ue_status and visual tools can branch on availability without
  // paying connect-timeout latency.
  pingSidecar().then((h) => {
    const badge = h.available ? '🟢' : '🔴';
    const detail = h.available ? `models=${h.active_models.join(',') || 'none'}` : (h.error ?? 'unavailable');
    console.error(`Visual sidecar ${badge} ${h.url} — ${detail}`);
  }).catch((e: unknown) => {
    console.error(`Visual sidecar probe failed: ${e instanceof Error ? e.message : String(e)}`);
  });
}

main().catch(console.error);
