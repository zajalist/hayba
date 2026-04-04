import { z } from 'zod'

export const GenerateTerrainRequestSchema = z.object({
  id: z.string(),
  command: z.literal('generate_terrain'),
  prompt: z.string().min(1),
  outputFolder: z.string().optional(),
  resolution: z.number().int().min(256).max(8192).optional().default(1024),
})

export type GenerateTerrainRequest = z.infer<typeof GenerateTerrainRequestSchema>

export interface GenerateTerrainResponse {
  id: string
  ok: boolean
  heightmapPath?: string
  error?: string
}
