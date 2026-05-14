import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { colors, fonts } from "@hayba/design-tokens";

interface BakeResult {
  status?: string;
  n_cells?: number;
  message?: string;
}

export default function App() {
  const [bake, setBake] = useState<BakeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<BakeResult>("bake_demo_planet")
      .then(setBake)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: colors.bgDeep,
        color: colors.textSecondary,
        fontFamily: fonts.sans,
        fontSize: 14,
        letterSpacing: "0.04em",
        gap: 12,
      }}
    >
      <div style={{ fontFamily: fonts.serif, fontSize: 32, color: colors.textPrimary }}>
        Hayba Explorer
      </div>
      <div style={{ width: 80, height: 2, background: colors.accent }} />
      {!bake && !error && <div>booting…</div>}
      {error && <div style={{ color: "#d77f24" }}>error: {error}</div>}
      {bake && (
        <div style={{ marginTop: 8 }}>
          {bake.message} <span style={{ color: colors.textMuted }}>(n_cells={bake.n_cells})</span>
        </div>
      )}
    </div>
  );
}
