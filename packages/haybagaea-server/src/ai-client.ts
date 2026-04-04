import Anthropic from '@anthropic-ai/sdk'
import type { HaybaConfig } from './config.js'

const GAEA_SYSTEM_PROMPT = `You are a Gaea 2 terrain expert. When given a terrain description,
respond with ONLY a valid JSON object (no markdown) in this exact format:

{
  "nodes": [
    {"id": "n1", "type": "Mountain", "params": {"Seed": 42, "Scale": 0.5}},
    {"id": "n2", "type": "Erosion2", "params": {"Downcutting": 0.3}}
  ],
  "edges": [
    {"from_id": "n1", "from_port": 0, "to_id": "n2", "to_port": 0}
  ]
}

Available node types: Mountain, MountainSide, Ridge, Perlin, MultiFractal, Voronoi,
Range, Crater, Rugged, RadialGradient, Erosion2, EasyErosion, ThermalShaper,
FractalTerraces, Roughen, Height, Slope, Adjust, Autolevel, Deflate, Fold,
Curvature, Clamp, Blur, Invert, Combine, Transform, Snow, Snowfield, Glacier,
Weathering, SatMap, SuperColor.

Always end with an Autolevel node connected to the last processing node.
Use 3-6 nodes for a good terrain. Keep it focused and coherent.`

export async function generateGaeaGraph(
  prompt: string,
  config: HaybaConfig
): Promise<{ nodes: unknown[]; edges: unknown[] }> {
  const client = new Anthropic({ apiKey: config.aiApiKey })

  const message = await client.messages.create({
    model: config.aiModel,
    max_tokens: 2048,
    system: GAEA_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : ''

  const cleaned = text.replace(/^```json?\s*/m, '').replace(/\s*```$/m, '').trim()

  try {
    const graph = JSON.parse(cleaned) as { nodes: unknown[]; edges: unknown[] }
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
      throw new Error('Graph missing nodes or edges array')
    }
    return graph
  } catch (err) {
    throw new Error(
      `Failed to parse Claude response as Gaea graph: ${err instanceof Error ? err.message : 'unknown'}\nRaw: ${cleaned.slice(0, 200)}`
    )
  }
}
