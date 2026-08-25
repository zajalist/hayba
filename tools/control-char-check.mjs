#!/usr/bin/env node
/**
 * No stray control characters in source.
 *
 * A `sed -i 's|/fix|/\bfix|'` wrote a literal BACKSPACE byte (0x08) into a test
 * file instead of the two characters backslash-b. The regex became
 * `/<BS>fix\s*[:,]/`, which requires a backspace before "fix" and therefore
 * matches nothing — the guard reported clean against a real violation.
 *
 * What makes this worth a check rather than a lesson: it is INVISIBLE. sed,
 * grep and the terminal all render 0x08 as nothing, so the line read back as
 * correct in every tool. Only repr() of the raw bytes showed it. A corrupted
 * regex that silently never matches is the worst kind of disarmed test.
 *
 *   node tools/control-char-check.mjs
 *
 * Exits non-zero on a violation.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['tools', 'unreal', path.join('mcp-tools', 'hayba-mcp', 'src')];
const EXT = /\.(mjs|js|ts|tsx|cpp|h|cs|json)$/;

// Tab, newline and carriage return are legitimate. Everything else below 0x20,
// plus DEL, is a control character nobody types on purpose.
const BAD = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'Binaries', 'Intermediate', 'Saved', '.git', 'dist'].includes(e.name)) continue;
      yield* walk(p);
    } else if (EXT.test(e.name)) {
      yield p;
    }
  }
}

const violations = [];
for (const root of ROOTS) {
  for (const file of walk(path.resolve(root))) {
    const text = fs.readFileSync(file, 'utf8');
    if (!BAD.test(text)) continue;
    text.split('\n').forEach((line, i) => {
      const m = BAD.exec(line);
      if (!m) return;
      violations.push({
        file: path.relative(process.cwd(), file),
        line: i + 1,
        code: '0x' + m[0].charCodeAt(0).toString(16).padStart(2, '0'),
        // Render the control char visibly, since the whole problem is that it
        // is invisible everywhere else.
        text: line.replace(BAD, (c) => `<0x${c.charCodeAt(0).toString(16).padStart(2, '0')}>`).trim(),
      });
    });
  }
}

if (violations.length) {
  console.error(`control-char-check: ${violations.length} stray control character(s)\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  (${v.code})`);
    console.error(`    ${v.text.length > 100 ? v.text.slice(0, 100) + '…' : v.text}`);
  }
  console.error('\nUsually a shell escape that produced the byte instead of the escape sequence.');
  process.exit(1);
}

console.log('ok: no stray control characters in source');
