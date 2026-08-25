#!/usr/bin/env node
/**
 * Visual test for the Hayba dock.
 *
 * Every other check in this repo reads source. None of them could see the UI,
 * which is how BuildHeader() sat defined-and-never-called through a green
 * suite, and how the sidebar shipped with no active-destination marking at
 * all. This walks the dock through its six screens, captures each one, and
 * asserts on the pixels.
 *
 * What it can prove from a PNG:
 *   - the capture is real (non-trivial size, expected dimensions)
 *   - each destination renders something DIFFERENT from the others (a dead
 *     switch would produce six identical images and pass any size check)
 *   - ochre is actually on screen where the IA reserves it for the active
 *     destination
 *
 * What it cannot prove: that the right thing is in the right place. That still
 * needs a person looking, which is why the PNGs are kept, not deleted.
 *
 *   node tools/visual-dock-test.mjs [--out <dir>]
 *
 * Requires the editor running with the dock open. Exits non-zero on failure.
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const PORT = 52342;
const PANELS = ['activity', 'chat', 'rules', 'world', 'library', 'settings'];

// The IA's semantic ochre. Captures are 8-bit sRGB, and Slate composites, so
// match on a neighbourhood rather than the exact triple.
const OCHRE = [0xc4, 0x7a, 0x28];
const OCHRE_TOLERANCE = 40;

const outDir = (() => {
  const i = process.argv.indexOf('--out');
  return path.resolve(i > 0 ? process.argv[i + 1] : 'artifacts/visual-dock');
})();

let counter = 0;
function send(command, args) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, '127.0.0.1');
    // The wire is {cmd, id, params} with a BIG-endian length prefix. A flat
    // body or a little-endian length is read as a garbage frame and the
    // plugin drops the connection, which surfaces as ECONNRESET rather than
    // as a protocol error.
    const payload = Buffer.from(JSON.stringify({
      cmd: command, id: `v${counter++}`, params: args,
    }), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    let expect = null;
    let buf = Buffer.alloc(0);

    sock.on('connect', () => sock.write(Buffer.concat([header, payload])));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (expect === null && buf.length >= 4) {
        expect = buf.readUInt32BE(0);
        buf = buf.subarray(4);
      }
      if (expect !== null && buf.length >= expect) {
        sock.end();
        try { resolve(JSON.parse(buf.subarray(0, expect).toString('utf8'))); }
        catch (e) { reject(e); }
      }
    });
    sock.on('error', reject);
    sock.setTimeout(30_000, () => { sock.destroy(); reject(new Error(`${command}: timed out`)); });
  });
}

/**
 * Decode enough PNG to compare images. Only the cases our own capture writes:
 * 8-bit RGBA, non-interlaced. Anything else is a bug worth failing on rather
 * than silently tolerating, because a format we did not expect means the
 * capture path changed under us.
 */
function decodePng(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a PNG`);
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.subarray(off + 4, off + 8).toString('latin1');
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        depth: data[8], colour: data[9], interlace: data[12],
      };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error(`${file}: no IHDR`);
  if (ihdr.depth !== 8 || ihdr.interlace !== 0 || (ihdr.colour !== 6 && ihdr.colour !== 2))
    throw new Error(`${file}: unsupported PNG (depth ${ihdr.depth}, colour ${ihdr.colour}, interlace ${ihdr.interlace})`);

  const bpp = ihdr.colour === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = ihdr.width * bpp;
  const px = Buffer.alloc(ihdr.height * stride);

  // Undo the per-scanline filters. Skipping this and comparing raw IDAT bytes
  // would "work" for the difference test and lie for the colour test, since a
  // filtered byte is a delta, not a colour.
  for (let y = 0; y < ihdr.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const up = y > 0 ? px[(y - 1) * stride + x] : 0;
      const ul = (x >= bpp && y > 0) ? px[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (a + up) >> 1;
      else if (filter === 4) {
        const p = a + up - ul;
        const pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - ul);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? up : ul);
      }
      px[y * stride + x] = v & 0xff;
    }
  }
  return { ...ihdr, bpp, stride, px };
}

function countOchre(img) {
  let n = 0;
  for (let i = 0; i < img.px.length; i += img.bpp) {
    if (Math.abs(img.px[i] - OCHRE[0]) <= OCHRE_TOLERANCE
      && Math.abs(img.px[i + 1] - OCHRE[1]) <= OCHRE_TOLERANCE
      && Math.abs(img.px[i + 2] - OCHRE[2]) <= OCHRE_TOLERANCE) n++;
  }
  return n;
}

function differs(a, b) {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let d = 0;
  for (let i = 0; i < a.px.length; i++) if (a.px[i] !== b.px[i]) d++;
  return d / a.px.length;
}

const failures = [];
const fail = (m) => { failures.push(m); console.log(`  FAIL  ${m}`); };
const pass = (m) => console.log(`  ok    ${m}`);

fs.mkdirSync(outDir, { recursive: true });
console.log(`visual dock test -> ${outDir}\n`);

const images = {};
for (const panel of PANELS) {
  const file = path.join(outDir, `${panel}.png`);
  let res;
  try {
    res = await send('ui_capture_panel', { path: file, panel });
  } catch (e) {
    fail(`${panel}: capture threw (${e.message}) - is the editor running with the dock open?`);
    continue;
  }
  if (!res.ok) { fail(`${panel}: ${res.error ?? JSON.stringify(res)}`); continue; }

  const r = res.data ?? res;
  // A 1x1 or empty PNG satisfies "a file exists". Assert on the content.
  if (!r.verified || !(r.bytes > 2000)) {
    fail(`${panel}: capture is not a real image (${r.bytes} bytes, verified=${r.verified})`);
    continue;
  }
  if (!(r.width > 200 && r.height > 200)) {
    fail(`${panel}: implausible dimensions ${r.width}x${r.height}`);
    continue;
  }
  images[panel] = decodePng(file);
  pass(`${panel}: ${r.width}x${r.height}, ${r.bytes} bytes`);
}

console.log('');

// Every destination must render something distinct. Six identical images is
// exactly what a dead panel switch looks like, and every size check above
// would still pass.
const names = Object.keys(images);
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const d = differs(images[names[i]], images[names[j]]);
    if (d < 0.01) fail(`${names[i]} and ${names[j]} render identically (${(d * 100).toFixed(2)}% of bytes differ) - the panel switch is not taking effect`);
  }
}
if (names.length > 1 && !failures.some((f) => f.includes('identically')))
  pass(`all ${names.length} destinations render distinctly`);

// Ochre marks the active destination. If none is on screen, the marking that
// tells you where you are is absent - which is the state this suite was
// written to catch.
for (const [panel, img] of Object.entries(images)) {
  const n = countOchre(img);
  if (n < 20) fail(`${panel}: no semantic ochre on screen (${n} px) - the active destination is unmarked`);
  else pass(`${panel}: active destination marked (${n} ochre px)`);
}

console.log('');
if (failures.length) {
  console.log(`${failures.length} failure(s). Captures kept in ${outDir} - look at them.`);
  process.exit(1);
}
console.log(`all visual checks passed. Captures in ${outDir} - still worth looking at.`);
