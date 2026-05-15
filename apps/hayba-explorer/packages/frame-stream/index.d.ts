// Type declarations for @hayba/frame-stream.
// Hand-written because the canonical module is plain JS (so viz/ can load it
// via `<script type="module">` with no build step).

export const TAGS: Readonly<Record<string, number>>;

export function dequantizeTemperatureK(q: number): number;
export function dequantizeUnit(q: number): number;
export function dequantizeRiverFlow(q: number): number;
export function decodeFloat16(u: number): number;

export class ByteReader {
  constructor(source: ArrayBuffer | Uint8Array | DataView, byteOffset?: number, byteLength?: number);
  pos: number;
  readonly remaining: number;
  readonly absolutePos: number;
  u8(): number;
  u16(): number;
  u32(): number;
  i16(): number;
  i32(): number;
  f32(): number;
  bytes(n: number): Uint8Array;
  skip(n: number): void;
  seekTo(pos: number): void;
}

export interface FrameStreamHeader {
  magic: string;
  version: number;
  n_cells: number;
  total_frames: number;
  /** Peels `divisions` parameter. 0 for older streams; derive from n_cells. */
  divisions: number;
  dt_ma?: number;
  keyframe_stride?: number;
  master_seed?: number;
  determinism_version?: string;
}

export function parseHeader(reader: ByteReader): FrameStreamHeader;
export function parseInitialState(reader: ByteReader, n_cells: number): any;
export function applyFrame(state: any, reader: ByteReader): void;

export class FrameCache {
  constructor(arrayBuffer: ArrayBuffer);
  readonly header: FrameStreamHeader;
  readonly current: any;
  seek(targetFrame: number): any;
}
