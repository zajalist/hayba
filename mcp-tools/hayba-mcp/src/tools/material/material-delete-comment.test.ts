import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../tool-executor.js', () => ({
  executeCommand: vi.fn(async () => ({ deleted: true })),
}));

import { executeCommand } from '../tool-executor.js';
import { materialDeleteCommentHandler } from './material-delete-comment.js';

describe('material_delete_comment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards material_delete_comment with material_path + comment_id', async () => {
    const r = await materialDeleteCommentHandler({ material_path: '/Game/M', comment_id: 'MaterialExpressionComment_0' });
    expect(executeCommand).toHaveBeenCalledWith('material_delete_comment', expect.objectContaining({ comment_id: 'MaterialExpressionComment_0' }));
    expect(r.isError).toBeFalsy();
  });

  it('rejects missing comment_id', async () => {
    const r = await materialDeleteCommentHandler({ material_path: '/Game/M' });
    expect(r.isError).toBe(true);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('rejects when neither material_path nor function_path given', async () => {
    const r = await materialDeleteCommentHandler({ comment_id: 'X' });
    expect(r.isError).toBe(true);
  });
});
