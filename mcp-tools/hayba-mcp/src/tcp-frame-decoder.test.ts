import { describe, it, expect } from 'vitest';
import { FrameDecoder, MAX_FRAME_BYTES } from './tcp-frame-decoder.js';

/** Build a length-prefixed frame around a string payload. */
function frame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

describe('FrameDecoder', () => {
  it('decodes a single whole frame', () => {
    const d = new FrameDecoder();
    const out = d.push(frame('hello'));
    expect(out.map(b => b.toString('utf-8'))).toEqual(['hello']);
    expect(d.pendingBytes()).toBe(0);
  });

  it('decodes multiple frames arriving in one chunk', () => {
    const d = new FrameDecoder();
    const out = d.push(Buffer.concat([frame('one'), frame('two'), frame('three')]));
    expect(out.map(b => b.toString('utf-8'))).toEqual(['one', 'two', 'three']);
  });

  it('reassembles a frame split across chunks', () => {
    const d = new FrameDecoder();
    const full = frame('reassembled payload');
    expect(d.push(full.subarray(0, 6))).toEqual([]);   // header + 2 body bytes
    expect(d.push(full.subarray(6, 11))).toEqual([]);   // more body
    const out = d.push(full.subarray(11));              // the rest
    expect(out.map(b => b.toString('utf-8'))).toEqual(['reassembled payload']);
  });

  it('holds a partial trailing frame until the rest arrives', () => {
    const d = new FrameDecoder();
    const out = d.push(Buffer.concat([frame('complete'), frame('partial').subarray(0, 5)]));
    expect(out.map(b => b.toString('utf-8'))).toEqual(['complete']);
    expect(d.pendingBytes()).toBe(5);
  });

  it('waits when fewer than 4 header bytes have arrived', () => {
    const d = new FrameDecoder();
    expect(d.push(Buffer.from([0x00, 0x00]))).toEqual([]);
    expect(d.pendingBytes()).toBe(2);
  });

  it('drops the buffer on a zero-length prefix', () => {
    const d = new FrameDecoder();
    const zero = Buffer.alloc(4); // length 0
    expect(d.push(zero)).toEqual([]);
    expect(d.pendingBytes()).toBe(0);
  });

  it('drops the buffer on an oversized length prefix', () => {
    const d = new FrameDecoder();
    const huge = Buffer.alloc(4);
    huge.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    expect(d.push(Buffer.concat([huge, Buffer.from('junk')]))).toEqual([]);
    expect(d.pendingBytes()).toBe(0);
  });

  it('returns frames decoded before a corrupt prefix in the same chunk', () => {
    const d = new FrameDecoder();
    const corrupt = Buffer.alloc(4);
    corrupt.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    const out = d.push(Buffer.concat([frame('good'), corrupt]));
    expect(out.map(b => b.toString('utf-8'))).toEqual(['good']);
    expect(d.pendingBytes()).toBe(0);
  });

  it('handles a payload exactly at the frame cap', () => {
    const d = new FrameDecoder();
    const body = Buffer.alloc(MAX_FRAME_BYTES, 0x61);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES, 0);
    const out = d.push(Buffer.concat([header, body]));
    expect(out).toHaveLength(1);
    expect(out[0].length).toBe(MAX_FRAME_BYTES);
  });

  it('reset() clears buffered partial data', () => {
    const d = new FrameDecoder();
    d.push(frame('whole'));
    d.push(frame('partial').subarray(0, 4));
    expect(d.pendingBytes()).toBeGreaterThan(0);
    d.reset();
    expect(d.pendingBytes()).toBe(0);
  });

  it('decodes byte-at-a-time delivery', () => {
    const d = new FrameDecoder();
    const full = frame('drip');
    let out: Buffer[] = [];
    for (const byte of full) out = out.concat(d.push(Buffer.from([byte])));
    expect(out.map(b => b.toString('utf-8'))).toEqual(['drip']);
  });
});
