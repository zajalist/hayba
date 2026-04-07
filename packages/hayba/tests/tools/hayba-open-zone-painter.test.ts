import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openZonePainterHandler } from '../../src/tools/hayba-open-zone-painter.js';

const TEST_BASE = join(homedir(), '.hayba', 'projects-painter-test-' + Date.now());

describe('hayba_open_zone_painter', () => {
  afterEach(() => {
    if (existsSync(TEST_BASE)) rmSync(TEST_BASE, { recursive: true, force: true });
  });

  it('creates a new project when projectId is omitted', async () => {
    const result = await openZonePainterHandler({ projectName: 'New Scene' }, TEST_BASE);
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.url).toMatch(/^https?:\/\//);
    expect(typeof data.projectId).toBe('string');
  });

  it('uses existing project when projectId is provided', async () => {
    const first = await openZonePainterHandler({ projectName: 'My Scene' }, TEST_BASE);
    const { projectId } = JSON.parse(first.content[0].text);

    const second = await openZonePainterHandler({ projectId }, TEST_BASE);
    const data = JSON.parse(second.content[0].text);
    expect(data.projectId).toBe(projectId);
  });

  it('returns error when projectId provided but project does not exist', async () => {
    const result = await openZonePainterHandler({ projectId: 'nonexistent' }, TEST_BASE);
    expect(result.isError).toBe(true);
  });
});
