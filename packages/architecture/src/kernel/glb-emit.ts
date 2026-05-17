/**
 * Emit a Mesh as a glTF 2.0 binary (.glb) ArrayBuffer.
 *
 * Implementation builds the minimal glTF structure by hand rather than using
 * three.js's GLTFExporter (which is browser-only and includes non-deterministic
 * metadata like timestamps).
 *
 * Layout: 12-byte header + JSON chunk + BIN chunk.
 *
 * Determinism: the JSON section is built with explicit insertion order; the
 * BIN section is built by concatenating positions, normals, indices (in that
 * order, each padded to 4-byte alignment).
 */

import type { Mesh } from './types.js';

const GLB_MAGIC = 0x46546c67;        // 'glTF' little-endian
const VERSION = 2;
const CHUNK_JSON = 0x4e4f534a;       // 'JSON' little-endian
const CHUNK_BIN  = 0x004e4942;       // 'BIN\0' little-endian

function pad4(n: number): number { return Math.ceil(n / 4) * 4; }

export function emitGLB(mesh: Mesh): ArrayBuffer {
  const posBytes = mesh.positions.byteLength;
  const normBytes = mesh.normals.byteLength;
  const idxBytes = mesh.indices.byteLength;

  const posOffset = 0;
  const normOffset = pad4(posOffset + posBytes);
  const idxOffset  = pad4(normOffset + normBytes);
  const binTotal   = pad4(idxOffset + idxBytes);

  // Compute bounds for the position accessor (glTF spec requires min/max).
  const vCount = mesh.positions.length / 3;
  let minX = +Infinity, minY = +Infinity, minZ = +Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vCount; i++) {
    const x = mesh.positions[i*3], y = mesh.positions[i*3+1], z = mesh.positions[i*3+2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  // 5126 = FLOAT, 5125 = UNSIGNED_INT, 34962 = ARRAY_BUFFER, 34963 = ELEMENT_ARRAY_BUFFER
  const json = {
    asset: { version: '2.0', generator: 'hayba-architecture-kernel' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1 },
        indices: 2,
        mode: 4,
      }],
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: vCount, type: 'VEC3',
        min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
      { bufferView: 1, componentType: 5126, count: vCount, type: 'VEC3' },
      { bufferView: 2, componentType: 5125, count: mesh.indices.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: posOffset,  byteLength: posBytes,  target: 34962 },
      { buffer: 0, byteOffset: normOffset, byteLength: normBytes, target: 34962 },
      { buffer: 0, byteOffset: idxOffset,  byteLength: idxBytes,  target: 34963 },
    ],
    buffers: [{ byteLength: binTotal }],
  };

  const jsonStr = JSON.stringify(json);
  const jsonBytes = new TextEncoder().encode(jsonStr);
  const jsonPadded = new Uint8Array(pad4(jsonBytes.length));
  jsonPadded.set(jsonBytes);
  for (let i = jsonBytes.length; i < jsonPadded.length; i++) jsonPadded[i] = 0x20;  // space

  const total = 12 + 8 + jsonPadded.length + 8 + binTotal;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // GLB header.
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, total, true);

  // JSON chunk header.
  view.setUint32(12, jsonPadded.length, true);
  view.setUint32(16, CHUNK_JSON, true);
  u8.set(jsonPadded, 20);

  // BIN chunk header.
  const binChunkOffset = 20 + jsonPadded.length;
  view.setUint32(binChunkOffset, binTotal, true);
  view.setUint32(binChunkOffset + 4, CHUNK_BIN, true);

  // BIN data.
  const binBase = binChunkOffset + 8;
  u8.set(new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, posBytes), binBase + posOffset);
  u8.set(new Uint8Array(mesh.normals.buffer,   mesh.normals.byteOffset,   normBytes), binBase + normOffset);
  u8.set(new Uint8Array(mesh.indices.buffer,   mesh.indices.byteOffset,   idxBytes),  binBase + idxOffset);

  return buf;
}
