export interface HaybaConfig {
  port: number
  aiProvider: 'anthropic'
  aiApiKey: string
  aiModel: string
  gaeaBuildManagerPath: string
  defaultOutputFolder: string
}

export function loadConfig(): HaybaConfig {
  const apiKey = process.env['AI_API_KEY'] ?? ''
  if (!apiKey) {
    console.error('[HaybaGaea] WARNING: AI_API_KEY not set — terrain generation will fail')
  }

  return {
    port: parseInt(process.env['HAYBA_PORT'] ?? '55558', 10),
    aiProvider: 'anthropic',
    aiApiKey: apiKey,
    aiModel: process.env['AI_MODEL'] ?? 'claude-opus-4-6-20251101',
    gaeaBuildManagerPath:
      process.env['GAEA_BUILD_MANAGER'] ??
      'C:\\Program Files\\QuadSpinner\\Gaea 2\\Gaea.BuildManager.exe',
    defaultOutputFolder:
      (process.env['HAYBA_OUTPUT'] ??
        (process.env['TEMP'] ?? 'C:\\Temp') + '\\hayba-gaea-output'),
  }
}
