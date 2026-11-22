import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [bundleArg, engineArg, fixtureArg] = process.argv.slice(2);
if (!fixtureArg) throw new Error('Usage: node tools/installer/smoke.mjs <extracted-installer> <engine> <new-fixture-folder>');
const bundle = resolve(bundleArg), engine = resolve(engineArg), fixture = resolve(fixtureArg);
if (existsSync(fixture)) throw new Error('Use a new disposable fixture folder.');
const projectDir = join(fixture, 'Game with spaces');
mkdirSync(projectDir, { recursive: true });
mkdirSync(join(fixture, 'profile'), { recursive: true });
const project = join(projectDir, 'InstallerSmoke.uproject');
writeFileSync(project, JSON.stringify({ FileVersion: 3, EngineAssociation: '5.9', Plugins: [] }, null, 2));
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
const install = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(bundle, 'installer/Install.ps1'), '-Project', project, '-Engine', engine, '-PackageRoot', bundle, '-ClaudeCode', '-ClaudeDesktop', '-DesktopConfig', join(fixture, 'claude_desktop_config.json')], { env, stdio: 'inherit', windowsHide: true });
assert.equal(await new Promise((resolve, reject) => { install.once('error', reject); install.once('exit', resolve); }), 0, 'Installer failed');
const mcp = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8')).mcpServers;
const [name, entry] = Object.entries(mcp)[0];
assert.match(name, /^hayba-[a-f0-9]{8}$/);
assert.equal(entry.command, join(projectDir, 'Plugins/HaybaMCPToolkit/ThirdParty/node/node.exe'));
const transport = new StdioClientTransport({
  command: entry.command, args: entry.args, stderr: 'pipe',
  env: { ...entry.env, UE_TCP_PORT: '9', HAYBA_SIDECAR_URL: 'http://127.0.0.1:9', HAYBA_CHAT_SESSION_DIR: join(fixture, 'chat'), HAYBA_MEMORY_DB: join(fixture, 'memory.db'), APPDATA: join(fixture, 'profile'), LOCALAPPDATA: join(fixture, 'profile'), USERPROFILE: join(fixture, 'profile'), HOME: join(fixture, 'profile') },
});
let diagnostics = '';
transport.stderr?.on('data', chunk => { diagnostics += chunk.toString(); });
const client = new Client({ name: 'hayba-installer-smoke', version: '1.0.0' });
try {
  await client.connect(transport, { timeout: 60000 });
  assert.equal(client.getServerVersion().name, 'hayba-mcp');
  const tools = await client.listTools();
  assert.ok(tools.tools.length > 0);
  console.log(`Bundled Node + MCP handshake passed: ${tools.tools.length} tools, ${name}.`);
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally { await client.close(); }
console.log(JSON.stringify({ project, plugin: join(projectDir, 'Plugins/HaybaMCPToolkit'), fixture }, null, 2));
