import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type Status = 'resolved' | 'mitigated' | 'open' | 'external';
type EvidenceClass = 'observed' | 'reproduced' | 'inferred';

interface Threat {
  id: string;
  signature: string;
  category: string;
  evidence: {
    classification: EvidenceClass;
    kind: string;
    observed_artifact_count?: number;
    observed_distinct_signature_count?: number;
    source_refs: string[];
  };
  trigger: string;
  affected_commands: string[];
  guard_layer: string[];
  recovery: { session_health: string; action: string };
  test_evidence: { regressions: string[]; sources: string[]; runtime: string[] };
  status: Status;
}

interface Model {
  schema_version: number;
  model_id: string;
  corpus: {
    raw_artifact_count: number;
    missing_signature_artifact_count: number;
    distinct_signature_count: number;
    classification_order: string[];
    classified: Array<{
      category: string;
      threat_id: string;
      observed_artifact_count: number;
      observed_distinct_signature_count: number;
    }>;
    unclassified: {
      observed_artifact_count: number;
      observed_distinct_signature_count: number;
      opaque_signature_fingerprints: Array<{ fingerprint: string; artifacts: number }>;
      status: string;
    };
    audit_threshold: {
      max_unclassified_distinct_signatures: number;
      met: boolean;
    };
  };
  threats: Threat[];
}

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const manifestPath = join(repoRoot, 'docs', 'audit', 'crash-threat-model.json');
const reportPath = join(repoRoot, 'docs', 'audit', '2026-08-10-crash-threat-model.md');
const classifierPath = join(repoRoot, 'mcp-tools', 'hayba-mcp', 'scripts', 'audit-crash-threat-model.mjs');
const manifestText = readFileSync(manifestPath, 'utf8');
const reportText = readFileSync(reportPath, 'utf8');
const model = JSON.parse(manifestText) as Model;

const nonEmpty = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;

describe('executable editor-crash threat model', () => {
  it('uses unique stable IDs and semantic signatures', () => {
    expect(model.schema_version).toBe(1);
    expect(model.model_id).toBe('hayba-editor-crash-threats-v1');
    expect(model.threats.length).toBeGreaterThanOrEqual(10);

    const ids = model.threats.map((threat) => threat.id);
    const signatures = model.threats.map((threat) => threat.signature);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(signatures).size).toBe(signatures.length);
    for (const id of ids) expect(id).toMatch(/^HCR-[A-Z]+-\d{3}$/);
  });

  it('requires ownership, guard, recovery, evidence, and status for every class', () => {
    const statuses: Status[] = ['resolved', 'mitigated', 'open', 'external'];
    const evidenceClasses: EvidenceClass[] = ['observed', 'reproduced', 'inferred'];

    for (const threat of model.threats) {
      expect(nonEmpty(threat.signature), `${threat.id} signature`).toBe(true);
      expect(nonEmpty(threat.category), `${threat.id} category`).toBe(true);
      expect(nonEmpty(threat.trigger), `${threat.id} trigger`).toBe(true);
      expect(threat.affected_commands.length, `${threat.id} affected commands`).toBeGreaterThan(0);
      expect(threat.guard_layer.length, `${threat.id} guard layer`).toBeGreaterThan(0);
      expect(nonEmpty(threat.recovery.session_health), `${threat.id} session health`).toBe(true);
      expect(nonEmpty(threat.recovery.action), `${threat.id} recovery action`).toBe(true);
      expect(statuses, `${threat.id} status`).toContain(threat.status);
      expect(evidenceClasses, `${threat.id} evidence classification`).toContain(threat.evidence.classification);
      expect(Array.isArray(threat.test_evidence.regressions)).toBe(true);
      expect(Array.isArray(threat.test_evidence.sources)).toBe(true);
      expect(Array.isArray(threat.test_evidence.runtime)).toBe(true);
    }
  });

  it('never lets a resolved class lose its named regression and source', () => {
    for (const threat of model.threats.filter((candidate) => candidate.status === 'resolved')) {
      expect(threat.test_evidence.regressions.length, `${threat.id} regression`).toBeGreaterThan(0);
      expect(threat.test_evidence.sources.length, `${threat.id} regression source`).toBeGreaterThan(0);
      for (const regression of threat.test_evidence.regressions) {
        expect(nonEmpty(regression), `${threat.id} empty regression`).toBe(true);
        expect(regression.toLowerCase(), `${threat.id} planned regression`).not.toContain('planned');
      }
    }
  });

  it('keeps observed counts separate from reproduction and inference', () => {
    for (const threat of model.threats) {
      if (threat.evidence.classification === 'observed') {
        expect(threat.evidence.kind, threat.id).toBe('crash_corpus');
        expect(threat.evidence.observed_artifact_count, threat.id).toBeGreaterThan(0);
        expect(threat.evidence.observed_distinct_signature_count, threat.id).toBeGreaterThan(0);
      } else {
        expect(threat.evidence.observed_artifact_count, threat.id).toBeUndefined();
        expect(threat.evidence.observed_distinct_signature_count, threat.id).toBeUndefined();
      }
    }
  });

  it('reconciles classified and unknown counts without hiding the unknown tail', () => {
    const classifiedArtifacts = model.corpus.classified.reduce((sum, row) => sum + row.observed_artifact_count, 0);
    const classifiedSignatures = model.corpus.classified.reduce(
      (sum, row) => sum + row.observed_distinct_signature_count,
      0,
    );
    expect(classifiedArtifacts + model.corpus.unclassified.observed_artifact_count).toBe(
      model.corpus.raw_artifact_count,
    );
    expect(classifiedSignatures + model.corpus.unclassified.observed_distinct_signature_count).toBe(
      model.corpus.distinct_signature_count,
    );
    expect(model.corpus.missing_signature_artifact_count).toBe(0);
    expect(model.corpus.unclassified.opaque_signature_fingerprints).toHaveLength(
      model.corpus.unclassified.observed_distinct_signature_count,
    );
    for (const unknown of model.corpus.unclassified.opaque_signature_fingerprints) {
      expect(unknown.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(unknown.artifacts).toBeGreaterThan(0);
    }

    const thresholdShouldPass =
      model.corpus.unclassified.observed_distinct_signature_count <=
      model.corpus.audit_threshold.max_unclassified_distinct_signatures;
    expect(model.corpus.audit_threshold.met).toBe(thresholdShouldPass);
    if (model.corpus.unclassified.observed_distinct_signature_count > 0) {
      expect(model.corpus.unclassified.status).toBe('open');
      expect(model.corpus.audit_threshold.met).toBe(false);
    } else {
      expect(model.corpus.unclassified.status).toBe('clear');
      expect(model.corpus.audit_threshold.met).toBe(true);
    }
  });

  it('reproduces first-match deduplication without emitting private crash evidence', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'hayba-crash-model-'));
    const context = (hash: string, error: string, callStack: string, ticks: string): string => `
<FGenericCrashContext><RuntimeProperties>
<PCallStackHash>${hash}</PCallStackHash><TimeOfCrash>${ticks}</TimeOfCrash>
<CrashType>Ensure</CrashType><SecondsSinceStart>7</SecondsSinceStart>
<ErrorMessage><![CDATA[${error}]]></ErrorMessage><CallStack>${callStack}</CallStack>
<PCallStack></PCallStack><SourceContext></SourceContext>
</RuntimeProperties></FGenericCrashContext>`;
    try {
      for (const name of ['a', 'b', 'c']) mkdirSync(join(scratch, name));
      writeFileSync(
        join(scratch, 'a', 'CrashContext.runtime-xml'),
        context(
          'raw-shared-signature',
          'WidgetVariableNameToGuidMap private-asset-name',
          'UnrealEditor_UMGEditor',
          '639212698003530000',
        ),
      );
      writeFileSync(
        join(scratch, 'b', 'CrashContext.runtime-xml'),
        context(
          'raw-shared-signature',
          'SeenVariableNames second-private-asset',
          'UnrealEditor_UMGEditor',
          '639212698013530000',
        ),
      );
      writeFileSync(
        join(scratch, 'c', 'CrashContext.runtime-xml'),
        context('raw-unknown-signature', 'secret request payload', 'PrivateHostModule', '639212698023530000'),
      );
      writeFileSync(join(scratch, 'c', 'PrivateProject.log'), 'private path and secret request payload');

      const run = () => spawnSync(process.execPath, [classifierPath, '--crash-dir', scratch], { encoding: 'utf8' });
      const first = run();
      const second = run();
      expect(first.status, first.stderr).toBe(0);
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toBe(first.stdout);

      const result = JSON.parse(first.stdout) as Model['corpus'];
      expect(result.raw_artifact_count).toBe(3);
      expect(result.distinct_signature_count).toBe(2);
      expect(result.classified).toEqual([
        {
          category: 'stale-umg-guid-map',
          threat_id: 'HCR-UMG-001',
          observed_artifact_count: 2,
          observed_distinct_signature_count: 1,
        },
      ]);
      expect(result.unclassified.observed_artifact_count).toBe(1);
      expect(result.unclassified.observed_distinct_signature_count).toBe(1);
      expect(result.unclassified.opaque_signature_fingerprints[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(first.stdout).not.toContain(scratch);
      expect(first.stdout).not.toContain('raw-shared-signature');
      expect(first.stdout).not.toContain('raw-unknown-signature');
      expect(first.stdout).not.toContain('private-asset');
      expect(first.stdout).not.toContain('secret request payload');
      expect(first.stdout).not.toContain('PrivateHostModule');
      expect(first.stdout).not.toContain('PrivateProject.log');

      const privateMissingPath = join(scratch, 'private-missing-corpus');
      const failure = spawnSync(process.execPath, [classifierPath, '--crash-dir', privateMissingPath], {
        encoding: 'utf8',
      });
      expect(failure.status).toBe(2);
      expect(failure.stderr).not.toContain(privateMissingPath);
      expect(failure.stderr).not.toContain(scratch);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('maps every classified corpus row to exactly one matching observed threat', () => {
    for (const row of model.corpus.classified) {
      const matches = model.threats.filter((threat) => threat.id === row.threat_id);
      expect(matches, row.threat_id).toHaveLength(1);
      const threat = matches[0];
      expect(threat.category).toBe(row.category);
      expect(threat.evidence.classification).toBe('observed');
      expect(threat.evidence.observed_artifact_count).toBe(row.observed_artifact_count);
      expect(threat.evidence.observed_distinct_signature_count).toBe(row.observed_distinct_signature_count);
    }
  });

  it('keeps every referenced repository evidence file present', () => {
    for (const threat of model.threats) {
      const refs = [...threat.evidence.source_refs, ...threat.test_evidence.sources, ...threat.test_evidence.runtime];
      for (const ref of refs) {
        expect(ref, `${threat.id} relative evidence path`).not.toMatch(/^(?:[A-Za-z]:[\\/]|\/)/);
        expect(existsSync(join(repoRoot, ref)), `${threat.id}: ${ref}`).toBe(true);
      }
    }
  });

  it('does not commit host paths, crash IDs, identity fields, or raw context payloads', () => {
    const publicAudit = `${manifestText}\n${reportText}`;
    expect(publicAudit).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(publicAudit).not.toMatch(/(?:\/Users\/|\\Users\\)/i);
    expect(publicAudit).not.toMatch(/UECC-(?:Windows|Mac|Linux)-[A-F0-9_-]+/i);
    expect(publicAudit).not.toMatch(/"(?:MachineId|LoginId|EpicAccountId|UserName|CommandLine)"\s*:/i);
    expect(publicAudit).not.toContain('CrashContext.runtime-xml');
  });

  it('ships the deterministic classifier and documents its drift check', () => {
    expect(existsSync(classifierPath)).toBe(true);
    expect(reportText).toContain('audit-crash-threat-model.mjs');
    expect(reportText).toContain('--check-manifest docs/audit/crash-threat-model.json');
    const source = readFileSync(classifierPath, 'utf8');
    for (const category of model.corpus.classification_order) expect(source).toContain(`category: '${category}'`);
    expect(source).toContain("createHash('sha256')");
    expect(source).not.toContain('MachineId');
    expect(source).not.toContain('LoginId');
    expect(source).not.toContain('EpicAccountId');
  });
});
