import React from "react";
import { colors, fonts } from "@hayba/design-tokens";
import type { WizardDraft, WizardPlate } from "./state";
import ResolutionChips from "./ResolutionChips";
import SeedRow from "./SeedRow";
import PlateRow from "./PlateRow";

export interface WizardPanelProps {
  draft: WizardDraft;
  activePlateId: number;
  onChangeDivisions: (divisions: number) => void;
  onReroll: () => void;
  onActivatePlate: (id: number) => void;
  onTogglePlateContinental: (id: number) => void;
  onBake: () => void;
  busy?: boolean;
}

function SectionHeading({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 8, display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
      <span style={{ fontFamily: fonts.serif, fontSize: 18, color: colors.textPrimary, letterSpacing: "0.02em" }}>
        {children}
      </span>
      {hint && (
        <span style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
          {hint}
        </span>
      )}
    </div>
  );
}

export default function WizardPanel({
  draft,
  activePlateId,
  onChangeDivisions,
  onReroll,
  onActivatePlate,
  onTogglePlateContinental,
  onBake,
  busy,
}: WizardPanelProps) {
  const continentalPainted = draft.plates
    .filter((p) => p.continental)
    .reduce((sum, p) => sum + p.cell_ids.length, 0);

  return (
    <aside
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 30, // sits above the status bar
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
        <div style={{ fontFamily: fonts.serif, fontSize: 26, color: colors.textPrimary, letterSpacing: "0.01em" }}>
          New planet
        </div>
        <div style={{ height: 2, width: 32, background: colors.accent, marginTop: 8 }} />
        <div style={{ marginTop: 10, fontSize: 11, color: colors.textMuted, letterSpacing: "0.06em" }}>
          paint continents · pick plates · bake
        </div>
      </header>

      <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px 24px" }}>
        <section style={{ marginBottom: 22 }}>
          <SectionHeading hint="resolution">Detail</SectionHeading>
          <ResolutionChips value={draft.divisions} onChange={onChangeDivisions} disabled={busy} />
        </section>

        <section style={{ marginBottom: 22 }}>
          <SectionHeading hint="seed">Determinism</SectionHeading>
          <SeedRow seed={draft.seed} onReroll={onReroll} disabled={busy} />
        </section>

        <section style={{ marginBottom: 22 }}>
          <SectionHeading hint={`${continentalPainted} cells`}>Continents</SectionHeading>
          <p style={{ margin: "0 0 10px", fontSize: 12, color: colors.textMuted, lineHeight: 1.45, letterSpacing: "0.02em" }}>
            Pick a continental plate, then <span style={{ color: colors.textSecondary }}>left-click and drag</span> on the planet to paint its land.
            Unpainted continental plates stay empty; oceanic plates auto-fill the rest.
          </p>
        </section>

        <section style={{ marginBottom: 22 }}>
          <SectionHeading hint={`${draft.plates.length} plates`}>Plates</SectionHeading>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {draft.plates.map((plate: WizardPlate) => (
              <PlateRow
                key={plate.id}
                plate={plate}
                active={plate.id === activePlateId && plate.continental}
                paintedCount={plate.cell_ids.length}
                onActivate={() => onActivatePlate(plate.id)}
                onToggleContinental={() => onTogglePlateContinental(plate.id)}
              />
            ))}
          </div>
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
            transition: "background 120ms, color 120ms",
          }}
        >
          {busy ? "baking…" : "bake planet"}
        </button>
      </footer>
    </aside>
  );
}
