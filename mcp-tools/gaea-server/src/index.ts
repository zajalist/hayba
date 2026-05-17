import net from 'net'
import { loadConfig } from './config.js'
import { GenerateTerrainRequestSchema, type GenerateTerrainResponse } from './types.js'
import { generateTerrain } from './gaea-builder.js'

const config = loadConfig()

const server = net.createServer((socket) => {
  console.log('[HaybaGaea] Client connected:', socket.remoteAddress)

  const buffers: Buffer[] = []
  let bufferedLength = 0

  socket.on('data', async (chunk) => {
    buffers.push(chunk)
    bufferedLength += chunk.length

    while (bufferedLength >= 4) {
      const header = Buffer.concat(buffers)
      const msgLen = header.readUInt32LE(0)

      if (bufferedLength < 4 + msgLen) break

      const full = Buffer.concat(buffers)
      const msgStr = full.slice(4, 4 + msgLen).toString('utf8')
      const remaining = full.slice(4 + msgLen)
      buffers.length = 0
      if (remaining.length > 0) buffers.push(remaining)
      bufferedLength = remaining.length

      let response: GenerateTerrainResponse
      try {
        const raw = JSON.parse(msgStr)
        const parsed = GenerateTerrainRequestSchema.safeParse(raw)

        if (!parsed.success) {
          response = {
            id: (raw as Record<string, unknown>)?.id as string ?? 'unknown',
            ok: false,
            error: `Invalid request: ${parsed.error.message}`,
          }
        } else {
          response = await generateTerrain(parsed.data, config)
        }
      } catch (err) {
        response = {
          id: 'unknown',
          ok: false,
          error: `Server error: ${err instanceof Error ? err.message : 'unknown'}`,
        }
      }

      const responseStr = JSON.stringify(response)
      const responseBytes = Buffer.from(responseStr, 'utf8')
      const out = Buffer.alloc(4 + responseBytes.length)
      out.writeUInt32LE(responseBytes.length, 0)
      responseBytes.copy(out, 4)
      socket.write(out)
    }
  })

  socket.on('close', () => console.log('[HaybaGaea] Client disconnected'))
  socket.on('error', (err) => console.error('[HaybaGaea] Socket error:', err.message))
})

server.listen(config.port, '127.0.0.1', () => {
  console.log(`[HaybaGaea] TCP server listening on 127.0.0.1:${config.port}`)
})
