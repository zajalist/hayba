import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(dirname(fileURLToPath(import.meta.url)));
const plugin = 'bin/plugin/Hayba-Setup-0.4.2-Plugin+MCP.exe';
mkdirSync('bin/plugin', { recursive: true });
if (!existsSync(plugin))
  execFileSync(
    'gh',
    ['release', 'download', 'v0.4.2', '-R', 'zajalist/hayba', '-p', plugin.split('/').pop(), '-D', 'bin/plugin'],
    { stdio: 'inherit' },
  );
if (
  createHash('sha256').update(readFileSync(plugin)).digest('hex') !==
  '86a71e7cb4b9e8a669c6144d0ea240c0520070142ea1ecc43a7baa062f3fb53b'
)
  throw Error('Unreal plugin installer checksum mismatch');
execFileSync(process.execPath, ['node_modules/electron/install.js'], { stdio: 'inherit' });
cpSync('node_modules/electron/dist', 'bin/app', { recursive: true });
renameSync('bin/app/electron.exe', 'bin/app/Hayba.exe');
const app = 'bin/app/resources/app';
mkdirSync(app, { recursive: true });
for (const name of [
  'package.json',
  'session.cjs',
  'main.cjs',
  'preload.cjs',
  'settings.html',
  'settings.css',
  'settings.js',
])
  cpSync(name, join(app, name));
cpSync('../LICENSE', join(app, 'LICENSE'));
await build({
  entryPoints: ['../mcp-tools/hayba-mcp/src/agents/llm-client.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: join(app, 'provider.cjs'),
});
const source = '../unreal/HaybaMCPToolkit/Resources';
for (const name of ['chat', 'Fonts', 'HaybaLogo.svg'])
  cpSync(join(source, name), join(app, 'Resources', name), {
    recursive: true,
    filter: (p) => !p.endsWith('.test.cjs'),
  });
const chat = join(app, 'Resources/chat');
for (const name of ['desktop.js', 'desktop.css']) cpSync(name, join(chat, name));
const index = join(chat, 'index.html');
writeFileSync(
  index,
  readFileSync(index, 'utf8').replace(
    '</head>',
    '<link rel="stylesheet" href="desktop.css"><script src="desktop.js" defer></script></head>',
  ),
);
const compiler = process.env.HAYBA_ISCC || join(process.env.LOCALAPPDATA, 'Programs/Inno Setup 6/ISCC.exe');
execFileSync(compiler, ['/Q', 'setup.iss'], { stdio: 'inherit' });
