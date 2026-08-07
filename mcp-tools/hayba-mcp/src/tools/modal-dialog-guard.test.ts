import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the C++ handlers against raising modal dialogs.
//
// This is the most expensive failure mode in the plugin and the least
// diagnosable. Handlers run on the editor's game thread, so a modal dialog
// blocks the thread that would send the reply: the command never completes, the
// caller times out, and every later request queues behind it until a human
// notices the box and clicks it. Nothing is written to the log — from the
// agent's side the editor has simply stopped answering.
//
// It was hit live: ui_create_widget on an existing name raised "Overwrite
// Existing Object" and took the whole connection down.
//
// IAssetTools::CreateAsset prompts on a name collision rather than failing, so
// every call site must check the name first. This test fails when a new one
// appears without that check.

const __dirname = dirname(fileURLToPath(import.meta.url));
const HANDLER_DIR = join(
  __dirname, '..', '..', '..', '..',
  'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private', 'handlers',
);

function handlerSources(): Array<{ file: string; text: string }> {
  return readdirSync(HANDLER_DIR)
    .filter((f) => f.endsWith('.cpp'))
    .map((f) => ({ file: f, text: readFileSync(join(HANDLER_DIR, f), 'utf-8') }));
}

/** Strip line and block comments so a mention in prose is not a call. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('handlers must not be able to raise a modal dialog', () => {
  it('finds the handler sources', () => {
    expect(handlerSources().length).toBeGreaterThan(10);
  });

  it('guards every CreateAsset call site with a name-collision check', () => {
    const offenders: string[] = [];

    for (const { file, text } of handlerSources()) {
      const code = stripComments(text);
      // AssetCreated() is the asset-registry notification, not a creation call.
      const createCalls = (code.match(/\bCreateAsset\s*\(/g) ?? []).length;
      if (createCalls === 0) continue;

      const guards = (code.match(/HaybaAssetGuard::AssetNameTaken\s*\(/g) ?? []).length;
      if (guards < createCalls) {
        offenders.push(`${file}: ${createCalls} CreateAsset call(s) but only ${guards} name guard(s)`);
      }
    }

    expect(
      offenders,
      'A CreateAsset call without a HaybaAssetGuard::AssetNameTaken check can raise a modal\n' +
        'overwrite dialog, which blocks the game thread and hangs every queued MCP request:\n  ' +
        offenders.join('\n  '),
    ).toEqual([]);
  });

  it('never calls a blocking message dialog directly', () => {
    const offenders: string[] = [];
    // FMessageDialog and AddModalWindow block until dismissed. Neither belongs
    // on a code path a remote caller can reach.
    const banned = /\bFMessageDialog::|AddModalWindow\s*\(/;

    for (const { file, text } of handlerSources()) {
      const code = stripComments(text);
      if (banned.test(code)) offenders.push(file);
    }

    expect(
      offenders,
      `these handlers open a blocking dialog, which no remote-invoked code may do: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('the shared guard checks memory as well as the asset registry', () => {
    // An asset created earlier in the same session and not yet saved is absent
    // from the registry but still collides — which is exactly the case an agent
    // hits when it retries a call it believes failed.
    const guard = readFileSync(
      join(
        __dirname, '..', '..', '..', '..',
        'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Public', 'HaybaMCPAssetGuard.h',
      ),
      'utf-8',
    );
    expect(guard).toMatch(/GetAssetByObjectPath/);
    expect(guard).toMatch(/FindObject<UObject>/);
  });
});
