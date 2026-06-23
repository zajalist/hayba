import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../tool-executor.js', () => ({
  executeCommand: vi.fn(async () => ({ comment_id: 'MaterialExpressionComment_0' })),
}));

import { executeCommand } from '../tool-executor.js';
import { materialSetCommentHandler } from './material-set-comment.js';

describe('material_set_comment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards material_set_comment with the edited fields', async () => {
    const r = await materialSetCommentHandler({ material_path: '/Game/M', comment_id: 'MaterialExpressionComment_0', node_pos: [100, 200], text: 'SOOT' });
    expect(executeCommand).toHaveBeenCalledWith('material_set_comment', expect.objectContaining({ comment_id: 'MaterialExpressionComment_0', node_pos: [100, 200] }));
    expect(r.isError).toBeFalsy();
  });

  it('rejects missing comment_id', async () => {
    const r = await materialSetCommentHandler({ material_path: '/Game/M' });
    expect(r.isError).toBe(true);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('rejects when neither material_path nor function_path given', async () => {
    const r = await materialSetCommentHandler({ comment_id: 'X', text: 'y' });
    expect(r.isError).toBe(true);
  });
});
