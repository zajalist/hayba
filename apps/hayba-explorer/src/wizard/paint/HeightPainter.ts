import { cellsInRadius, type GridAdjacency } from "./grid-neighbours";
import { falloff, type FalloffKind } from "./falloff";
import { sampleMask, type MaskName } from "./brushMasks";
import { applyMode, fbm, type BrushMode } from "./brushes";

export interface BrushConfig {
  mode: BrushMode;
  radiusRad: number;
  strength: number;        // 0..1
  falloff: FalloffKind;
  mask: MaskName;
  flattenTarget: number;   // -1..+1
  noiseScale: number;      // FBM frequency multiplier
}

export interface PainterInit extends GridAdjacency {
  /** Master noise seed (used by noise-mode brush). */
  seed: number;
  /** Initial elevations per cell (defaults all `defaultElevation` if omitted). */
  baseline?: Float32Array;
  /** Uniform starting elevation when no per-cell baseline is given, and the
   *  value `reset()` restores to. Defaults to 0 (sea level). */
  defaultElevation?: number;
}

interface StrokeRecord {
  cellIds: Uint32Array;
  prevValues: Float32Array;
  prevMask: Uint8Array;
}

const UNDO_CAPACITY = 20;

export class HeightPainter {
  readonly elevations: Float32Array;
  readonly touched: Uint8Array;
  readonly n: number;
  private readonly defaultElevation: number;
  dirty: boolean = false;

  private readonly adj: GridAdjacency;
  private readonly seed: number;
  private readonly undoStack: StrokeRecord[] = [];
  private readonly redoStack: StrokeRecord[] = [];

  private strokeActive: boolean = false;
  private currentBrush: BrushConfig | null = null;
  private capturedThisStroke: Set<number> = new Set();
  private currentRecord: { cellIds: number[]; prevValues: number[]; prevMask: number[] } | null = null;

  constructor(init: PainterInit) {
    this.adj = { positions: init.positions, neighbours: init.neighbours };
    this.n = init.neighbours.length;
    this.defaultElevation = init.defaultElevation ?? 0;
    this.elevations = init.baseline
      ? new Float32Array(init.baseline)
      : new Float32Array(this.n).fill(this.defaultElevation);
    this.touched = new Uint8Array(this.n);
    this.seed = init.seed;
  }

  beginStroke(brush: BrushConfig): void {
    this.strokeActive = true;
    this.currentBrush = brush;
    this.capturedThisStroke = new Set();
    this.currentRecord = { cellIds: [], prevValues: [], prevMask: [] };
  }

  tickStroke(args: { seedCellId: number; hit: readonly [number, number, number] }): void {
    if (!this.strokeActive || !this.currentBrush) return;
    const brush = this.currentBrush;
    if (brush.strength <= 0) return;

    const affected = cellsInRadius({
      ...this.adj,
      seedCellId: args.seedCellId,
      hit: args.hit,
      radiusRad: brush.radiusRad,
    });
    if (affected.length === 0) return;

    // Build tangent frame for mask sampling.
    const hit = args.hit;
    let upX = 0, upY = 1, upZ = 0;
    const dotUp = hit[0] * upX + hit[1] * upY + hit[2] * upZ;
    let tX = upX - hit[0] * dotUp, tY = upY - hit[1] * dotUp, tZ = upZ - hit[2] * dotUp;
    let tLen = Math.hypot(tX, tY, tZ);
    if (tLen < 1e-6) { tX = 1; tY = 0; tZ = 0; tLen = 1; }
    tX /= tLen; tY /= tLen; tZ /= tLen;
    const bX = hit[1] * tZ - hit[2] * tY;
    const bY = hit[2] * tX - hit[0] * tZ;
    const bZ = hit[0] * tY - hit[1] * tX;

    // Snapshot neighbour averages BEFORE mutation so smooth doesn't chase itself.
    const neighborAvg = new Float32Array(affected.length);
    for (let i = 0; i < affected.length; i++) {
      const id = affected[i].cellId;
      const nb = this.adj.neighbours[id];
      let sum = 0;
      for (const j of nb) sum += this.elevations[j];
      neighborAvg[i] = nb.length > 0 ? sum / nb.length : this.elevations[id];
    }

    for (let i = 0; i < affected.length; i++) {
      const { cellId, distRad } = affected[i];
      const pos = getPos(this.adj.positions, cellId);
      const dx = pos[0] - hit[0], dy = pos[1] - hit[1], dz = pos[2] - hit[2];
      const u = (dx * tX + dy * tY + dz * tZ) / brush.radiusRad;
      const v = (dx * bX + dy * bY + dz * bZ) / brush.radiusRad;

      const wFalloff = falloff(brush.falloff, distRad / brush.radiusRad);
      const wMask    = sampleMask(brush.mask, u, v);
      const w        = wFalloff * wMask * brush.strength;
      if (w <= 0) continue;

      this.captureBefore(cellId);
      const noiseSample = brush.mode === "noise"
        ? fbm(pos[0] * brush.noiseScale, pos[1] * brush.noiseScale, pos[2] * brush.noiseScale, 4, this.seed)
        : 0;
      let next = applyMode({
        mode: brush.mode,
        current: this.elevations[cellId],
        w,
        neighborAvg: neighborAvg[i],
        flattenTarget: brush.flattenTarget,
        noiseSample,
      });
      if (next > 1) next = 1;
      if (next < -1) next = -1;
      this.elevations[cellId] = next;
      this.touched[cellId] = 1;
    }
    this.dirty = true;
  }

  endStroke(): void {
    if (!this.strokeActive || !this.currentRecord) {
      this.strokeActive = false;
      this.currentBrush = null;
      this.currentRecord = null;
      this.capturedThisStroke = new Set();
      return;
    }
    if (this.currentRecord.cellIds.length > 0) {
      const rec: StrokeRecord = {
        cellIds: new Uint32Array(this.currentRecord.cellIds),
        prevValues: new Float32Array(this.currentRecord.prevValues),
        prevMask: new Uint8Array(this.currentRecord.prevMask),
      };
      this.undoStack.push(rec);
      if (this.undoStack.length > UNDO_CAPACITY) this.undoStack.shift();
      this.redoStack.length = 0;
    }
    this.strokeActive = false;
    this.currentBrush = null;
    this.currentRecord = null;
    this.capturedThisStroke = new Set();
  }

  undo(): boolean {
    const rec = this.undoStack.pop();
    if (!rec) return false;
    const forward: StrokeRecord = {
      cellIds: rec.cellIds,
      prevValues: new Float32Array(rec.cellIds.length),
      prevMask: new Uint8Array(rec.cellIds.length),
    };
    for (let i = 0; i < rec.cellIds.length; i++) {
      const id = rec.cellIds[i];
      forward.prevValues[i] = this.elevations[id];
      forward.prevMask[i] = this.touched[id];
      this.elevations[id] = rec.prevValues[i];
      this.touched[id] = rec.prevMask[i];
    }
    this.redoStack.push(forward);
    this.dirty = true;
    return true;
  }

  redo(): boolean {
    const rec = this.redoStack.pop();
    if (!rec) return false;
    const backward: StrokeRecord = {
      cellIds: rec.cellIds,
      prevValues: new Float32Array(rec.cellIds.length),
      prevMask: new Uint8Array(rec.cellIds.length),
    };
    for (let i = 0; i < rec.cellIds.length; i++) {
      const id = rec.cellIds[i];
      backward.prevValues[i] = this.elevations[id];
      backward.prevMask[i] = this.touched[id];
      this.elevations[id] = rec.prevValues[i];
      this.touched[id] = rec.prevMask[i];
    }
    this.undoStack.push(backward);
    if (this.undoStack.length > UNDO_CAPACITY) this.undoStack.shift();
    this.dirty = true;
    return true;
  }

  reset(): void {
    this.elevations.fill(this.defaultElevation);
    this.touched.fill(0);
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.dirty = true;
  }

  toDraftFields(): { painted_elevations: number[]; painted_mask: number[] } {
    return {
      painted_elevations: Array.from(this.elevations),
      painted_mask: Array.from(this.touched),
    };
  }

  countTouched(): number {
    let c = 0;
    for (let i = 0; i < this.n; i++) if (this.touched[i] === 1) c++;
    return c;
  }

  undoCount(): number { return this.undoStack.length; }
  redoCount(): number { return this.redoStack.length; }

  private captureBefore(cellId: number): void {
    if (!this.currentRecord) return;
    if (this.capturedThisStroke.has(cellId)) return;
    this.capturedThisStroke.add(cellId);
    this.currentRecord.cellIds.push(cellId);
    this.currentRecord.prevValues.push(this.elevations[cellId]);
    this.currentRecord.prevMask.push(this.touched[cellId]);
  }
}

function getPos(
  positions: GridAdjacency["positions"],
  id: number,
): [number, number, number] {
  if (positions instanceof Float32Array) {
    return [positions[id * 3], positions[id * 3 + 1], positions[id * 3 + 2]];
  }
  return positions[id] as [number, number, number];
}
