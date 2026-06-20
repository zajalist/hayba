import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { upsertLesson, loadLessons, getLesson, removeLesson, validateLesson, setLessonsPath } from './index.js';

describe('lesson store', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lesson-')); setLessonsPath(join(dir, 'lessons.json')); });
  afterEach(() => { setLessonsPath(null); rmSync(dir, { recursive: true, force: true }); });

  it('upserts, gets, lists and removes a lesson', () => {
    const r = upsertLesson({ slug: 'gianttree-pivot', title: 'GiantTree pivot offset', body: 'Pivot sits +380 above the base.', refs: ['/Game/SM_GiantTree_01'] }, 'now');
    expect(r.ok).toBe(true);
    expect(getLesson('gianttree-pivot')!.title).toBe('GiantTree pivot offset');
    expect(loadLessons().length).toBe(1);
    expect(removeLesson('gianttree-pivot')).toBe(true);
    expect(getLesson('gianttree-pivot')).toBe(null);
  });

  it('records updated_at on upsert', () => {
    upsertLesson({ slug: 'x', title: 't', body: 'b' }, '2026-06-20T00:00:00Z');
    expect(getLesson('x')!.updated_at).toBe('2026-06-20T00:00:00Z');
  });

  it('rejects a bad slug and missing fields', () => {
    expect(validateLesson({ slug: 'Bad Slug!', title: 't', body: 'b' }).some(e => e.field === 'slug')).toBe(true);
    expect(validateLesson({ slug: 'ok' }).some(e => e.field === 'title')).toBe(true);
    expect(validateLesson({ slug: 'ok', title: 't' }).some(e => e.field === 'body')).toBe(true);
    expect(upsertLesson({ slug: 'Bad!', title: 't', body: 'b' } as never, 'now').ok).toBe(false);
  });
});
