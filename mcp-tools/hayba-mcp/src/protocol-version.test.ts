import { describe, it, expect } from 'vitest';
import { checkProtocol, HAYBA_PROTOCOL_VERSION } from './protocol-version.js';

describe('protocol compatibility', () => {
  it('accepts a peer speaking the same version', () => {
    expect(checkProtocol(HAYBA_PROTOCOL_VERSION).compatible).toBe(true);
  });

  it('names the plugin when the plugin is behind', () => {
    const r = checkProtocol(HAYBA_PROTOCOL_VERSION - 1);
    expect(r.compatible).toBe(false);
    expect(r.advice).toMatch(/Update the plugin/);
    // The symptom is what makes skew hard to recognise, so the advice says it.
    expect(r.advice).toMatch(/one command at a time/);
  });

  it('names the server when the server is behind', () => {
    const r = checkProtocol(HAYBA_PROTOCOL_VERSION + 1);
    expect(r.advice).toMatch(/Update the npm server/);
  });

  it('treats a missing version as a mismatch', () => {
    // Only a plugin predating this field stays silent, and that IS old.
    expect(checkProtocol(null).compatible).toBe(false);
    expect(checkProtocol(null).advice).toMatch(/predates this check/);
  });

  it('does not accept a nonsense value as agreement', () => {
    expect(checkProtocol(Number.NaN).compatible).toBe(false);
  });
});
