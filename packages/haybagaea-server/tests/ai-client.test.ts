import { describe, it, expect, vi } from 'vitest'

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: vi.fn().mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              nodes: [
                { id: 'n1', type: 'Mountain', params: { Seed: 42 } },
                { id: 'n2', type: 'Autolevel', params: {} },
              ],
              edges: [{ from_id: 'n1', from_port: 0, to_id: 'n2', to_port: 0 }],
            }),
          },
        ],
      }),
    }
  },
}))

import { generateGaeaGraph } from '../src/ai-client.js'

describe('generateGaeaGraph', () => {
  const config = {
    port: 55558,
    aiProvider: 'anthropic' as const,
    aiApiKey: 'test-key',
    aiModel: 'claude-opus-4-6-20251101',
    gaeaBuildManagerPath: 'C:\\fake\\Gaea.BuildManager.exe',
    defaultOutputFolder: 'C:\\Temp\\test-output',
  }

  it('returns nodes and edges from Claude response', async () => {
    const graph = await generateGaeaGraph('a simple mountain', config)
    expect(graph.nodes).toHaveLength(2)
    expect(graph.edges).toHaveLength(1)
    expect((graph.nodes[0] as { type: string }).type).toBe('Mountain')
  })
})
