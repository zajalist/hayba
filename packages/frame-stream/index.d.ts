// Type declarations for @hayba/frame-stream.
// Hand-written because the canonical module is plain JS (so viz/ can load it
// via `<script type="module">` with no build step).

export const TAGS: Readonly<{
  CELL_PLATE: 0x01;
  CELL_ELEV: 0x02;
  CELL_COMP: 0x03;
  CELL_RIFT: 0x04;
  CELL_FAILED: 0x05;
  CELL_LIP: 0x06;
  CELL_VOLC: 0x07;
  CELL_AGE_MA: 0x08;
  PLATE_SPAWN: 0x10;
  PLATE_RETIRE: 0x11;
  PLATE_MOTION: 0x12;
  PLATE_SEED: 0x13;
  PLATE_DEATH: 0x14;
  PLATE_PASSIVE_SPLIT: 0x15;
  FAILED_RIFT: 0x16;
  MOR_SPAWN: 0x20;
  MOR_RETIRE: 0x21;
  BOUNDARY_POLYLINES: 0x30;
  KEYFRAME: 0x40;
  // Phase 9 climate / crust / plume tags
  [key: string]: number;
}>;

export function dequantizeTemperatureK(q: number): number;
export function dequantizeUnit(q: number): number;
export function dequantizeRiverFlow(q: number): number;
export function decodeFloat16(u: number): number;

export interface ByteReader {
  offset: number;
  remaining(): number;
  readU8(): number;
  readU16(): number;
  readU32(): number;
  readI16(): number;
  readF32(): number;
  readBytes(n: number): Uint8Array;
  readUtf8(n: number): string;
}
export const ByteReader: {
  new (buf: ArrayBufferLike | Uint8Array): ByteReader;
};

export interface FrameStreamHeader {
  magic: string;
  version: number;
  n_cells: number;
  determinism_version?: string;
}

export function parseHeader(reader: ByteReader): FrameStreamHeader;
export function parseInitialState(reader: ByteReader, n_cells: number): any;
export function applyFrame(state: any, reader: ByteReader): void;

export interface FrameCacheOptions {
  initialState: any;
  binPayload: Uint8Array;
}

export class FrameCache {
  constructor(opts: FrameCacheOptions);
  totalFrames(): number;
  state(): any;
  seek(frameIndex: number): void;
  step(): void;
  reset(): void;
}
