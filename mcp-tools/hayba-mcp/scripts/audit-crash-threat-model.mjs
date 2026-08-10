#!/usr/bin/env node

// Deterministic, privacy-preserving classifier for Unreal CrashContext files.
//
// It deliberately emits aggregates and one-way fingerprints only. Error text,
// call stacks, crash GUIDs, paths, user/project names and request payloads never
// leave the local process. Rules use stable engine assertions/modules instead
// of artifact directory names, timestamps or machine-specific addresses.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WINDOWS_EPOCH_TICKS = 621355968000000000n;

const RULES = [
  {
    category: 'stale-umg-guid-map',
    threat_id: 'HCR-UMG-001',
    test: (evidence) =>
      /WidgetVariableNameToGuidMap|SeenVariableNames|Ensure condition failed: WidgetProperty/.test(evidence),
  },
  {
    category: 'pie-teardown-reference',
    threat_id: 'HCR-PIE-001',
    test: (evidence) =>
      /from PIE level still referenced|!NewPIEWorld->bIsWorldInitialized|!bIsWorldInitialized/.test(evidence),
  },
  {
    category: 'transaction-buffer-pie-retention',
    threat_id: 'HCR-TRANS-001',
    test: (evidence) => /is being referenced by TransBuffer/.test(evidence),
  },
  {
    category: 'unsafe-automation-execution',
    threat_id: 'HCR-AUTO-001',
    test: (evidence) => /(?:Test\.cpp|Test::RunTest|TestHandler|Automation|GIsAutomationTesting)/i.test(evidence),
  },
  {
    category: 'rhi-render-teardown',
    threat_id: 'HCR-RHI-001',
    test: (evidence) => /D3D12|FD3D12DynamicRHI|UnrealEditor_RHI/i.test(evidence),
  },
  {
    category: 'illegal-constructor-helper',
    threat_id: 'HCR-CTOR-001',
    test: (evidence) => /FObjectFinders can't be used outside of constructors/.test(evidence),
  },
  {
    category: 'security-audit-reentrancy',
    threat_id: 'HCR-SEH-001',
    test: (evidence, incidentLog) =>
      /FHaybaMCPSecurityManager::HashParams/.test(evidence) ||
      (/EXCEPTION_ACCESS_VIOLATION/.test(evidence) &&
        /^UnrealEditor_Core\s+UnrealEditor_Core[\s\S]*UnrealEditor_Engine[\s\S]*UnrealEditor_UnrealEd/m.test(
          evidence,
        ) &&
        /FObjectFinders can't be used outside of constructors/.test(incidentLog) &&
        /SEH guard caught a structured exception in handler for command 'level_load'[\s\S]*Processing command: ping/.test(
          incidentLog,
        )),
  },
  {
    category: 'dynamic-delegate-bind-failure',
    threat_id: 'HCR-DELEG-001',
    test: (evidence) => /Ensure condition failed: this->IsBound\(\).*Unable to bind delegate/s.test(evidence),
  },
  {
    category: 'slate-runtime-collection-corruption',
    threat_id: 'HCR-SLATE-001',
    test: (evidence) =>
      /OwnerTable->Private_IsPendingRefresh|TileViewT<ItemType>.*detected a critical error/s.test(evidence) ||
      (/EXCEPTION_ACCESS_VIOLATION/.test(evidence) && /UnrealEditor_(?:Slate|SlateCore)/.test(evidence)),
  },
  {
    category: 'abstract-data-asset-instantiation',
    threat_id: 'HCR-DATA-001',
    test: (evidence) => /Class which was marked abstract was trying to be loaded/.test(evidence),
  },
  {
    category: 'asynchronous-import-pipeline-fault',
    threat_id: 'HCR-IMPORT-001',
    test: (evidence) => /UnrealEditor_(?:Fab|InterchangeImport|InterchangeEngine)/.test(evidence),
  },
  {
    category: 'pie-object-class-mismatch',
    threat_id: 'HCR-PIETYPE-001',
    test: (evidence) => /Assertion failed: Ret->IsA\(T::StaticClass\(\)\)/.test(evidence),
  },
];

function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tag(xml, name) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? decodeXml(match[1]).trim() : '';
}

function collectContexts(directory) {
  const result = [];
  const visit = (current) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = resolve(current, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name === 'CrashContext.runtime-xml') result.push(child);
    }
  };
  visit(directory);
  return result;
}

function ticksToIso(raw) {
  if (!/^\d+$/.test(raw)) return null;
  const ticks = BigInt(raw);
  if (ticks < WINDOWS_EPOCH_TICKS) return null;
  return new Date(Number((ticks - WINDOWS_EPOCH_TICKS) / 10000n)).toISOString();
}

function fingerprint(signature) {
  return createHash('sha256').update(`hayba-crash-signature-v1\0${signature}`).digest('hex');
}

function readIncidentLogs(context) {
  const logs = readdirSync(dirname(context), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.log'))
    .sort((a, b) => a.name.localeCompare(b.name));
  return logs.map((entry) => readFileSync(resolve(dirname(context), entry.name), 'utf8')).join('\n');
}

function safeUnclassifiedEvidence(context, xml) {
  const safeEngineFamilies = new Set([
    'Core',
    'CoreUObject',
    'Engine',
    'UnrealEd',
    'Slate',
    'SlateCore',
    'RHI',
    'D3D12RHI',
    'RenderCore',
    'kernel32',
    'ntdll',
  ]);
  const moduleFamilies = [];
  for (const raw of tag(xml, 'CallStack').split(/\r?\n/)) {
    const candidate = raw.trim().replace(/^UnrealEditor[_-]?/, '');
    if (!/^[A-Za-z0-9]+$/.test(candidate)) continue;
    const family = safeEngineFamilies.has(candidate) ? candidate : 'other';
    if (moduleFamilies.includes(family)) continue;
    moduleFamilies.push(family);
    if (moduleFamilies.length === 5) break;
  }
  const secondsRaw = tag(xml, 'SecondsSinceStart');
  const crashTypeRaw = tag(xml, 'CrashType');
  return {
    crash_type: /^(?:Crash|Ensure|Assert|Stall)$/.test(crashTypeRaw) ? crashTypeRaw : 'unknown',
    seconds_since_start: /^\d+$/.test(secondsRaw) ? Number(secondsRaw) : null,
    top_module_families: moduleFamilies,
    sibling_log_present: readdirSync(dirname(context), { withFileTypes: true }).some(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.log'),
    ),
    attribution_blocker: 'no deterministic rule matched the available sanitized CrashContext evidence',
  };
}

function classifyCrashContexts(directory) {
  const contexts = collectContexts(directory);
  const bySignature = new Map();
  const times = [];
  let missingSignatureArtifactCount = 0;

  for (const context of contexts) {
    const xml = readFileSync(context, 'utf8');
    const signature = tag(xml, 'PCallStackHash');
    const time = ticksToIso(tag(xml, 'TimeOfCrash'));
    if (time) times.push(time);
    if (!signature) {
      missingSignatureArtifactCount += 1;
      continue;
    }

    // Only the fields needed by semantic rules enter memory. None are emitted.
    const evidence = [
      tag(xml, 'ErrorMessage'),
      tag(xml, 'CallStack'),
      tag(xml, 'PCallStack'),
      tag(xml, 'SourceContext'),
    ].join('\n');
    // One historical post-SEH crash is only attributable in the incident log:
    // its final CrashContext is unsymbolicated. Read logs locally, but never
    // retain or print them. All other rules are CrashContext-only.
    const incidentLog = readIncidentLogs(context);
    const matched = RULES.find((rule) => rule.test(evidence, incidentLog));
    const classification = matched ? { category: matched.category, threat_id: matched.threat_id } : null;
    const prior = bySignature.get(signature);
    if (prior && JSON.stringify(prior.classification) !== JSON.stringify(classification)) {
      throw new Error('one engine stack signature produced conflicting semantic classifications');
    }
    if (prior) prior.artifacts += 1;
    else {
      bySignature.set(signature, {
        artifacts: 1,
        classification,
        unclassified_evidence: classification ? null : safeUnclassifiedEvidence(context, xml),
      });
    }
  }

  const categoryMap = new Map();
  const unclassified = [];
  for (const [signature, group] of bySignature) {
    if (!group.classification) {
      unclassified.push({
        fingerprint: fingerprint(signature),
        artifacts: group.artifacts,
        ...group.unclassified_evidence,
      });
      continue;
    }
    const key = `${group.classification.category}\0${group.classification.threat_id}`;
    const aggregate = categoryMap.get(key) ?? {
      category: group.classification.category,
      threat_id: group.classification.threat_id,
      observed_artifact_count: 0,
      observed_distinct_signature_count: 0,
    };
    aggregate.observed_artifact_count += group.artifacts;
    aggregate.observed_distinct_signature_count += 1;
    categoryMap.set(key, aggregate);
  }

  const classified = RULES.map((rule) => categoryMap.get(`${rule.category}\0${rule.threat_id}`)).filter(Boolean);
  unclassified.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  return {
    evidence_window: {
      start_utc: times.length ? [...times].sort()[0] : null,
      end_utc: times.length ? [...times].sort().at(-1) : null,
    },
    raw_artifact_count: contexts.length,
    missing_signature_artifact_count: missingSignatureArtifactCount,
    deduplication_key: 'CrashContext.RuntimeProperties.PCallStackHash',
    distinct_signature_count: bySignature.size,
    classification_order: RULES.map((rule) => rule.category),
    classified,
    unclassified: {
      observed_artifact_count: unclassified.reduce((sum, row) => sum + row.artifacts, 0),
      observed_distinct_signature_count: unclassified.length,
      opaque_signature_fingerprints: unclassified,
    },
  };
}

function parseArguments(argv) {
  const args = { crashDir: '', manifest: '' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--crash-dir') args.crashDir = argv[++index] ?? '';
    else if (argv[index] === '--check-manifest') args.manifest = argv[++index] ?? '';
    else throw new Error('unknown argument');
  }
  if (!args.crashDir)
    throw new Error('usage: audit-crash-threat-model.mjs --crash-dir <Saved/Crashes> [--check-manifest <json>]');
  return args;
}

function comparableCorpus(value) {
  return {
    evidence_window: value.evidence_window,
    raw_artifact_count: value.raw_artifact_count,
    missing_signature_artifact_count: value.missing_signature_artifact_count ?? 0,
    deduplication_key: value.deduplication_key,
    distinct_signature_count: value.distinct_signature_count,
    classification_order: value.classification_order,
    classified: value.classified,
    unclassified: {
      observed_artifact_count: value.unclassified.observed_artifact_count,
      observed_distinct_signature_count: value.unclassified.observed_distinct_signature_count,
      opaque_signature_fingerprints: value.unclassified.opaque_signature_fingerprints,
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArguments(process.argv.slice(2));
    if (!existsSync(args.crashDir)) throw new Error('crash directory does not exist');
    const result = classifyCrashContexts(resolve(args.crashDir));
    if (args.manifest) {
      const manifest = JSON.parse(readFileSync(args.manifest, 'utf8'));
      const expected = comparableCorpus(manifest.corpus);
      const actual = comparableCorpus(result);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        process.stderr.write('crash threat model manifest drifted from the classified corpus\n');
        process.exitCode = 1;
      }
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    // Filesystem/parser errors often embed the absolute input path or a snippet
    // of malformed XML/JSON. Even failure output stays privacy-preserving.
    const rawCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const safeCode = /^[A-Z0-9_-]+$/.test(rawCode) ? rawCode : 'INVALID_INPUT';
    process.stderr.write(`crash threat model audit failed: ${safeCode}\n`);
    process.exitCode = 2;
  }
}

export { RULES, classifyCrashContexts };
