#!/usr/bin/env node
process.env.DASHBOARD_PORT = process.env.HAYBA_APP_PORT || process.env.DASHBOARD_PORT || '7821';

const { config } = await import('../config.js');
const { createDashboardApp } = await import('../dashboard/server.js');
const { detectChatResources } = await import('./routes.js');

const host = config.dashboardHost || '127.0.0.1';
const port = config.dashboardPort;
const url = `http://${host}:${port}/`;

async function probe(path: string): Promise<boolean> {
  try {
    const health = await fetch(`http://${host}:${port}${path}`, { signal: AbortSignal.timeout(800) });
    return health.ok;
  } catch {
    return false;
  }
}

function announce() {
  const line = `Hayba app: ${url}`;
  console.error(line);
  process.stdout.write(line + '\n');
}

if (await probe('/workspace/health')) {
  announce();
  process.exit(0);
} else {
  const resources = detectChatResources();
  if (!resources) {
    console.error('Hayba chat files were not found. Reinstall the plugin, then start Hayba again.');
    process.exit(1);
  }
  const app = createDashboardApp({ staticDir: null });
  try {
    await new Promise<void>((resolve, reject) => {
      const server = app.listen(port, host, (error?: Error) => {
        if (error) reject(error);
        else resolve();
      });
      server.on('error', reject);
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EADDRINUSE' || !(await probe('/workspace/health'))) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
    announce();
    process.exit(0);
  }
  announce();
}

await new Promise(() => undefined);
