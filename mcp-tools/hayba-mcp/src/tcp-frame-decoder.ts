// mcp-tools/hayba-mcp/src/tcp-frame-decoder.ts
//
// Length-prefixed frame decoder for the TCP protocol seam. Pure and
// socket-free: feed it raw chunks as they arrive, get back every complete
// message payload. It owns the receive buffer and the framing invariants
// — 4-byte big-endian length prefix, 1 MiB cap — so tcp-client.ts can stay
// a thin socket adapter and the framing logic is unit-testable in
// isolation (it never was, while it lived inside the socket callback).

/** Hard cap on a single frame. A larger declared length means the stream
 *  is corrupt and unrecoverable. */
export const MAX_FRAME_BYTES = 1024 * 1024;

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Append a freshly-received chunk and return every message payload it
   * completes (zero, one, or many). Partial trailing data is retained for
   * the next call. A corrupt length prefix (0 or > MAX_FRAME_BYTES) drops
   * the whole buffer — the stream cannot be re-synced — and any frames
   * already decoded in this call are still returned.
   */
  push(chunk: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: Buffer[] = [];

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);

      if (length === 0 || length > MAX_FRAME_BYTES) {
        this.buffer = Buffer.alloc(0);
        break;
      }
      if (this.buffer.length < 4 + length) {
        break; // frame not fully arrived yet
      }

      messages.push(this.buffer.subarray(4, 4 + length));
      this.buffer = this.buffer.subarray(4 + length);
    }
    return messages;
  }

  /** Bytes currently held pending more input — for tests and introspection. */
  pendingBytes(): number {
    return this.buffer.length;
  }

  /** Drop any buffered partial data (e.g. on socket close). */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
