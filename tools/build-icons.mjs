#!/usr/bin/env node
//
// Derives the plugin's icon rasters from the signed 512px masters.
//
// Masters live in docs/design/2026-08-23-extension-redesign/icons-final/ and are
// the source of truth; Resources/Icons/ holds only generated output and can be
// deleted and rebuilt at any time. Never hand-edit a file under Resources/Icons.
//
// Slate is given rasters at the exact sizes it draws (28 and 16, plus 2x for
// high-DPI) so it never scales an image at draw time -- a downscale in Slate is
// a bilinear blur, and these are filled silhouettes whose whole legibility
// argument rests on crisp edges.
//
// Usage:  node tools/build-icons.mjs [--check]
//   --check  verify every raster exists and still matches its master's content
//            hash, and exit non-zero otherwise. For CI.
//
// Size suffix is "-28", not "@28": Perforce treats @ as a revision specifier,
// so a filename containing it needs %40 escaping and breaks p4 add. UE studios
// live in Perforce; the Apple-style @2x convention is not worth that.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MASTERS = join(ROOT, 'docs/design/2026-08-23-extension-redesign/icons-final');
const OUT = join(ROOT, 'unreal/HaybaMCPToolkit/Resources/Icons');
// Records which master each raster was built from, so --check can prove the
// output is current without relying on filesystem timestamps.
const MANIFEST = join(OUT, 'icons.manifest.json');

const preview = (xs, n = 6) => xs.slice(0, n).join(', ') + (xs.length > n ? ' ...' : '');

const STYLE = join(ROOT, 'unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPStyle.cpp');

/** Icon filenames the Slate style set binds, from its Icon()/StateMark() calls. */
function styleBindings() {
  if (!existsSync(STYLE)) return null;
  const src = readFileSync(STYLE, 'utf-8');
  const referenced = new Set();
  for (const m of src.matchAll(/(?:Icon|StateMark)\(\s*TEXT\("[^"]+"\)\s*,\s*TEXT\("([^"]+)"\)/g)) {
    referenced.add(m[1]);
  }
  return { referenced: [...referenced].sort() };
}

function masterHashes(files) {
  const out = {};
  for (const f of files) {
    out[f.replace(/\.png$/, '')] =
      createHash('sha256').update(readFileSync(join(MASTERS, f))).digest('hex').slice(0, 16);
  }
  return out;
}

// Sidebar draws at 28, inline marks and row-end state marks at 16. The 2x
// sizes cover 200% DPI scaling, which UE applies to Slate brushes on high-DPI displays.
const SIZES = [16, 28, 32, 56];

const CHECK = process.argv.includes('--check');

function masters() {
  if (!existsSync(MASTERS)) {
    throw new Error(
      `icon masters not found at ${MASTERS}\n` +
      `They are committed with the design dossier; if this is a fresh worktree ` +
      `the dossier commit may not be on this branch.`
    );
  }
  return readdirSync(MASTERS)
    .filter(f => f.endsWith('.png'))
    .sort();
}

async function loadSharp() {
  try {
    return (await import('sharp')).default;
  } catch {
    return null;
  }
}

async function main() {
  const files = masters();
  if (files.length === 0) throw new Error(`no .png masters in ${MASTERS}`);

  if (CHECK) {
    // Content hashes, not mtimes. git does not preserve modification times, so
    // in a fresh CI checkout every file carries the checkout time and an
    // mtime comparison decides nothing -- it would pass or fail by accident.
    const missing = [];
    for (const f of files) {
      const name = f.replace(/\.png$/, '');
      for (const size of SIZES) {
        if (!existsSync(join(OUT, `${name}-${size}.png`))) missing.push(`${name}-${size}.png`);
      }
    }

    const recorded = existsSync(MANIFEST)
      ? JSON.parse(readFileSync(MANIFEST, 'utf-8')).masters ?? {}
      : null;
    const current = masterHashes(files);
    const changed = recorded
      ? files.map(f => f.replace(/\.png$/, ''))
          .filter(n => recorded[n] !== current[n])
      : [];
    const orphaned = recorded
      ? Object.keys(recorded).filter(n => !(n in current))
      : [];

    const problems = [];
    if (missing.length) problems.push(`missing ${missing.length} raster(s): ${preview(missing)}`);

    // Slate resolves brushes by path at load time and renders nothing when a
    // file is absent -- no compile error, no log line anybody reads, just a
    // blank square. So the binding between the C++ and these files is checked
    // here, where it is cheap, rather than discovered in the editor.
    const bind = styleBindings();
    if (bind) {
      const unresolved = bind.referenced.filter(f => !files.includes(`${f}.png`));
      if (unresolved.length) {
        problems.push(
          `${unresolved.length} icon(s) referenced by HaybaMCPStyle.cpp with no master: ${preview(unresolved)}`
        );
      }
      const unused = files.map(f => f.replace(/\.png$/, ''))
        .filter(n => !bind.referenced.includes(n));
      if (unused.length) {
        // Not a failure: the set is authored ahead of the panels that will use
        // it, and rasters are cheap. Worth saying out loud so it stays a choice.
        console.log(`note: ${unused.length} icon(s) built but not yet referenced by the style set: ${preview(unused, 10)}`);
      }
    }

    if (!recorded) problems.push(`no manifest at ${MANIFEST.slice(ROOT.length + 1)} — rasters cannot be shown to match their masters`);
    if (changed.length) problems.push(`${changed.length} master(s) changed since the rasters were built: ${preview(changed)}`);
    if (orphaned.length) problems.push(`${orphaned.length} raster set(s) whose master is gone: ${preview(orphaned)}`);

    if (problems.length) {
      for (const p of problems) console.error(p);
      console.error('run: node tools/build-icons.mjs');
      process.exit(1);
    }
    console.log(`ok: ${files.length} icons x ${SIZES.length} sizes, all current with their masters`);
    return;
  }

  mkdirSync(OUT, { recursive: true });

  const sharp = await loadSharp();
  if (sharp) {
    let written = 0;
    for (const f of files) {
      const name = f.replace(/\.png$/, '');
      for (const size of SIZES) {
        await sharp(join(MASTERS, f))
          // Lanczos3 over the default: these are hard-edged two-tone shapes and
          // a cheaper filter visibly softens the ochre/cream boundary at 16px.
          .resize(size, size, { kernel: 'lanczos3', fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png({ compressionLevel: 9 })
          .toFile(join(OUT, `${name}-${size}.png`));
        written++;
      }
    }
    writeManifest(files);
    console.log(`wrote ${written} rasters via sharp (${files.length} icons x ${SIZES.length} sizes)`);
    return;
  }

  // No sharp: fall back to System.Drawing via PowerShell. The plugin is a
  // Windows editor module and its rasters are built on Windows, so this covers
  // the real case without making the repo carry a native image dependency.
  // Note HighQualityBicubic, not Lanczos -- System.Drawing has no Lanczos. On
  // these flat two-tone shapes the difference is small, but it is a difference:
  // if sharp is available, it is used in preference.
  if (process.platform !== 'win32') {
    console.error(
      'sharp is not installed and the System.Drawing fallback is Windows-only.\n' +
      'Install sharp (npm i -D sharp) to build icons on this platform.\n' +
      'Nothing was written.'
    );
    process.exit(2);
  }

  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$masters = '${MASTERS.replace(/\\/g, '\\\\')}'
$out     = '${OUT.replace(/\\/g, '\\\\')}'
$sizes   = @(${SIZES.join(',')})
$count   = 0
Get-ChildItem -Path $masters -Filter *.png | ForEach-Object {
  $src = [System.Drawing.Image]::FromFile($_.FullName)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
  foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $bmp.SetResolution($src.HorizontalResolution, $src.VerticalResolution)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CompositingMode    = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, 0, 0, $size, $size)
    $g.Dispose()
    $bmp.Save((Join-Path $out ($name + '-' + $size + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $count++
  }
  $src.Dispose()
}
Write-Output "wrote $count rasters via System.Drawing"
`.trim();

  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf-8',
  });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout || 'powershell failed with no output');
    process.exit(1);
  }
  writeManifest(files);
  console.log(r.stdout.trim() + ` (${files.length} icons x ${SIZES.length} sizes)`);
}

function writeManifest(files) {
  writeFileSync(MANIFEST, JSON.stringify({
    note: 'Generated by tools/build-icons.mjs. Lets --check prove the rasters match their masters without trusting mtimes, which git does not preserve.',
    sizes: SIZES,
    masters: masterHashes(files),
  }, null, 2) + '\n');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
