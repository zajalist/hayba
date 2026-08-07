import { z } from 'zod';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RichToolResult, SessionManager } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';


export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['gpu_load'],
  when: 'the agent needs to see the current scene visually',
  not_when: 'you only need actor positions — use actor_list or scene_export',
};

export const schema = z.object({
  width: z.number().int().optional().default(1280),
  height: z.number().int().optional().default(720),
});

/**
 * Detect the image mime type from the leading bytes of a base64 payload.
 * The UE handler currently encodes JPEG, but PNG is detected too so this
 * survives a future encoder change without silently mislabeling the block.
 */
function detectMime(b64: string): string {
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('iVBOR')) return 'image/png';
  // Fallback — UE handler historically returns JPEG.
  return 'image/jpeg';
}

export const editorCaptureViewportHandler = async (
  args: Record<string, unknown>,
  _session?: SessionManager,
): Promise<RichToolResult> => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  try {
    // The UE handler returns { image_base64, width, height, camera, ... }.
    // Historically this was serialized as one giant text block whose base64
    // string was then length-capped by the transport layer — destroying every
    // screenshot. Split the payload: the image goes in a proper MCP image
    // content block (never truncated as text), metadata stays a small text
    // block. See docs/handoffs/HANDOFF-mcp-agent-ergonomics-postmortem.md (P0).
    const data = await executeCommand<Record<string, unknown>>(
      'editor_capture_viewport',
      parsed.data as Record<string, unknown>,
    );
    const { image_base64, ...metaFields } = data as { image_base64?: unknown } & Record<string, unknown>;

    if (typeof image_base64 !== 'string' || image_base64.length === 0) {
      // No image payload — surface whatever came back so failures stay visible.
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }

    const mimeType = detectMime(image_base64);
    const content: RichToolResult['content'] = [
      { type: 'image', data: image_base64, mimeType },
      { type: 'text', text: JSON.stringify(metaFields, null, 2) },
    ];

    // Opt-in fallback for clients/pipelines that cannot render inline image
    // blocks: also spill the decoded image to a temp file and return its path.
    if (process.env.HAYBA_CAPTURE_TO_FILE) {
      try {
        const dir = join(tmpdir(), 'hayba-captures');
        mkdirSync(dir, { recursive: true });
        const ext = mimeType === 'image/png' ? 'png' : 'jpg';
        const file = join(dir, `viewport-${Date.now()}.${ext}`);
        writeFileSync(file, Buffer.from(image_base64, 'base64'));
        content.push({ type: 'text', text: `capture_file: ${file}` });
      } catch (e) {
        content.push({ type: 'text', text: `capture_file spill failed: ${e instanceof Error ? e.message : String(e)}` });
      }
    }

    return { content };
  } catch (e: unknown) {
    return { content: [{ type: 'text', text: `editor_capture_viewport error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
};
