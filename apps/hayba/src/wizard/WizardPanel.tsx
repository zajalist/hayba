import React from "react";
import { colors, fonts } from "@hayba/design-tokens";
import type { WizardDraft, PresetName } from "./state";
import ResolutionChips from "./ResolutionChips";
import SeedRow from "./SeedRow";
import PresetChips from "./PresetChips";
import BrushSlider from "./BrushSlider";

export interface WizardPanelProps {
  draft: WizardDraft;
  onChangeDivisions: (divisions: number) => void;
  onChangePreset: (preset: PresetName) => void;
  onChangeBrushRadius: (rad: number) => void;
  onReroll: () => void;
  onClearContinents: () => void;
  onBake: () => void;
  busy?: boolean;
}

function SectionHeading({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 8, display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
      <span style={{ fontFamily: fonts.sans, fontSize: 14, color: colors.textPrimary, letterSpacing: "0.04em", fontWeight: 600 }}>
        {children}
      </span>
      {hint && (
        <span style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.accentText, letterSpacing: "0.14em", textTransform: "uppercase" }}>
          {hint}
        </span>
      )}
    </div>
  );
}

export default function WizardPanel({
  draft,
  onChangeDivisions,
  onChangePreset,
  onChangeBrushRadius,
  onReroll,
  onClearContinents,
  onBake,
  busy,
}: WizardPanelProps) {
  return (
    <aside
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 30,
        width: 360,
        background: colors.bgBase,
        borderLeft: `1px solid ${colors.borderMid}`,
        boxShadow: "-12px 0 32px rgba(0,0,0,0.35)",
        color: colors.textSecondary,
        fontFamily: fonts.sans,
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header style={{ padding: "20px 24px 14px", borderBottom: `1px solid ${colors.borderMid}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 22, color: colors.textPrimary, letterSpacing: "0.02em", fontWeight: 600 }}>
            New planet
          </span>
        </div>
        <div style={{ height: 2, width: 32, background: colors.accent, marginTop: 10 }} />
        <div style={{ marginTop: 8, fontSize: 10, color: colors.accentText, letterSpacing: "0.16em", textTransform: "uppercase" }}>
          pick a preset · paint continents · bake
        </div>
      </header>

      <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px 24px" }}>
        <section style={{ marginBottom: 22 }}>
          <SectionHeading hint="resolution">Detail</SectionHeading>
          <ResolutionChips value={draft.divisions} onChange={onChangeDivisions} disabled={busy} />
        </section>

        <section style={{ marginBottom: 22 }}>
          <SectionHeading hint="plates">Tectonic preset</SectionHeading>
          <PresetChips value={draft.preset} onChange={onChangePreset} disabled={busy} />
        </section>

        <section style={{ marginBottom: 22 }}>
          <SectionHeading hint="seed">Determinism</SectionHeading>
          <SeedRow seed={draft.seed} onReroll={onReroll} disabled={busy} />
        </section>

        <section style={{ marginBottom: 22 }}>
          <SectionHeading hint={`${draft.continental_cells.length.toLocaleString()} cells`}>
            Continents
          </SectionHeading>
          <p style={{ margin: "0 0 14px", fontSize: 12, color: colors.textMuted, lineHeight: 1.5, letterSpacing: "0.02em" }}>
            <span style={{ color: colors.textSecondary }}>Left-click and drag</span> on the planet to paint continental crust. Right-click drags to rotate.
          </p>
          <BrushSlider value={draft.brush_radius_rad} onChange={onChangeBrushRadius} disabled={busy} />
          <button
            type="button"
            disabled={busy || draft.continental_cells.length === 0}
            onClick={onClearContinents}
            style={{
              marginTop: 10,
              background: "transparent",
              border: `1px solid ${colors.borderSoft}`,
              color: draft.continental_cells.length === 0 ? colors.textMuted : colors.textSecondary,
              padding: "5px 12px",
              fontSize: 10,
              letterSpacing: "0.18em",
              textTransform: "lowercase",
              fontFamily: fonts.sans,
              cursor: busy || draft.continental_cells.length === 0 ? "default" : "pointer",
            }}
          >
            clear continents
          </button>
        </section>
      </div>

      <footer style={{ padding: "14px 24px", borderTop: `1px solid ${colors.borderMid}` }}>
        <button
          type="button"
          disabled={busy}
          onClick={onBake}
          style={{
            width: "100%",
            background: busy ? "transparent" : colors.accent,
            color: busy ? colors.textMuted : colors.bgDeep,
            border: `1px solid ${busy ? colors.borderSoft : colors.accent}`,
            padding: "12px 16px",
            fontSize: 12,
            letterSpacing: "0.24em",
            textTransform: "uppercase",
            fontFamily: fonts.sans,
            fontWeight: 600,
            cursor: busy ? "default" : "pointer",
          }}
        >
          {busy ? "baking…" : "bake planet"}
        </button>
      </footer>
    </aside>
  );
}
