import { describe, it, expect, vi, beforeAll } from 'vitest'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import os from 'os'

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) =>
    cb(null, '', '')
  ),
}))

vi.mock('../src/ai-client.js', () => ({
  generateGaeaGraph: vi.fn().mockResolvedValue({
    nodes: [
      { id: 'n1', type: 'Mountain', params: { Seed: 1 } },
      { id: 'n2', type: 'Autolevel', params: {} },
    ],
    edges: [{ from_id: 'n1', from_port: 0, to_id: 'n2', to_port: 0 }],
  }),
}))

const tmpDir = join(os.tmpdir(), 'hayba-test-' + Date.now())

beforeAll(() => {
  mkdirSync(tmpDir, { recursive: true })
  writeFileSync(join(tmpDir, 'Autolevel.png'), Buffer.alloc(100))
})

import { generateTerrain } from '../src/gaea-builder.js'

const config = {
  port: 55558,
  aiProvider: 'anthropic' as const,
  aiApiKey: 'key',
  aiModel: 'claude-opus-4-6-20251101',
  gaeaBuildManagerPath: join(tmpDir, 'fake-manager.exe'),
  defaultOutputFolder: tmpDir,
}

describe('generateTerrain', () => {
  it('returns ok with heightmapPath when build succeeds', async () => {
    // Fake BuildManager existence
    writeFileSync(config.gaeaBuildManagerPath, '')

    const res = await generateTerrain(
      { id: 'test1', command: 'generate_terrain', prompt: 'mountain', resolution: 1024 },
      config
    )
    expect(res.ok).toBe(true)
    expect(res.heightmapPath).toContain('Autolevel.png')
  })
})
