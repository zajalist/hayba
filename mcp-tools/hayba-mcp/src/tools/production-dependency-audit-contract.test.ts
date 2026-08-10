import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface Assessment {
  finding_key: string;
  package: string;
  advisory: string;
  severity: string;
  installed_versions: string[];
  importing_feature: string;
  reachability: string;
  decision: string;
  mitigation: string;
  owner: string;
  tracking_issue: string;
  reviewed_on: string;
  expires_on: string;
  evidence: string[];
}

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const script = join(repoRoot, 'mcp-tools', 'hayba-mcp', 'scripts', 'audit-production-dependencies.mjs');
const ciWorkflow = join(repoRoot, '.github', 'workflows', 'ci.yml');
const scheduledWorkflow = join(repoRoot, '.github', 'workflows', 'production-dependency-audit.yml');
const productionInventory = join(repoRoot, 'docs', 'audit', 'production-dependency-assessments.json');
const mcpPackage = join(repoRoot, 'mcp-tools', 'hayba-mcp', 'package.json');
const rootLock = join(repoRoot, 'package-lock.json');
const tempDirs: string[] = [];

const advisory = {
  source: 1234567,
  name: 'leaf-package',
  severity: 'high',
  title: 'SENSITIVE RAW ADVISORY PROSE',
  url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
};

function assessment(overrides: Partial<Assessment> = {}): Assessment {
  return {
    finding_key: 'root-package|GHSA-aaaa-bbbb-cccc',
    package: 'root-package',
    advisory: 'GHSA-aaaa-bbbb-cccc',
    severity: 'high',
    installed_versions: ['1.2.3'],
    importing_feature: 'Fixture production feature',
    reachability: 'unreachable_code_path',
    decision: 'time_bounded_exception',
    mitigation: 'The fixture path does not call the affected parser.',
    owner: 'Security maintainers',
    tracking_issue: '#380',
    reviewed_on: '2026-08-10',
    expires_on: '2026-08-17',
    evidence: ['fixture/source.ts:1'],
    ...overrides,
  };
}

function run(options: {
  audit?: Record<string, unknown>;
  assessments?: Assessment[];
  today?: string;
  lock?: Record<string, unknown>;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'hayba-production-audit-'));
  tempDirs.push(dir);
  const auditPath = join(dir, 'audit.json');
  const inventoryPath = join(dir, 'inventory.json');
  const lockPath = join(dir, 'package-lock.json');
  writeFileSync(
    auditPath,
    JSON.stringify(
      options.audit ?? {
        metadata: { vulnerabilities: { high: 1 }, dependencies: { prod: 1, dev: 99 } },
        vulnerabilities: { 'root-package': { severity: 'high', via: [advisory] } },
      },
    ),
  );
  writeFileSync(
    inventoryPath,
    JSON.stringify({ schema_version: 1, assessments: options.assessments ?? [assessment()] }),
  );
  writeFileSync(
    lockPath,
    JSON.stringify(
      options.lock ?? {
        lockfileVersion: 3,
        packages: { 'node_modules/root-package': { version: '1.2.3' } },
      },
    ),
  );
  return spawnSync(
    process.execPath,
    [
      script,
      '--audit-fixture',
      auditPath,
      '--inventory',
      inventoryPath,
      '--lockfile',
      lockPath,
      '--today',
      options.today ?? '2026-08-10',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('production dependency reachability gate', () => {
  it('accepts a reviewed exception through its inclusive expiry date', () => {
    const result = run({ today: '2026-08-17' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('production dependency audit: PASS');
  });

  it('blocks a new or unassessed high advisory', () => {
    const result = run({ assessments: [] });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('PDA-UNASSESSED-HIGH root-package|GHSA-aaaa-bbbb-cccc');
  });

  it('blocks an expired exception', () => {
    const result = run({ today: '2026-08-18' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('PDA-EXPIRED root-package|GHSA-aaaa-bbbb-cccc');
  });

  it.each([
    ['missing owner', { owner: '' }],
    ['invalid review date', { reviewed_on: '10/08/2026' }],
    ['missing evidence', { evidence: [] }],
    ['bad tracking issue', { tracking_issue: 'security someday' }],
    ['mismatched key', { finding_key: 'some-other-package|GHSA-aaaa-bbbb-cccc' }],
  ])('blocks malformed policy: %s', (_name, overrides) => {
    const result = run({ assessments: [assessment(overrides)] });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('PDA-MALFORMED');
  });

  it('caps an exception at 30 days', () => {
    const result = run({ assessments: [assessment({ expires_on: '2026-09-10' })] });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('PDA-EXCEPTION-TOO-LONG root-package|GHSA-aaaa-bbbb-cccc');
  });

  it('blocks version drift instead of reusing evidence for a different release', () => {
    const result = run({
      lock: { lockfileVersion: 3, packages: { 'node_modules/root-package': { version: '2.0.0' } } },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('PDA-VERSION-DRIFT root-package|GHSA-aaaa-bbbb-cccc');
  });

  it('resolves transitive via chains per importing package', () => {
    const result = run({
      audit: {
        vulnerabilities: {
          'root-package': { severity: 'high', via: ['leaf-package'] },
          'leaf-package': { severity: 'high', via: [advisory] },
        },
      },
      assessments: [
        assessment(),
        assessment({
          finding_key: 'leaf-package|GHSA-aaaa-bbbb-cccc',
          package: 'leaf-package',
          installed_versions: ['4.5.6'],
        }),
      ],
      lock: {
        lockfileVersion: 3,
        packages: {
          'node_modules/root-package': { version: '1.2.3' },
          'node_modules/leaf-package': { version: '4.5.6' },
        },
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('finding_paths: 2');
  });

  it('does not let dev dependency counts enter the production lane', () => {
    const result = run({
      audit: {
        metadata: { vulnerabilities: { high: 0 }, dependencies: { prod: 1, dev: 500 } },
        vulnerabilities: {},
      },
      assessments: [],
      lock: { lockfileVersion: 3, packages: {} },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('finding_paths: 0');

    const source = readFileSync(script, 'utf8');
    expect(source).toContain("['audit', '--omit=dev', '--json']");
    expect(source).not.toContain('--audit-level');
  });

  it('never echoes raw npm advisory prose', () => {
    const result = run({ assessments: [] });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain(advisory.title);
    expect(result.stdout).not.toContain(advisory.url);
    expect(result.stdout).not.toContain('node_modules');
  });

  it('rejects an unsafe audit identifier without reflecting it', () => {
    const unsafePackage = 'evil\n```\nraw-secret';
    const result = run({
      audit: { vulnerabilities: { [unsafePackage]: { severity: 'high', via: [advisory] } } },
      assessments: [],
      lock: { lockfileVersion: 3, packages: {} },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('PDA-UNRESOLVED UNSAFE-PACKAGE-NAME');
    expect(result.stdout).not.toContain('raw-secret');
    expect(result.stdout).not.toContain('```');
  });

  it('wires the same gate into CI and one scheduled tracking issue', () => {
    const ci = readFileSync(ciWorkflow, 'utf8');
    const scheduled = readFileSync(scheduledWorkflow, 'utf8');
    expect(ci).toContain('npm ci --ignore-scripts');
    expect(ci).not.toMatch(/^\s*run: npm install\s*$/m);
    expect(ci).toContain('npm run audit:production');
    expect(scheduled).toContain('schedule:');
    expect(scheduled).toContain("title='[security] Production dependency audit drift'");
    expect(scheduled).toContain('gh issue edit');
    expect(scheduled).toContain('gh issue create');
    expect(scheduled).toContain('gh issue close');
  });

  it('removes the local Transformers backend and its vulnerable production graph', () => {
    const packageJson = JSON.parse(readFileSync(mcpPackage, 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const inventory = JSON.parse(readFileSync(productionInventory, 'utf8')) as {
      assessments: Assessment[];
    };
    const lock = JSON.parse(readFileSync(rootLock, 'utf8')) as {
      packages: Record<string, { version?: string }>;
    };

    expect(packageJson.dependencies).not.toHaveProperty('@huggingface/transformers');
    expect(inventory.assessments).toEqual([]);
    for (const dependency of ['@huggingface/transformers', 'adm-zip', 'onnxruntime-node', 'sharp']) {
      expect(Object.keys(lock.packages)).not.toContain(`node_modules/${dependency}`);
    }
  });
});
