import React, { useEffect, useState } from "react";
import type { PerfSnapshot } from "../viewport/perf";

/** NX-1 runtime perf HUD. Polls `getSnapshot` at ~4 Hz ONLY while
 *  visible (no interval, no React state churn when hidden). */
export default function PerfHud(props: {
  visible: boolean;
  getSnapshot: () => PerfSnapshot | null | undefined;
}): JSX.Element | null {
  const { visible, getSnapshot } = props;
  const [s, setS] = useState<PerfSnapshot | null>(null);
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => setS(getSnapshot() ?? null), 250);
    return () => clearInterval(id);
  }, [visible, getSnapshot]);
  if (!visible || !s) return null;
  const row = (k: string, v: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ opacity: 0.7 }}>{k}</span>
      <span>{v}</span>
    </div>
  );
  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        zIndex: 60,
        pointerEvents: "none",
        font: '11px/1.4 "Segoe UI", system-ui, sans-serif',
        color: "#DED4C3",
        background: "rgba(20,22,28,0.82)",
        border: "1px solid #2f343d",
        borderRadius: 5,
        padding: "6px 9px",
        minWidth: 150,
        backdropFilter: "blur(4px)",
      }}
    >
      {row("FPS", s.fps.toFixed(0))}
      {row("frame ms", `${s.ms.toFixed(1)} (ema ${s.emaMs.toFixed(1)})`)}
      {row("draw calls", String(s.calls))}
      {row("tris", s.triangles.toLocaleString())}
      {row("render scale", s.scale.toFixed(2))}
      {row("gpu ms", s.gpuMs == null ? "—" : s.gpuMs.toFixed(1))}
      {row("bake ms", s.bakeMs == null ? "—" : s.bakeMs.toFixed(0))}
      {s.bakeSplit && (
        <div style={{ marginTop: 4, borderTop: "1px solid #2f343d", paddingTop: 4 }}>
          <div style={{ opacity: 0.6, marginBottom: 2 }}>bake split (ms)</div>
          {row("wizard", s.bakeSplit.wizard.toFixed(0))}
          {row("equirect", s.bakeSplit.equirect.toFixed(0))}
          {row("upload", s.bakeSplit.upload.toFixed(0))}
          {row("gpuSim", s.bakeSplit.gpuSim.toFixed(0))}
          {row("total", s.bakeSplit.total.toFixed(0))}
        </div>
      )}
    </div>
  );
}
