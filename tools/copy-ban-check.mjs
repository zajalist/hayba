#!/usr/bin/env node
/**
 * Enforce the copy the IA explicitly bans.
 *
 *   "The wizard never says '7 panels,' '11 panels,' or 'Coming soon.'"
 *   "It does not pretend that a future screen is 'coming soon.'"
 *
 * These are not style preferences. Both rules exist because the copy they ban
 * describes the product as it is not: a promise instead of a feature, or a
 * panel count that was wrong the moment a panel was added or removed. The Chat
 * panel shipped "Recent conversations - coming soon" for exactly as long as
 * nobody re-read the blueprint.
 *
 * Only USER-FACING strings count. A comment explaining why a phrase was
 * removed is the opposite of the problem, and flagging it would push people to
 * delete the explanation.
 *
 *   node tools/copy-ban-check.mjs
 *
 * Exits non-zero on a violation.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('unreal');

const BANS = [
  {
    re: /coming soon/i,
    why: 'the IA forbids pretending a future screen exists; ship the affordance or say what the user can do now',
  },
  {
    re: /\b\d+\s+panels\b/i,
    why: 'a hardcoded panel count is wrong the moment a panel is added or removed; describe what the panels do',
  },
];

/**
 * Pull the user-facing strings out of a line.
 *
 * LOCTEXT("Key", "the copy") and NSLOCTEXT("NS", "Key", "the copy") put the
 * displayed text last, so the key -- which is an identifier and may legitimately
 * contain anything -- must not be scanned. A bare TEXT("...") is scanned too:
 * plenty of copy in this codebase never went through LOCTEXT.
 */
function userFacingStrings(line) {
  const out = [];

  // (?:NS)? -- NOT NS?. The latter requires a literal N, so it matches
  // NSLOCTEXT and silently never matches bare LOCTEXT, which is most of
  // the copy in this codebase. This gate reported clean against a
  // deliberately reintroduced violation until that was fixed.
  const loc = /\b(?:NS)?LOCTEXT\s*\(([^)]*)\)/g;
  let m;
  while ((m = loc.exec(line)) !== null) {
    const parts = m[1].match(/"(?:[^"\\]|\\.)*"/g);
    // Last argument is the display text; earlier ones are namespace and key.
    if (parts && parts.length) out.push(parts[parts.length - 1]);
  }

  // Strip the LOCTEXT calls before looking for bare TEXT(...), so their keys
  // are not rescanned as loose strings.
  const rest = line.replace(loc, '');
  const bare = /\bTEXT\s*\(\s*("(?:[^"\\]|\\.)*")\s*\)/g;
  while ((m = bare.exec(rest)) !== null) out.push(m[1]);

  return out;
}

function isComment(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['Binaries', 'Intermediate', 'Saved', '.git'].includes(e.name)) continue;
      yield* walk(p);
    } else if (/\.(cpp|h)$/.test(e.name)) {
      yield p;
    }
  }
}

const violations = [];
for (const file of walk(ROOT)) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    for (const s of userFacingStrings(line)) {
      for (const ban of BANS) {
        if (ban.re.test(s)) {
          violations.push({
            file: path.relative(process.cwd(), file),
            line: i + 1,
            text: s.length > 70 ? s.slice(0, 70) + '…"' : s,
            why: ban.why,
          });
        }
      }
    }
  });
}

if (violations.length) {
  console.error(`copy-ban-check: ${violations.length} banned string(s) in user-facing copy\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}`);
    console.error(`    ${v.why}\n`);
  }
  process.exit(1);
}

console.log('ok: no banned copy in user-facing strings (checked LOCTEXT, NSLOCTEXT and bare TEXT)');
