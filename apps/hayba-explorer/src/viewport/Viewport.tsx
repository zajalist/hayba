import React, { useEffect, useRef } from "react";
import { createScene, type SceneHandle } from "./scene";

export interface ViewportProps {
  onReady?: (handle: SceneHandle) => void;
}

export default function Viewport({ onReady }: ViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const handle = createScene(canvasRef.current);
    onReady?.(handle);
    return () => handle.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "100%" }} />
    </div>
  );
}
