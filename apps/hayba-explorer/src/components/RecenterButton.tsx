import React, { useEffect, useState } from "react";
import * as THREE from "three";
import { colors, fonts } from "@hayba/design-tokens";
import type { SceneHandle } from "../viewport/scene";
import { IconRecenter } from "./icons";

export interface RecenterButtonProps {
  /** When the planet has clearly been moved, this control fades in. */
  getScene: () => SceneHandle | null;
}

// Camera home — must match createScene's initial setup.
const HOME_POSITION = new THREE.Vector3(0, 0, 3.5);
const HOME_TARGET   = new THREE.Vector3(0, 0, 0);
const POS_THRESHOLD    = 0.2;
const TARGET_THRESHOLD = 0.05;

export default function RecenterButton({ getScene }: RecenterButtonProps) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const scene = getScene();
      if (scene) {
        const cam = scene.camera;
        const tgt = scene.controls.target;
        const off =
          cam.position.distanceTo(HOME_POSITION) > POS_THRESHOLD ||
          tgt.distanceTo(HOME_TARGET) > TARGET_THRESHOLD;
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
      aria-label="Recenter planet"
      style={{
        position: "absolute",
        right: 16,
        bottom: 16,
        zIndex: 60,
        width: 28,
        height: 28,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: `1px solid ${colors.borderSoft}`,
        borderRadius: 3,
        color: colors.textSecondary,
        fontFamily: fonts.sans,
        cursor: "pointer",
        padding: 0,
        opacity: show ? 0.85 : 0,
        transform: show ? "translateY(0)" : "translateY(6px)",
        pointerEvents: show ? "auto" : "none",
        transition: "opacity 200ms ease, transform 200ms ease, color 120ms ease, border-color 120ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = "#DED4C3";
        e.currentTarget.style.borderColor = "#DED4C3";
        e.currentTarget.style.opacity = "1";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = colors.textSecondary;
        e.currentTarget.style.borderColor = colors.borderSoft;
        e.currentTarget.style.opacity = "0.85";
      }}
    >
      <IconRecenter size={14} />
    </button>
  );
}
