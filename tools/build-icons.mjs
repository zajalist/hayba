#!/usr/bin/env node
//
// Derives the plugin's icon rasters from the signed 512px masters.
//
// Masters live in docs/design/2026-08-23-extension-redesign/icons-final/ and are
// the source of truth; Resources/Icons/ holds only generated output and can be
// deleted and rebuilt at any time. Never hand-edit a file under Resources/Icons.
//
// Slate is given rasters at the exact sizes it draws (28 and 16, plus @2x for
// high-DPI) so it never scales an image at draw time -- a downscale in Slate is
// a bilinear blur, and these are filled silhouettes whose whole legibility
// argument rests on crisp edges.
//
// Usage:  node tools/build-icons.mjs [--check]
//   --check  verify every expected raster exists and is newer than its master,
//            and exit non-zero otherwise. For CI.

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MASTERS = join(ROOT, 'docs/design/2026-08-23-extension-redesign/icons-final');
const OUT = join(ROOT, 'unreal/HaybaMCPToolkit/Resources/Icons');

// Sidebar draws at 28, inline marks and row-end state marks at 16. @2x covers
// 200% DPI scaling, which UE applies to Slate brushes on high-DPI displays.
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
    const missing = [];
    const stale = [];
    for (const f of files) {
      const name = f.replace(/\.png$/, '');
      const masterMtime = statSync(join(MASTERS, f)).mtimeMs;
      for (const size of SIZES) {
        const out = join(OUT, `${name}@${size}.png`);
        if (!existsSync(out)) { missing.push(`${name}@${size}.png`); continue; }
        if (statSync(out).mtimeMs < masterMtime) stale.push(`${name}@${size}.png`);
      }
    }
    if (missing.length || stale.length) {
      if (missing.length) console.error(`missing ${missing.length} raster(s): ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ' ...' : ''}`);
      if (stale.length) console.error(`stale ${stale.length} raster(s): ${stale.slice(0, 6).join(', ')}${stale.length > 6 ? ' ...' : ''}`);
      console.error('run: node tools/build-icons.mjs');
      process.exit(1);
    }
    console.log(`ok: ${files.length} icons x ${SIZES.length} sizes present and current`);
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
          .toFile(join(OUT, `${name}@${size}.png`));
        written++;
      }
    }
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
    $bmp.Save((Join-Path $out ($name + '@' + $size + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
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
  console.log(r.stdout.trim() + ` (${files.length} icons x ${SIZES.length} sizes)`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
