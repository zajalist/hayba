import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeCommandMock = vi.fn();
vi.mock('../tool-executor.js', () => ({
  executeCommand: (...args: unknown[]) => executeCommandMock(...(args as [])),
}));

const { buildTraceScript, parseTraceOutput, conformToGround } =
  await import('./terrain-conform.js');

beforeEach(() => executeCommandMock.mockReset());

describe('the trace script', () => {
  // These assertions pin the API shape that four separate wrong guesses were
  // corrected to against a live editor. They are here so the next edit cannot
  // quietly regress to a spelling that raises at runtime.
  const script = buildTraceScript([[0, 0], [100, 200]], 0);

  it('reaches the editor world the way that actually works', () => {
    expect(script).toContain('unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem)');
    // unreal.EditorSubsystemLibrary does not exist.
    expect(script).not.toContain('EditorSubsystemLibrary');
  });

  it('reads the hit through to_dict', () => {
    // A HitResult has no .impact_point attribute, and
    // get_editor_property('impact_point') raises.
    // The script is JSON-escaped into an exec(), so the quotes arrive escaped.
    expect(script).toContain('hit.to_dict()');
    expect(script).toContain('impact_point');
  });

  it('grounds on the surface, not the trace epsilon above it', () => {
    // `location` sits a fraction above the surface; impact_point is the
    // surface. Grounding on `location` leaves everything slightly floating.
    expect(script).not.toContain('location');
  });

  it('carries every point and traces from above to below', () => {
    expect(script).toContain('[[0,0],[100,200]]');
    expect(script).toContain('0 + 10000');
    expect(script).toContain('0 - 50000');
  });
});

describe('reading the result back', () => {
  it('finds the payload among other output', () => {
    const hits = parseTraceOutput(
      'LogPython: some noise\nHAYBA_GROUND_JSON:[[0,0,50],[10,0,null]]\nmore noise',
    );
    expect(hits).toEqual([{ x: 0, y: 0, z: 50 }, { x: 10, y: 0, z: null }]);
  });

  it('returns null rather than guessing when the marker is absent', () => {
    expect(parseTraceOutput('nothing useful here')).toBeNull();
  });

  it('returns null on a truncated payload', () => {
    expect(parseTraceOutput('HAYBA_GROUND_JSON:[[0,0,50],')).toBeNull();
  });
});

describe('conformToGround', () => {
  it('returns the ground under each point', async () => {
    executeCommandMock.mockResolvedValue({
      ok: true, stdout: 'HAYBA_GROUND_JSON:[[0,0,50.0],[1000,0,450.0]]',
    });

    const r = await conformToGround([[0, 0], [1000, 0]], 0);

    expect(r.unavailable).toBeUndefined();
    expect(r.hits.map((h) => h.z)).toEqual([50, 450]);
  });

  it('traces the whole set in one call', async () => {
    executeCommandMock.mockResolvedValue({
      ok: true, stdout: 'HAYBA_GROUND_JSON:[[0,0,1],[1,0,1],[2,0,1],[3,0,1]]',
    });

    await conformToGround([[0, 0], [1, 0], [2, 0], [3, 0]], 0);

    // Forty instances must not be forty round-trips to the game thread.
    expect(executeCommandMock).toHaveBeenCalledTimes(1);
  });

  it('says it could not run rather than reporting flat ground', async () => {
    executeCommandMock.mockRejectedValueOnce(new Error('no editor'));

    const r = await conformToGround([[0, 0]], 0);

    // The dangerous failure is silence: a caller that cannot tell "not
    // conformed" from "conformed and flat" will place everything at one height
    // and believe it is grounded.
    expect(r.unavailable).toMatch(/no editor/);
    expect(r.hits).toEqual([]);
  });

  it('rejects a result that does not cover every point', async () => {
    executeCommandMock.mockResolvedValue({ ok: true, stdout: 'HAYBA_GROUND_JSON:[[0,0,50]]' });

    const r = await conformToGround([[0, 0], [1, 0]], 0);

    // Mismatched lengths would silently shift every z onto the wrong point.
    expect(r.unavailable).toMatch(/1 result\(s\) for 2 point\(s\)/);
  });

  it('reports a failed script instead of treating it as no ground', async () => {
    executeCommandMock.mockResolvedValue({ ok: false, stderr: 'AttributeError: nope' });

    const r = await conformToGround([[0, 0]], 0);

    expect(r.unavailable).toMatch(/AttributeError/);
  });

  it('does not call the editor for an empty set', async () => {
    const r = await conformToGround([], 0);
    expect(r.hits).toEqual([]);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });
});
