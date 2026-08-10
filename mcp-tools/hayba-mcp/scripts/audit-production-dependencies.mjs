#!/usr/bin/env node

/* global process */

// Production dependency policy for #380.
//
// The live path invokes `npm audit --omit=dev --json` itself. That makes the
// production-only scope part of the executable policy instead of a convention
// a workflow author can accidentally omit. Raw npm output is parsed in memory
// and never printed; reports contain stable package/advisory keys and policy
// codes only.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DEFAULT_INVENTORY = resolve(REPO_ROOT, 'docs', 'audit', 'production-dependency-assessments.json');
const DEFAULT_LOCKFILE = resolve(REPO_ROOT, 'package-lock.json');
const BLOCKING_SEVERITIES = new Set(['critical', 'high']);
const ALLOWED_REACHABILITY = new Set(['reachable', 'install_time_only', 'unreachable_code_path']);
const ALLOWED_DECISIONS = new Set(['temporary_blocking_exception', 'time_bounded_exception']);
const MAX_TEXT = 500;
const MAX_EXCEPTION_DAYS = 30;

function parseArgs(argv) {
  const out = {
    inventory: DEFAULT_INVENTORY,
    lockfile: DEFAULT_LOCKFILE,
    auditFixture: null,
    today: new Date().toISOString().slice(0, 10),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--inventory' && next) {
      out.inventory = resolve(next);
      i += 1;
    } else if (arg === '--lockfile' && next) {
      out.lockfile = resolve(next);
      i += 1;
    } else if (arg === '--audit-fixture' && next) {
      out.auditFixture = resolve(next);
      i += 1;
    } else if (arg === '--today' && next) {
      out.today = next;
      i += 1;
    } else {
      throw new Error('PDA-USAGE');
    }
  }
  return out;
}

function readJson(path, code) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(code);
  }
}

function runProductionAudit() {
  // npm scripts expose the exact npm-cli entry point. Invoking it through the
  // current Node binary avoids Windows' inability to spawn a .cmd shim without
  // a command shell (and avoids quoting user-controlled shell text).
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : 'npm';
  const args = npmExecPath ? [npmExecPath, 'audit', '--omit=dev', '--json'] : ['audit', '--omit=dev', '--json'];
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  // npm exits non-zero when findings exist; valid JSON is the authority.
  if (result.error || !result.stdout) throw new Error('PDA-AUDIT-UNAVAILABLE');
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('PDA-AUDIT-MALFORMED');
  }
}

function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function safeText(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_TEXT) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) <= 0x1f) return false;
  }
  return true;
}

function isPackageName(value) {
  return (
    typeof value === 'string' &&
    value.length <= 214 &&
    /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(value)
  );
}

function isAdvisory(value) {
  return typeof value === 'string' && /^(?:GHSA-[A-Za-z0-9-]+|NPM-\d+)$/.test(value);
}

function daysBetween(start, end) {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
}

function advisoryId(via) {
  const urlMatch = typeof via.url === 'string' ? /\/advisories\/(GHSA-[A-Za-z0-9-]+)\/?$/.exec(via.url) : null;
  if (urlMatch) return urlMatch[1];
  if (Number.isSafeInteger(via.source) && via.source > 0) return `NPM-${via.source}`;
  return null;
}

function leavesFor(packageName, vulnerabilities, seen = new Set()) {
  if (seen.has(packageName)) return { leaves: [], unresolved: true };
  const entry = vulnerabilities[packageName];
  if (!entry || !Array.isArray(entry.via)) return { leaves: [], unresolved: true };
  const nextSeen = new Set(seen).add(packageName);
  const leaves = [];
  let unresolved = false;
  for (const via of entry.via) {
    if (typeof via === 'string') {
      const nested = leavesFor(via, vulnerabilities, nextSeen);
      leaves.push(...nested.leaves);
      unresolved ||= nested.unresolved;
    } else if (via && typeof via === 'object') {
      const id = advisoryId(via);
      if (!id) unresolved = true;
      else leaves.push({ advisory: id, advisoryPackage: String(via.name ?? packageName) });
    } else {
      unresolved = true;
    }
  }
  const unique = new Map(leaves.map((leaf) => [`${leaf.advisory}\0${leaf.advisoryPackage}`, leaf]));
  return { leaves: [...unique.values()], unresolved };
}

function installedVersions(lockfile, packageName) {
  const suffix = `node_modules/${packageName}`;
  const versions = new Set();
  for (const [path, value] of Object.entries(lockfile.packages ?? {})) {
    if ((path === suffix || path.endsWith(`/${suffix}`)) && safeText(value?.version)) versions.add(value.version);
  }
  return [...versions].sort();
}

function currentFindings(audit, lockfile) {
  const vulnerabilities = audit?.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== 'object' || Array.isArray(vulnerabilities)) {
    throw new Error('PDA-AUDIT-SHAPE');
  }
  const findings = [];
  const unresolved = [];
  for (const packageName of Object.keys(vulnerabilities).sort()) {
    if (!isPackageName(packageName)) {
      unresolved.push('UNSAFE-PACKAGE-NAME');
      continue;
    }
    const entry = vulnerabilities[packageName];
    const severity = String(entry?.severity ?? '').toLowerCase();
    if (!['critical', 'high', 'moderate', 'low', 'info'].includes(severity)) {
      unresolved.push(`${packageName}|INVALID-SEVERITY`);
      continue;
    }
    const resolved = leavesFor(packageName, vulnerabilities);
    if (resolved.unresolved || resolved.leaves.length === 0) unresolved.push(`${packageName}|UNRESOLVED-CHAIN`);
    for (const leaf of resolved.leaves) {
      findings.push({
        key: `${packageName}|${leaf.advisory}`,
        package: packageName,
        advisory: leaf.advisory,
        advisoryPackage: leaf.advisoryPackage,
        severity,
        installedVersions: installedVersions(lockfile, packageName),
      });
    }
  }
  return {
    findings: [...new Map(findings.map((finding) => [finding.key, finding])).values()].sort((a, b) =>
      a.key.localeCompare(b.key),
    ),
    unresolved: [...new Set(unresolved)].sort(),
  };
}

function validateInventory(inventory, today) {
  const errors = [];
  if (inventory?.schema_version !== 1 || !Array.isArray(inventory?.assessments)) {
    return { errors: ['PDA-INVENTORY-SHAPE'], assessments: new Map() };
  }
  const assessments = new Map();
  for (const [index, item] of inventory.assessments.entries()) {
    const key = safeText(item?.finding_key) ? item.finding_key : `assessment[${index}]`;
    const fields = [
      item?.package,
      item?.advisory,
      item?.severity,
      item?.importing_feature,
      item?.reachability,
      item?.mitigation,
      item?.owner,
      item?.tracking_issue,
      item?.reviewed_on,
      item?.expires_on,
      item?.decision,
    ];
    const versionsValid =
      Array.isArray(item?.installed_versions) &&
      item.installed_versions.length > 0 &&
      item.installed_versions.every(safeText) &&
      new Set(item.installed_versions).size === item.installed_versions.length;
    const evidenceValid = Array.isArray(item?.evidence) && item.evidence.length > 0 && item.evidence.every(safeText);
    const keyValid = item?.finding_key === `${item?.package}|${item?.advisory}`;
    const identifierValid = isPackageName(item?.package) && isAdvisory(item?.advisory);
    const enumValid =
      BLOCKING_SEVERITIES.has(item?.severity) &&
      ALLOWED_REACHABILITY.has(item?.reachability) &&
      ALLOWED_DECISIONS.has(item?.decision);
    const issueValid = /^#\d+$/.test(item?.tracking_issue ?? '');
    const dateValid = isDate(item?.reviewed_on) && isDate(item?.expires_on) && item.reviewed_on <= item.expires_on;
    if (
      !fields.every(safeText) ||
      !versionsValid ||
      !evidenceValid ||
      !keyValid ||
      !identifierValid ||
      !enumValid ||
      !issueValid ||
      !dateValid
    ) {
      errors.push(`PDA-MALFORMED assessment[${index}]`);
      continue;
    }
    if (assessments.has(key)) {
      errors.push(`PDA-DUPLICATE ${key}`);
      continue;
    }
    if (item.reviewed_on > today) errors.push(`PDA-FUTURE-REVIEW ${key}`);
    if (item.expires_on < today) errors.push(`PDA-EXPIRED ${key}`);
    if (daysBetween(item.reviewed_on, item.expires_on) > MAX_EXCEPTION_DAYS) {
      errors.push(`PDA-EXCEPTION-TOO-LONG ${key}`);
    }
    assessments.set(key, item);
  }
  return { errors, assessments };
}

function evaluate(audit, inventory, lockfile, today) {
  if (!isDate(today)) return { errors: ['PDA-TODAY-MALFORMED'], warnings: [], findings: [] };
  const inventoryResult = validateInventory(inventory, today);
  const current = currentFindings(audit, lockfile);
  const errors = [...inventoryResult.errors, ...current.unresolved.map((key) => `PDA-UNRESOLVED ${key}`)];
  const warnings = [];
  const currentKeys = new Set(current.findings.map((finding) => finding.key));
  for (const finding of current.findings) {
    const assessment = inventoryResult.assessments.get(finding.key);
    if (!BLOCKING_SEVERITIES.has(finding.severity)) {
      if (!assessment) warnings.push(`PDA-NONBLOCKING-UNASSESSED ${finding.key}`);
      continue;
    }
    if (!assessment) {
      errors.push(`PDA-UNASSESSED-HIGH ${finding.key}`);
      continue;
    }
    if (assessment.severity !== finding.severity) errors.push(`PDA-SEVERITY-DRIFT ${finding.key}`);
    if (JSON.stringify([...assessment.installed_versions].sort()) !== JSON.stringify(finding.installedVersions)) {
      errors.push(`PDA-VERSION-DRIFT ${finding.key}`);
    }
  }
  for (const key of inventoryResult.assessments.keys()) {
    if (!currentKeys.has(key)) errors.push(`PDA-STALE-ASSESSMENT ${key}`);
  }
  return { errors: [...new Set(errors)].sort(), warnings: [...new Set(warnings)].sort(), findings: current.findings };
}

function render(result, fixture) {
  const lines = [
    `production dependency audit: ${result.errors.length === 0 ? 'PASS' : 'FAIL'}`,
    `scope: production (${fixture ? 'deterministic fixture' : 'npm audit --omit=dev'})`,
    `finding_paths: ${result.findings.length}`,
    `errors: ${result.errors.length}`,
    `warnings: ${result.warnings.length}`,
  ];
  if (result.errors.length) lines.push('', ...result.errors.map((error) => `- ${error}`));
  if (result.warnings.length) lines.push('', ...result.warnings.map((warning) => `- ${warning}`));
  return `${lines.join('\n')}\n`;
}

export { currentFindings, evaluate, render, runProductionAudit, validateInventory };

try {
  const options = parseArgs(process.argv.slice(2));
  const audit = options.auditFixture
    ? readJson(options.auditFixture, 'PDA-AUDIT-FIXTURE-MALFORMED')
    : runProductionAudit();
  const inventory = readJson(options.inventory, 'PDA-INVENTORY-UNREADABLE');
  const lockfile = readJson(options.lockfile, 'PDA-LOCKFILE-UNREADABLE');
  const result = evaluate(audit, inventory, lockfile, options.today);
  process.stdout.write(render(result, Boolean(options.auditFixture)));
  process.exitCode = result.errors.length === 0 ? 0 : 1;
} catch (error) {
  const code = error instanceof Error && /^PDA-[A-Z-]+$/.test(error.message) ? error.message : 'PDA-INTERNAL';
  process.stdout.write(`production dependency audit: FAIL\nscope: unavailable\nerrors: 1\n\n- ${code}\n`);
  process.exitCode = 1;
}
