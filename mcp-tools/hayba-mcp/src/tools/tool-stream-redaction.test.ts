import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { wrapToolHandlerForStream } from './tool-stream-mirror.js';

describe('MCP + Tool Stream final redaction boundary', () => {
  it('returns one redacted MCP result without mutating the handler-owned value', async () => {
    const owned = {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: 'Authorization: Bearer SENTINEL_RESULT_123456',
            mandatory_recovery: 'Rotate the credential, reconnect, and retry.',
          }),
        },
      ],
      isError: true,
    };
    const handler: (params: unknown) => Promise<typeof owned> = async (_params: unknown) => owned;
    const wrapped = wrapToolHandlerForStream('secret_probe', handler);
    const result = (await wrapped({ apiKey: 'SENTINEL_PARAM' })) as typeof owned & { _meta?: unknown };

    expect(JSON.stringify(result)).not.toContain('SENTINEL');
    expect(JSON.stringify(result)).toContain('mandatory_recovery');
    expect(result._meta).toBeDefined();
    expect(owned.content[0]!.text).toContain('SENTINEL_RESULT');
    expect(wrapToolHandlerForStream('secret_probe', wrapped)).toBe(wrapped);
  });

  it('redacts thrown errors while preserving useful recovery prose', async () => {
    const handler: (params: unknown) => Promise<never> = async (_params: unknown) => {
      throw new Error('apiKey=SENTINEL_THROW; reconnect after rotating it');
    };
    const wrapped = wrapToolHandlerForStream('throw_probe', handler);
    const error = await wrapped({}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('SENTINEL_THROW');
    expect((error as Error).message).toContain('reconnect after rotating it');
  });

  it('routes native Tool Stream errors through the final envelope redactor', () => {
    const handler = readFileSync(
      fileURLToPath(
        new URL(
          '../../../../unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCommandHandler.cpp',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    const recordBoundary = handler.slice(
      handler.indexOf('// Push to Tool Stream'),
      handler.indexOf('// Send response'),
    );

    expect(handler).toContain('const FString EffectiveError = BoundFailureDiagnostic(');
    expect(recordBoundary).toContain('StreamError->SetStringField(TEXT("error"), EffectiveError)');
    expect(recordBoundary).toContain('ResultStr = JsonToString(StreamError)');
    expect(recordBoundary).not.toContain('FString::Printf(TEXT("ERROR: %s")');
  });

  it('does not trust raw TCP mirror strings or native journal errors', () => {
    const nativeRoot = '../../../../unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/';
    const commandHandler = readFileSync(
      fileURLToPath(new URL(`${nativeRoot}HaybaMCPCommandHandler.cpp`, import.meta.url)),
      'utf8',
    );
    const securityManager = readFileSync(
      fileURLToPath(new URL(`${nativeRoot}HaybaMCPSecurityManager.cpp`, import.meta.url)),
      'utf8',
    );
    const rawMirrorBoundary = commandHandler.slice(
      commandHandler.indexOf('if (Cmd == TEXT("ui_tool_stream"))'),
      commandHandler.indexOf('// Plan Mode safety gate'),
    );
    const journalBoundary = securityManager.slice(securityManager.indexOf('void FHaybaMCPSecurityManager::Journal'));

    expect(rawMirrorBoundary).toContain('HaybaMCPSecretRedaction::Redact(MirrorText)');
    expect(rawMirrorBoundary.indexOf('HaybaMCPSecretRedaction::Redact(MirrorText)')).toBeLessThan(
      rawMirrorBoundary.indexOf('M->RecordToolCall(TName, PStr, RStr)'),
    );
    expect(journalBoundary).toContain('HaybaMCPSecretRedaction::Redact(JournalText)');
    expect(journalBoundary).not.toContain('FString SafeError = Entry.ErrorMessage');
  });
});
