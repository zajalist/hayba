// Regression test for the sidecar/cpp/wrapper invariants. If this test
// fails locally it's the same failure the CI step (npm run
// lint:legacy-wrappers) would surface — fix the sidecar, the cpp, or
// the TS wrapper rather than the test.
//
// We import the .mjs script directly via createRequire so we don't have
// to ship a typings file just for the lint helper.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, '..', 'check-legacy-wrappers.mjs');

// Dynamic import so we get fresh module bindings per test.
async function loadCheck(): Promise<{
  runLegacyWrapperCheck: (opts?: {
    sidecarPath?: string;
    cppPath?: string;
    toolsRoot?: string;
  }) => {
    ok: boolean;
    violations: string[];
    cppCommandCount: number;
    sidecarCommandCount: number;
  };
}> {
  // pathToFileURL avoids Windows backslash mishaps in ESM dynamic imports.
  return (await import(pathToFileURL(SCRIPT_PATH).href)) as never;
}

describe('lint:legacy-wrappers', () => {
  it('passes on the real repo: sidecar covers every cpp command and wrapper flags match reality', async () => {
    const { runLegacyWrapperCheck } = await loadCheck();
    const res = runLegacyWrapperCheck();
    expect(res.violations, res.violations.join('\n')).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.cppCommandCount).toBeGreaterThan(0);
    expect(res.sidecarCommandCount).toBe(res.cppCommandCount);
  });

  it('flags [missing-sidecar] when a cpp command has no sidecar entry', async () => {
    const { runLegacyWrapperCheck } = await loadCheck();
    const tmp = mkdtempSync(join(tmpdir(), 'hayba-lint-'));
    try {
      // Sidecar with no commands at all.
      const sidecarPath = join(tmp, 'sidecar.json');
      writeFileSync(sidecarPath, JSON.stringify({ version: 1, commands: {} }));
      // Synthetic cpp with a one-entry dispatch table.
      const cppPath = join(tmp, 'fake.cpp');
      writeFileSync(
        cppPath,
        `TArray<FString> FHaybaMCPLegacyHandler::GetCommands() const\n{\n    return {\n        TEXT("ping"),\n    };\n}\n`,
      );
      // Empty tools tree.
      const toolsRoot = join(tmp, 'tools');
      mkdirSync(toolsRoot, { recursive: true });
      const res = runLegacyWrapperCheck({ sidecarPath, cppPath, toolsRoot });
      expect(res.ok).toBe(false);
      expect(res.violations.some((v) => v.startsWith('[missing-sidecar]'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('flags [stale-flag] when an executeCommand call exists for a has_ts_wrapper:false entry', async () => {
    const { runLegacyWrapperCheck } = await loadCheck();
    const tmp = mkdtempSync(join(tmpdir(), 'hayba-lint-'));
    try {
      const sidecarPath = join(tmp, 'sidecar.json');
      writeFileSync(
        sidecarPath,
        JSON.stringify({
          version: 1,
          commands: {
            wizard_chat: {
              handler_cpp: 'X',
              params: [],
              returns: { shape: 'object' },
              agent_callable: false,
              has_ts_wrapper: false,
            },
          },
        }),
      );
      const cppPath = join(tmp, 'fake.cpp');
      writeFileSync(
        cppPath,
        `TArray<FString> FHaybaMCPLegacyHandler::GetCommands() const\n{\n    return { TEXT("wizard_chat") };\n}\n`,
      );
      const toolsRoot = join(tmp, 'tools');
      mkdirSync(toolsRoot, { recursive: true });
      // Synthetic wrapper file that DOES call wizard_chat — should trip
      // the stale-flag lint since the sidecar says no wrapper exists.
      writeFileSync(
        join(toolsRoot, 'fake-wrapper.ts'),
        `import { executeCommand } from './x';\nexport async function r() { return executeCommand('wizard_chat', {}); }\n`,
      );
      const res = runLegacyWrapperCheck({ sidecarPath, cppPath, toolsRoot });
      expect(res.ok).toBe(false);
      expect(res.violations.some((v) => v.startsWith('[stale-flag]'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('flags [missing-wrapper] when has_ts_wrapper:true but no call exists', async () => {
    const { runLegacyWrapperCheck } = await loadCheck();
    const tmp = mkdtempSync(join(tmpdir(), 'hayba-lint-'));
    try {
      const sidecarPath = join(tmp, 'sidecar.json');
      writeFileSync(
        sidecarPath,
        JSON.stringify({
          version: 1,
          commands: {
            ghost_command: {
              handler_cpp: 'X',
              params: [],
              returns: { shape: 'object' },
              agent_callable: true,
              has_ts_wrapper: true,
            },
          },
        }),
      );
      const cppPath = join(tmp, 'fake.cpp');
      writeFileSync(
        cppPath,
        `TArray<FString> FHaybaMCPLegacyHandler::GetCommands() const\n{\n    return { TEXT("ghost_command") };\n}\n`,
      );
      const toolsRoot = join(tmp, 'tools');
      mkdirSync(toolsRoot, { recursive: true });
      const res = runLegacyWrapperCheck({ sidecarPath, cppPath, toolsRoot });
      expect(res.ok).toBe(false);
      expect(res.violations.some((v) => v.startsWith('[missing-wrapper]'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('treats *.test.ts files as not satisfying the wrapper requirement', async () => {
    const { runLegacyWrapperCheck } = await loadCheck();
    const tmp = mkdtempSync(join(tmpdir(), 'hayba-lint-'));
    try {
      const sidecarPath = join(tmp, 'sidecar.json');
      writeFileSync(
        sidecarPath,
        JSON.stringify({
          version: 1,
          commands: {
            need_real_wrapper: {
              handler_cpp: 'X',
              params: [],
              returns: { shape: 'object' },
              agent_callable: true,
              has_ts_wrapper: true,
            },
          },
        }),
      );
      const cppPath = join(tmp, 'fake.cpp');
      writeFileSync(
        cppPath,
        `TArray<FString> FHaybaMCPLegacyHandler::GetCommands() const\n{\n    return { TEXT("need_real_wrapper") };\n}\n`,
      );
      const toolsRoot = join(tmp, 'tools');
      mkdirSync(toolsRoot, { recursive: true });
      // Only a test file references it — should NOT count.
      writeFileSync(
        join(toolsRoot, 'fake.test.ts'),
        `executeCommand('need_real_wrapper', {});\n`,
      );
      const res = runLegacyWrapperCheck({ sidecarPath, cppPath, toolsRoot });
      expect(res.ok).toBe(false);
      expect(res.violations.some((v) => v.startsWith('[missing-wrapper]'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// Quiet TS about unused imports in this file (used reflectively above).
void createRequire;
void cpSync;
void readFileSync;
