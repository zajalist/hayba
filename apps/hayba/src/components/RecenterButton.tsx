import React, { useEffect, useState } from "react";
import * as THREE from "three";
import { colors, fonts, radii } from "@hayba/design-tokens";
import type { SceneHandle } from "../viewport/scene";

export interface RecenterButtonProps {
  /** When the planet has clearly been moved, this control fades in. */
  getScene: () => SceneHandle | null;
}

// Camera home — must match createScene's initial setup.
const HOME_POSITION = new THREE.Vector3(0, 0, 3.5);
const HOME_TARGET   = new THREE.Vector3(0, 0, 0);
const POS_THRESHOLD    = 0.2;   // sphere-units before showing
const TARGET_THRESHOLD = 0.05;  // pan-offset before showing

export default function RecenterButton({ getScene }: RecenterButtonProps) {
  const [show, setShow] = useState(false);

  // Poll the scene each frame. Cheap — just three vector comparisons.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const scene = getScene();
      if (scene) {
        const cam = scene.camera;
        const tgt = scene.controls.target;
        const posDelta = cam.position.distanceTo(HOME_POSITION);
        const tgtDelta = tgt.distanceTo(HOME_TARGET);
        const off = posDelta > POS_THRESHOLD || tgtDelta > TARGET_THRESHOLD;
        setShow((s) => (s === off ? s : off));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getScene]);

  const onClick = () => {
    const scene = getScene();
    if (!scene) return;
    // Animate camera + target back to home with a quick ease-out.
    const cam = scene.camera;
    const tgt = scene.controls.target;
    const startPos = cam.position.clone();
    const startTgt = tgt.clone();
    const start = performance.now();
    const dur = 360;
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      cam.position.lerpVectors(startPos, HOME_POSITION, eased);
      tgt.lerpVectors(startTgt, HOME_TARGET, eased);
      scene.controls.update();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title="Recenter planet"
      style={{
        position: "fixed",
        right: 22,
        bottom: 80,
        zIndex: 60,
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        background: "rgba(34, 38, 46, 0.92)",
        border: `1px solid ${colors.borderMid}`,
        borderRadius: radii.sm,
        padding: "8px 14px",
        fontSize: 10,
        letterSpacing: "0.24em",
        textTransform: "uppercase",
        fontFamily: fonts.sans,
        fontWeight: 600,
        color: colors.accent,
        cursor: "pointer",
        boxShadow: "0 12px 28px rgba(0,0,0,0.45)",
        backdropFilter: "blur(10px)",
        opacity: show ? 1 : 0,
        transform: show ? "translateY(0)" : "translateY(8px)",
        pointerEvents: show ? "auto" : "none",
        transition: "opacity 220ms ease, transform 220ms ease",
      }}
    >
      <RecenterGlyph />
      Recenter
    </button>
  );
}

function RecenterGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke={colors.accent} strokeWidth="1.6"/>
      <circle cx="12" cy="12" r="2.2" fill={colors.accent}/>
      <line x1="12" y1="2" x2="12" y2="5"   stroke={colors.accent} strokeWidth="1.6" strokeLinecap="round"/>
      <line x1="12" y1="19" x2="12" y2="22" stroke={colors.accent} strokeWidth="1.6" strokeLinecap="round"/>
      <line x1="2"  y1="12" x2="5"  y2="12" stroke={colors.accent} strokeWidth="1.6" strokeLinecap="round"/>
      <line x1="19" y1="12" x2="22" y2="12" stroke={colors.accent} strokeWidth="1.6" strokeLinecap="round"/>
    </svg>
  );
}
