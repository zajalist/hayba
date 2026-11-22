import { build } from 'esbuild';
import { rcedit } from 'rcedit';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(dirname(fileURLToPath(import.meta.url)));
const payload = process.env.HAYBA_PACKAGE_ZIP;
if (!payload || !existsSync(payload) || !process.env.HAYBA_PACKAGE_SHA256)
  throw Error('Build the desktop installer with tools/build-installer.mjs --desktop and the compiled native artifact.');
if (createHash('sha256').update(readFileSync(payload)).digest('hex') !== process.env.HAYBA_PACKAGE_SHA256)
  throw Error('The plugin archive changed after packaging.');
execFileSync(process.execPath, ['node_modules/electron/install.js'], { stdio: 'inherit' });
const appDir = join(process.env.HAYBA_OUTPUT_DIR || join(process.cwd(), 'bin'), 'app');
cpSync('node_modules/electron/dist', appDir, { recursive: true });
renameSync(join(appDir, 'electron.exe'), join(appDir, 'Hayba.exe'));
const app = join(appDir, 'resources/app');
mkdirSync(app, { recursive: true });
const icon = join(process.cwd(), 'media/Hayba.ico');
await rcedit(join(appDir, 'Hayba.exe'), {
  icon,
  'version-string': { ProductName: 'Hayba Desktop', FileDescription: 'Hayba Desktop', OriginalFilename: 'Hayba.exe', InternalName: 'Hayba' },
});
cpSync(icon, join(app, 'Hayba.ico'));
for (const name of [
  'package.json',
  'session.cjs',
  'history.cjs',
  'preferences.cjs',
  'main.cjs',
  'lighting.cjs',
  'preload.cjs',
  'settings.html',
  'workspace.html',
])
  cpSync(name, join(app, name));
cpSync('../LICENSE', join(app, 'LICENSE'));
await build({
  absWorkingDir: process.cwd(),
  entryPoints: ['provider-entry.mjs'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: join(app, 'provider.cjs'),
});
const source = '../unreal/HaybaMCPToolkit/Resources';
await build({
  absWorkingDir: process.cwd(),
  entryPoints: {
    'lighting-mcp': 'lighting-client.cjs',
    'lighting-server': '../mcp-tools/hayba-mcp/src/lighting-stdio.ts',
  },
  outdir: app,
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
});
await build({
  absWorkingDir: process.cwd(),
  entryPoints: ['../mcp-tools/hayba-mcp/src/tcp-client.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: join(app, 'editor-client.cjs'),
});
cpSync(join(source, 'HaybaLogo.svg'), join(app, 'HaybaLogo.svg'));
await build({
  absWorkingDir: process.cwd(),
  entryPoints: { workspace: 'workspace.jsx', preferences: 'preferences.jsx' },
  outdir: app,
  bundle: true,
  minify: true,
  legalComments: 'eof',
  loader: { '.woff2': 'file' },
  define: { 'process.env.NODE_ENV': '"production"' },
  assetNames: 'assets/[name]-[hash]',
});
for (const font of ['dm-sans', 'space-grotesk']) {
  cpSync('node_modules/@fontsource-variable/' + font + '/LICENSE', join(app, 'assets', font + '-LICENSE.txt'));
}
const compiler = process.env.HAYBA_ISCC || join(process.env.LOCALAPPDATA, 'Programs/Inno Setup 6/ISCC.exe');
execFileSync(
  compiler,
  [
    '/Q',
    '/DWithMcp=0',
    '/DAppVersion=' + JSON.parse(readFileSync('package.json', 'utf8')).version,
    '/DDesktopDir=' + appDir,
    '/DInstallerDir=' + join(process.cwd(), '../tools/installer'),
    '/DPackageZip=' + payload,
    '/O' + (process.env.HAYBA_OUTPUT_DIR || join(process.cwd(), 'bin')),
    '../tools/installer/hayba-setup.iss',
  ],
  { stdio: 'inherit' },
);
