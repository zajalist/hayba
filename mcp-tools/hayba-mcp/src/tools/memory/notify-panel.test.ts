import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const executeCommandMock = vi.fn();
vi.mock('../tool-executor.js', () => ({
  executeCommand: (...args: unknown[]) => executeCommandMock(...(args as [])),
}));

const { notifyMemoryPanel, resetMemoryPanelWarning } = await import('./notify-panel.js');

beforeEach(() => {
  executeCommandMock.mockReset();
  executeCommandMock.mockResolvedValue({});
  resetMemoryPanelWarning();
});

afterEach(() => vi.restoreAllMocks());

describe('telling the Memory panel the store changed', () => {
  it('nudges the panel to re-read', () => {
    notifyMemoryPanel();

    const [cmd, params] = executeCommandMock.mock.calls[0]!;
    expect(cmd).toBe('ui_memory_set');
    // The panel reads the store itself. This is a nudge, not a payload.
    expect(params).toEqual({});
  });

  it('does not make the caller wait', () => {
    // A memory write must not be slowed by an editor, or by one not being
    // there. notifyMemoryPanel returns nothing to await.
    expect(notifyMemoryPanel()).toBeUndefined();
  });

  it('does not fail a write when no editor is attached', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    executeCommandMock.mockRejectedValueOnce(new Error('No sender configured'));

    expect(() => notifyMemoryPanel()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));

    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toMatch(/Writes are still stored/);
  });

  it('says it once, not on every write', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    executeCommandMock.mockRejectedValue(new Error('No sender configured'));

    for (let i = 0; i < 5; i++) notifyMemoryPanel();
    await new Promise((r) => setTimeout(r, 0));

    // Headless use is normal. One line explains it; five per write is a wall
    // of noise that trains people to ignore the log.
    expect(warn).toHaveBeenCalledOnce();
  });
});
