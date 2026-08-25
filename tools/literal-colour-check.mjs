#!/usr/bin/env node
/**
 * No literal colours outside the style sheet.
 *
 * style-token-check verifies that every token a panel REFERENCES exists. It
 * cannot see a hardcoded FLinearColor(0.45f, 0.8f, 0.5f), because that
 * references nothing — a literal is invisible to a token checker by
 * construction. So twelve colours across four panels sat outside the visual
 * system, and every one had drifted from the token that meant the same thing:
 *
 *   - the Plan panel's "accent" was (1.00, 0.78, 0.30), a bright yellow-orange,
 *     while the product's ochre is #C47A28
 *   - the Settings "keyless" green was (0.45, 0.80, 0.50) against a restrained
 *     #7EA58A
 *
 * Two gates are needed because they catch opposite mistakes: one finds a token
 * name that does not exist, this one finds a colour that never asked for a
 * token at all.
 *
 *   node tools/literal-colour-check.mjs
 *
 * Exits non-zero on a violation.
 */
import fs from 'node:fs';
import path from 'node:path';

const PRIVATE = path.resolve('unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private');

// The style sheet is where literals belong: it is the definition of the
// palette, so every colour in it is a literal by necessity.
const ALLOWED = new Set(['HaybaMCPStyle.cpp']);

// A literal colour: a constructor taking numbers. FLinearColor::White and
// friends are engine constants rather than invented colours, so they are not
// matched.
const LITERAL_SRC = String.raw`F(?:Linear)?Color\s*\(\s*[-+]?(?:\d|0x)`;

// ...but only where it is handed to a Slate styling call. That is the
// structural definition of "someone invented a chrome colour inline".
//
// Scoping by CALL rather than by filename is deliberate. A filename exclusion
// list is the fail-open pattern: nobody revisits it, it grows, and eventually
// the gate covers nothing. This scope cannot be dodged by moving a file.
//
// Deliberately NOT covered, because they are not chrome:
//   - data-model colour defaults (a mask colour the user picks and we persist)
//   - UE graph schema overrides like GetPinTypeColor / GetNodeTitleColor,
//     which answer to the engine's graph conventions, not this dock's palette
//   - DrawDebug* calls into the 3D viewport
const STYLING_CALL = new RegExp(
  String.raw`\.(?:ColorAndOpacity|BorderBackgroundColor|ButtonColorAndOpacity|ForegroundColor|` +
  String.raw`ColorAndOpacity_Lambda|SetColorAndOpacity)\s*\(` +
  String.raw`[^;]*` + LITERAL_SRC);

const LITERAL = STYLING_CALL;

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.cpp') || e.name.endsWith('.h')) yield p;
  }
}

function isComment(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

const violations = [];
for (const file of walk(PRIVATE)) {
  const base = path.basename(file);
  if (ALLOWED.has(base)) continue;
  // Tests legitimately construct colours to compare against.
  if (file.includes(`${path.sep}Tests${path.sep}`)) continue;

  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (isComment(line)) return;
    if (LITERAL.test(line)) {
      violations.push({ file: path.relative(process.cwd(), file), line: i + 1, text: line.trim() });
    }
  });
}

if (violations.length) {
  console.error(`literal-colour-check: ${violations.length} hardcoded colour(s) in Slate styling calls\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text.length > 90 ? v.text.slice(0, 90) + '…' : v.text}`);
  }
  console.error('\nRegister the colour in HaybaMCPStyle.cpp and use FHaybaMCPStyle::Colour("...").');
  console.error('A literal is invisible to style-token-check, so it drifts silently.');
  process.exit(1);
}

console.log('ok: no hardcoded colours in Slate styling calls outside the style sheet');
console.log('     (data-model defaults, UE graph-schema overrides and DrawDebug* are out of scope)');
