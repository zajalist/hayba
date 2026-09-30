#!/usr/bin/env node
// Exact-name check of an Unreal automation report (index.json) against the
// P0 test manifest. A test that never ran is MISSING, never green.
//
//   node check-automation-report.mjs <index.json> <manifest> [--allow-fail <name>]... [--min-total <n>]
//   node check-automation-report.mjs --self-test
//
// Exit: 0 all checks pass; 1 a check failed; 2 bad usage or unreadable input.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Spec 6.2: a manifest name passes only in the state Success. UE writes warnings
// as a per-test count, never as a state, so any other state string is a failure.
const PASS_STATES = new Set(['success']);

function readManifest(text) {
  const names = [];
  const seen = new Set();
  const duplicates = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (seen.has(line)) duplicates.push(line);
    seen.add(line);
    names.push(line);
  }
  return { names, duplicates };
}

function readReport(text) {
  const root = JSON.parse(text.replace(/^﻿/, ''));
  const tests = root.tests ?? root.Tests;
  if (!Array.isArray(tests)) throw new Error('index.json has no tests[] array');
  return tests.map((t) => ({
    name: String(t.fullTestPath ?? t.FullTestPath ?? t.testDisplayName ?? t.TestDisplayName ?? ''),
    state: String(t.state ?? t.State ?? ''),
    warnings: Number(t.warnings ?? t.Warnings ?? 0) || 0,
  }));
}

function check(report, manifest, { allowFail = [], minTotal = 0 } = {}) {
  const allowed = new Set(allowFail);
  const byName = new Map(report.map((t) => [t.name, t]));
  const problems = manifest.duplicates.map((d) => `DUPLICATE in manifest: ${d}`);
  const warned = [];
  let passing = 0;
  for (const name of manifest.names) {
    if (!byName.has(name)) {
      problems.push(`MISSING: ${name}`);
      continue;
    }
    const { state, warnings } = byName.get(name);
    if (PASS_STATES.has(state.toLowerCase())) {
      passing += 1;
      if (warnings > 0) warned.push(`WARNINGS: ${name} (${warnings})`);
    } else if (!allowed.has(name)) {
      problems.push(`NOT PASSED: ${name} (${state || 'no state'})`);
    }
  }
  const listed = new Set(manifest.names);
  for (const t of report) {
    if (!listed.has(t.name) && t.state.toLowerCase() === 'fail' && !allowed.has(t.name)) {
      problems.push(`FAILED outside the manifest: ${t.name}`);
    }
  }
  if (report.length < minTotal) problems.push(`TOTAL ${report.length} is below --min-total ${minTotal}`);
  return { passing, total: report.length, problems, warned };
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'hayba-check-report-'));
  let failed = 0;
  const expect = (label, ok) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) failed += 1;
  };
  try {
    const report = readReport(
      '﻿' +
        JSON.stringify({
          Tests: [
            { FullTestPath: 'Hayba.MCP.A', State: 'Success' },
            { fullTestPath: 'Hayba.MCP.B', state: 'Success', warnings: 2 },
            { fullTestPath: 'Hayba.MCP.C', state: 'Fail' },
            { fullTestPath: 'Hayba.MCP.UI.RenderWidgetToPng', state: 'Fail' },
            { fullTestPath: 'Hayba.MCP.D', state: 'NotRun' },
            { fullTestPath: 'Hayba.MCP.E', state: 'SuccessWithWarnings' },
          ],
        }),
    );
    expect('PascalCase keys and a BOM parse', report.length === 6 && report[0].name === 'Hayba.MCP.A');
    const allow = { allowFail: ['Hayba.MCP.UI.RenderWidgetToPng', 'Hayba.MCP.C'] };
    const good = check(report, readManifest('# T0\n\nHayba.MCP.A\n# optional: Hayba.MCP.X\nHayba.MCP.B\n'), allow);
    expect('comments, blanks and optional notes are ignored', good.problems.length === 0 && good.passing === 2);
    expect('a Success test that warned passes and is listed', good.warned.length === 1 && good.warned[0] === 'WARNINGS: Hayba.MCP.B (2)');
    expect('only the state Success passes a manifest name', check(report, readManifest('Hayba.MCP.E'), allow).problems.includes('NOT PASSED: Hayba.MCP.E (SuccessWithWarnings)'));
    expect('a missing name is reported', check(report, readManifest('Hayba.MCP.Z'), allow).problems.includes('MISSING: Hayba.MCP.Z'));
    expect('a NotRun manifest name is not green', check(report, readManifest('Hayba.MCP.D'), allow).problems.some((p) => p.startsWith('NOT PASSED: Hayba.MCP.D')));
    expect('a failing manifest name is reported', check(report, readManifest('Hayba.MCP.C'), { allowFail: ['Hayba.MCP.UI.RenderWidgetToPng'] }).problems.some((p) => p.startsWith('NOT PASSED: Hayba.MCP.C')));
    expect('a failure outside the manifest is reported', check(report, readManifest('Hayba.MCP.A'), { allowFail: ['Hayba.MCP.C'] }).problems.includes('FAILED outside the manifest: Hayba.MCP.UI.RenderWidgetToPng'));
    expect('--min-total guards shrinkage', check(report, readManifest('Hayba.MCP.A'), { ...allow, minTotal: 7 }).problems.includes('TOTAL 6 is below --min-total 7'));
    expect('a duplicate manifest name is reported', check(report, readManifest('Hayba.MCP.A\nHayba.MCP.A'), allow).problems.includes('DUPLICATE in manifest: Hayba.MCP.A'));
    const file = join(dir, 'index.json');
    writeFileSync(file, JSON.stringify({ tests: [] }));
    expect('an empty report reads', readReport(readFileSync(file, 'utf8')).length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return failed === 0 ? 0 : 1;
}

function main(argv) {
  const positional = [];
  const allowFail = [];
  let minTotal = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--self-test') return selfTest();
    if (a === '--allow-fail') {
      const name = argv[++i];
      if (!name) return usage('--allow-fail needs a test name');
      allowFail.push(name);
    } else if (a === '--min-total') {
      minTotal = Number(argv[++i]);
      if (!Number.isFinite(minTotal) || minTotal < 0) return usage('--min-total needs a number');
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 2) return usage('expected <index.json> <manifest>');
  let report;
  let manifest;
  try {
    report = readReport(readFileSync(positional[0], 'utf8'));
    manifest = readManifest(readFileSync(positional[1], 'utf8'));
  } catch (err) {
    console.error(`cannot read input: ${err.message}`);
    return 2;
  }
  const result = check(report, manifest, { allowFail, minTotal });
  console.log(`report: ${positional[0]}`);
  console.log(`manifest: ${manifest.names.length} names (${result.passing} passing)`);
  console.log(`total tests in report: ${result.total}`);
  for (const w of result.warned) console.log(w);
  for (const p of result.problems) console.log(p);
  console.log(result.problems.length === 0 ? 'OK' : `FAIL (${result.problems.length} problems)`);
  return result.problems.length === 0 ? 0 : 1;
}

function usage(message) {
  console.error(`${message}\nusage: check-automation-report.mjs <index.json> <manifest> [--allow-fail <name>]... [--min-total <n>] | --self-test`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
