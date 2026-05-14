import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { colors, fonts } from "@hayba/design-tokens";
import type { SceneHandle } from "../viewport/scene";
import type { PlanetSnapshot } from "../App";
import type { BoundaryType } from "../wizard/state";
import { PLATE_PALETTE } from "../viewport/globe";

const BEIGE = "#DED4C3";
const CONV_COLOR = "#4DC080";
const DIV_COLOR  = "#5A99F2";

export interface PlatesOverlayProps {
  getScene: () => SceneHandle | null;
  snapshot: PlanetSnapshot;
  boundaryTypes: Record<string, BoundaryType>;
}

interface Centroid {
  plateId: number;
  pos3: THREE.Vector3;
}

interface Projected {
  plateId: number;
  x: number;
  y: number;
  visible: boolean;
}

export default function PlatesOverlay({ getScene, snapshot, boundaryTypes }: PlatesOverlayProps) {
  // Compute centroids once per snapshot.
  const centroids = useCentroids(snapshot);

  // Per-frame projection state.
  const [projected, setProjected] = useState<Map<number, Projected>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const scene = getScene();
      const container = containerRef.current;
      if (scene && container) {
        const rect = container.getBoundingClientRect();
        const cam = scene.camera;
        const next = new Map<number, Projected>();
        for (const c of centroids) {
          // Cull cells facing away from the camera.
          const camDir = cam.position.clone().normalize();
          const facing = c.pos3.dot(camDir) > 0.05;
          const v = c.pos3.clone().project(cam);
          const x = (v.x * 0.5 + 0.5) * rect.width;
          const y = (1 - (v.y * 0.5 + 0.5)) * rect.height;
          next.set(c.plateId, { plateId: c.plateId, x, y, visible: facing && v.z > -1 && v.z < 1 });
        }
        setProjected(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [centroids, getScene]);

  // Force arrows: for each assigned pair, draw a line between the two plates'
  // centroids with arrowheads showing the type.
  const arrowSegments: ArrowSeg[] = [];
  for (const [key, type] of Object.entries(boundaryTypes)) {
    const [a, b] = key.split("-").map(Number);
    const pa = projected.get(a);
    const pb = projected.get(b);
    if (!pa || !pb || !pa.visible || !pb.visible) continue;
    arrowSegments.push({ key, a: pa, b: pb, type });
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 50,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      {/* SVG layer for the force arrows */}
      <svg
        width="100%"
        height="100%"
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      >
        <defs>
          <marker
            id="arrowhead-conv"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={CONV_COLOR} />
          </marker>
          <marker
            id="arrowhead-div"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={DIV_COLOR} />
          </marker>
        </defs>
        {arrowSegments.map((seg) => (
          <ArrowPair key={seg.key} seg={seg} />
        ))}
      </svg>

      {/* Plate number labels — float just above each centroid */}
      {centroids.map((c) => {
        const p = projected.get(c.plateId);
        if (!p) return null;
        const tint = PLATE_PALETTE[(c.plateId - 1) % PLATE_PALETTE.length];
        const tintCss = `rgb(${Math.round(tint[0] * 255)}, ${Math.round(tint[1] * 255)}, ${Math.round(tint[2] * 255)})`;
        return (
          <div
            key={c.plateId}
            style={{
              position: "absolute",
              left: p.x,
              top: p.y,
              transform: "translate(-50%, -50%)",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 9px",
              background: "rgba(20, 22, 25, 0.78)",
              border: `1px solid ${tintCss}`,
              borderRadius: 999,
              fontFamily: fonts.sans,
              fontSize: 11,
              color: BEIGE,
              fontWeight: 600,
              letterSpacing: "0.02em",
              backdropFilter: "blur(6px)",
              opacity: p.visible ? 1 : 0,
              transition: "opacity 140ms ease",
              whiteSpace: "nowrap",
            }}
          >
            <span style={{
              width: 7, height: 7, borderRadius: "50%", background: tintCss,
              boxShadow: `0 0 6px ${tintCss}88`,
            }} />
            Plate <span style={{ fontFamily: fonts.mono, color: tintCss }}>{c.plateId}</span>
          </div>
        );
      })}
    </div>
  );
}

interface ArrowSeg {
  key: string;
  a: Projected;
  b: Projected;
  type: BoundaryType;
}

function ArrowPair({ seg }: { seg: ArrowSeg }) {
  // Two short arrows, one at each plate, pointing toward (convergent) or away
  // from (divergent) the other plate. Each arrow is drawn from the plate's
  // centroid out along the midline, ~30% of the segment length.
  const dx = seg.b.x - seg.a.x;
  const dy = seg.b.y - seg.a.y;
  const len = Math.hypot(dx, dy);
  if (len < 30) return null;
  const ux = dx / len;
  const uy = dy / len;
  const arrowLen = Math.min(70, len * 0.32);
  const inset = 40; // start away from the centroid pill

  const color = seg.type === "convergent" ? CONV_COLOR : DIV_COLOR;
  const markerId = seg.type === "convergent" ? "arrowhead-conv" : "arrowhead-div";

  // Convergent → tails near each plate, heads point inward (toward midpoint).
  // Divergent  → tails near each plate, heads point outward (away from midpoint).
  const aTailX = seg.a.x + ux * inset;
  const aTailY = seg.a.y + uy * inset;
  const aHeadX = seg.a.x + ux * (inset + arrowLen);
  const aHeadY = seg.a.y + uy * (inset + arrowLen);
  const bTailX = seg.b.x - ux * inset;
  const bTailY = seg.b.y - uy * inset;
  const bHeadX = seg.b.x - ux * (inset + arrowLen);
  const bHeadY = seg.b.y - uy * (inset + arrowLen);

  const conv = seg.type === "convergent";
  // For convergent: a-arrow goes A→midpoint (head toward midpoint = aHead).
  // For divergent:  a-arrow goes midpoint→A direction (head outside = aTail).
  // Reverse semantics — we just swap which endpoint is the head.
  return (
    <>
      <line
        x1={conv ? aTailX : aHeadX} y1={conv ? aTailY : aHeadY}
        x2={conv ? aHeadX : aTailX} y2={conv ? aHeadY : aTailY}
        stroke={color} strokeWidth="2"
        markerEnd={`url(#${markerId})`}
      />
      <line
        x1={conv ? bTailX : bHeadX} y1={conv ? bTailY : bHeadY}
        x2={conv ? bHeadX : bTailX} y2={conv ? bHeadY : bTailY}
        stroke={color} strokeWidth="2"
        markerEnd={`url(#${markerId})`}
      />
    </>
  );
}

function useCentroids(snapshot: PlanetSnapshot): Centroid[] {
  const [centroids, setCentroids] = useState<Centroid[]>([]);
  useEffect(() => {
    const sums = new Map<number, THREE.Vector3>();
    const counts = new Map<number, number>();
    for (let i = 0; i < snapshot.n_cells; i++) {
      const pid = snapshot.cell_plate_ids[i];
      if (pid < 0) continue;
      const x = snapshot.cell_positions[3 * i + 0];
      const y = snapshot.cell_positions[3 * i + 1];
      const z = snapshot.cell_positions[3 * i + 2];
      const sum = sums.get(pid) ?? new THREE.Vector3();
      sum.x += x; sum.y += y; sum.z += z;
      sums.set(pid, sum);
      counts.set(pid, (counts.get(pid) ?? 0) + 1);
    }
    const out: Centroid[] = [];
    for (const [pid, s] of sums) {
      out.push({ plateId: pid, pos3: s.normalize() });
    }
    out.sort((a, b) => a.plateId - b.plateId);
    setCentroids(out);
  }, [snapshot]);
  return centroids;
}
