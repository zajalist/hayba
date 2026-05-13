import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sendMock = vi.fn();

vi.mock('../../tcp-client.js', () => ({
  ensureConnected: vi.fn(async () => ({ send: sendMock })),
}));

import { editorGetPerfStatsHandler } from './editor-get-perf-stats.js';
import { textureAuditHandler } from './texture-audit.js';
import { meshAuditHandler } from './mesh-audit.js';

describe('perf telemetry tools', () => {
  beforeEach(() => sendMock.mockReset());
  afterEach(() => sendMock.mockReset());

  it('editor_get_perf_stats forwards sample_frames and returns UE payload', async () => {
    sendMock.mockResolvedValueOnce({ ok: true, data: { frame_ms: 12.3, draw_calls: 1500, triangles: 3_000_000, memory_mb: 2200 } });
    const r = await editorGetPerfStatsHandler({ sample_frames: 60 }, {});
    expect(r.isError).toBeFalsy();
    expect(sendMock).toHaveBeenCalledWith('editor_get_perf_stats', { sample_frames: 60 }, 10_000);
    expect(JSON.parse(r.content[0].text).frame_ms).toBe(12.3);
  });

  it('editor_get_perf_stats clamps sample_frames > 120 via validation', async () => {
    const r = await editorGetPerfStatsHandler({ sample_frames: 999 }, {});
    expect(r.isError).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('texture_audit forwards all filters', async () => {
    sendMock.mockResolvedValueOnce({ ok: true, data: { items: [] } });
    await textureAuditHandler({ top_n: 10, min_kb: 500, path_prefix: '/Game/Env/' }, {});
    expect(sendMock).toHaveBeenCalledWith(
      'texture_audit',
      { top_n: 10, min_kb: 500, path_prefix: '/Game/Env/' },
      30_000,
    );
  });

  it('texture_audit surfaces TCP failure as isError', async () => {
    sendMock.mockResolvedValueOnce({ ok: false, error: 'not connected' });
    const r = await textureAuditHandler({}, {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/texture_audit failed: not connected/);
  });

  it('mesh_audit forwards include_lod_issues', async () => {
    sendMock.mockResolvedValueOnce({ ok: true, data: { items: [{ path: '/Game/A', triangles: 200_000, lod_count: 1 }] } });
    const r = await meshAuditHandler({ top_n: 5, include_lod_issues: true }, {});
    expect(r.isError).toBeFalsy();
    expect(sendMock).toHaveBeenCalledWith(
      'mesh_audit',
      { top_n: 5, include_lod_issues: true },
      30_000,
    );
  });

  it('mesh_audit maps thrown exception to isError', async () => {
    sendMock.mockRejectedValueOnce(new Error('socket closed'));
    const r = await meshAuditHandler({}, {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/mesh_audit error: socket closed/);
  });
});
