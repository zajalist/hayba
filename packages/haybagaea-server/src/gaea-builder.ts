import { execFile } from 'child_process'
import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { generateGaeaGraph } from './ai-client.js'
import type { HaybaConfig } from './config.js'
import type { GenerateTerrainRequest, GenerateTerrainResponse } from './types.js'

const execFileAsync = promisify(execFile)
const BUILD_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

interface GaeaNode {
  id: string
  type: string
  params: Record<string, unknown>
}

interface GaeaEdge {
  from_id: string
  from_port?: number
  to_id: string
  to_port?: number
}

export async function generateTerrain(
  req: GenerateTerrainRequest,
  config: HaybaConfig
): Promise<GenerateTerrainResponse> {
  const outputFolder = req.outputFolder ?? config.defaultOutputFolder

  // 1. Generate Gaea graph from AI
  let graph: { nodes: unknown[]; edges: unknown[] }
  try {
    graph = await generateGaeaGraph(req.prompt, config)
  } catch (err) {
    return {
      id: req.id,
      ok: false,
      error: `AI error: ${err instanceof Error ? err.message : 'unknown'}`,
    }
  }

  // 2. Ensure output folder exists
  mkdirSync(outputFolder, { recursive: true })

  // 3. Write .terrain file (Gaea SwarmHost JSON format)
  const terrainPath = join(outputFolder, `hayba_${req.id}.terrain`)
  writeTerrainFile(
    terrainPath,
    graph as { nodes: GaeaNode[]; edges: GaeaEdge[] },
    outputFolder,
    req.resolution ?? 1024
  )

  // 4. Check BuildManager exists
  if (!existsSync(config.gaeaBuildManagerPath)) {
    return {
      id: req.id,
      ok: false,
      error: `Gaea.BuildManager.exe not found at: ${config.gaeaBuildManagerPath}`,
    }
  }

  // 5. Run BuildManager
  try {
    await execFileAsync(config.gaeaBuildManagerPath, [terrainPath, '--silent'], {
      timeout: BUILD_TIMEOUT_MS,
    })
  } catch (err: unknown) {
    const e = err as { killed?: boolean; stderr?: string; message?: string }
    if (e.killed) {
      return {
        id: req.id,
        ok: false,
        error: `Build timed out after ${BUILD_TIMEOUT_MS / 1000}s`,
      }
    }
    return {
      id: req.id,
      ok: false,
      error: `Gaea build failed: ${e.stderr?.slice(0, 500) ?? e.message ?? 'unknown'}`,
    }
  }

  // 6. Find heightmap output
  const heightmapPath = findHeightmap(outputFolder)
  if (!heightmapPath) {
    return {
      id: req.id,
      ok: false,
      error: `Build succeeded but no heightmap found in ${outputFolder}`,
    }
  }

  return { id: req.id, ok: true, heightmapPath }
}

function writeTerrainFile(
  path: string,
  graph: { nodes: GaeaNode[]; edges: GaeaEdge[] },
  outputFolder: string,
  resolution: number
): void {
  const terrain = {
    $type: 'Gaea.Graph.GaeaGraph, GaeaGraph',
    $id: '1',
    Nodes: graph.nodes.map((n, i) => ({
      $type: `Gaea.Nodes.${n.type}, GaeaGraph`,
      $id: String(i + 2),
      ID: n.id,
      Name: n.type,
      Primitive: true,
      XPos: i * 200,
      YPos: 0,
      ...n.params,
    })),
    Connections: graph.edges.map((e) => ({
      From: e.from_id,
      FromPort: e.from_port ?? 0,
      To: e.to_id,
      ToPort: e.to_port ?? 0,
    })),
    BuildExtend: {
      Format: 'PNG16',
      Output: outputFolder,
      Resolution: resolution,
      IsInBuildMode: true,
    },
  }

  writeFileSync(path, JSON.stringify(terrain, null, 2), 'utf8')
}

function findHeightmap(folder: string): string | undefined {
  if (!existsSync(folder)) return undefined
  const files = readdirSync(folder).filter(
    (f) => f.endsWith('.png') || f.endsWith('.r16')
  )
  if (files.length === 0) return undefined
  const sorted = files
    .map((f) => ({ name: f, mtime: statSync(join(folder, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return join(folder, sorted[0].name)
}
