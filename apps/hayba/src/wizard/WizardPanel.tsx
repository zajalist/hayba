import React from "react";
import { colors, fonts } from "@hayba/design-tokens";
import type { WizardDraft, PresetName } from "./state";
import ResolutionChips from "./ResolutionChips";
import SeedRow from "./SeedRow";
import PresetChips from "./PresetChips";
import BrushSlider from "./BrushSlider";
import { IconBake } from "../components/icons";

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

function Section({ index, title, hint, children }: {
  index: string;
  title: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section style={{ padding: "28px 32px", borderBottom: `1px solid ${colors.borderMid}` }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 18 }}>
        <span style={{ display: "inline-flex", alignItems: "baseline", gap: 14 }}>
          <span style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.accentText, letterSpacing: "0.14em" }}>
            {index}
          </span>
          <span style={{ fontFamily: fonts.sans, fontSize: 15, color: colors.textPrimary, letterSpacing: "0.01em", fontWeight: 500 }}>
            {title}
          </span>
        </span>
        {hint && (
          <span style={{ fontFamily: fonts.sans, fontSize: 9, color: colors.textMuted, letterSpacing: "0.24em", textTransform: "uppercase" }}>
            {hint}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function HaybaWordmark() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <svg width="20" height="24" viewBox="0 0 166 201" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M139.816 56L142.492 61.8262C148.517 74.9439 153.452 94.8289 156.582 102.254C159.859 110.024 161.945 116.804 161.882 124.527C161.821 131.993 159.746 139.456 156.613 148.542C153.556 157.405 148.7 169.92 142.827 186.371L140.456 193.009H98.6381L104.123 179.295C109.128 166.783 113.266 155.9 115.863 146.185C118.465 136.45 119.297 128.661 118.294 122.227C116.597 111.336 108.943 100.707 82.9418 91.4414C56.9412 100.707 49.2868 111.336 47.5893 122.227C46.5863 128.661 47.4197 136.45 50.0219 146.185C52.619 155.9 56.7553 166.783 61.7602 179.295L67.2455 193.009H25.4272L23.058 186.371C17.1851 169.92 12.3284 157.405 9.27189 148.542C6.13864 139.456 4.06224 131.993 4.00139 124.527C3.93844 116.804 6.02502 110.024 9.30119 102.254C12.4319 94.8288 17.3679 74.944 23.393 61.8262L26.0688 56H139.816Z" fill="#DED4C3"/>
        <path d="M19 23.9102V48.4551H83.5H148V23.9102C113.042 48.4551 53.958 48.4551 19 23.9102Z" fill={colors.accent}/>
        <path d="M19 73C69.2485 83.4432 97.0527 83.2572 148 73V48.4551H83.5H19V73Z" fill={colors.accent}/>
        <path d="M19 23.9102C53.958 48.4551 113.042 48.4551 148 23.9102C116.295 -4.10732 49.1347 -3.83245 19 23.9102Z" fill={colors.accent}/>
        <path d="M82.748 0C86.0616 0.000172138 88.748 2.6864 88.748 6L97.9375 11.75L103.911 20.3926L93.4385 19.542L87.2451 15.9668V22.499L82.7451 31.9941L78.248 22.499V15.6309L71.4727 19.542L61 20.3926L66.9746 11.75L76.748 6C76.748 2.68629 79.4343 0 82.748 0Z" fill="#DED4C3"/>
      </svg>
      <span style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.textPrimary, letterSpacing: "0.36em", textTransform: "uppercase", fontWeight: 500 }}>
        Hayba
      </span>
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
        width: 400,
        background: colors.bgBase,
        borderLeft: `1px solid ${colors.borderMid}`,
        color: colors.textSecondary,
        fontFamily: fonts.sans,
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header style={{ padding: "28px 32px 24px" }}>
        <HaybaWordmark />
        <h1 style={{
          margin: "32px 0 14px",
          fontSize: 32,
          color: colors.textPrimary,
          letterSpacing: "-0.01em",
          fontWeight: 600,
          lineHeight: 1.05,
        }}>
          New planet.
        </h1>
        <div style={{
          fontFamily: fonts.sans,
          fontSize: 11,
          color: colors.accentText,
          letterSpacing: "0.32em",
          textTransform: "uppercase",
          fontWeight: 500,
        }}>
          Pick · Paint · Bake
        </div>
      </header>

      <div style={{ flex: 1, overflowY: "auto" }}>
        <Section index="01" title="Detail" hint="resolution">
          <ResolutionChips value={draft.divisions} onChange={onChangeDivisions} disabled={busy} />
        </Section>

        <Section index="02" title="Tectonic preset" hint="plates">
          <PresetChips value={draft.preset} onChange={onChangePreset} disabled={busy} />
        </Section>

        <Section index="03" title="Determinism" hint="seed">
          <SeedRow seed={draft.seed} onReroll={onReroll} disabled={busy} />
        </Section>

        <Section index="04" title="Continents" hint={`${draft.continental_cells.length.toLocaleString()} painted`}>
          <p style={{
            margin: "0 0 22px",
            fontSize: 12,
            color: colors.textMuted,
            lineHeight: 1.65,
            letterSpacing: "0.01em",
          }}>
            <span style={{ color: colors.textSecondary }}>Left-click and drag</span> on the planet to paint continental crust. Right-click drags to rotate.
          </p>
          <BrushSlider value={draft.brush_radius_rad} onChange={onChangeBrushRadius} disabled={busy} />
          <button
            type="button"
            disabled={busy || draft.continental_cells.length === 0}
            onClick={onClearContinents}
            style={{
              marginTop: 18,
              background: "transparent",
              border: "none",
              color: draft.continental_cells.length === 0 ? colors.textMuted : colors.textSecondary,
              padding: 0,
              fontSize: 11,
              letterSpacing: "0.24em",
              textTransform: "uppercase",
              fontFamily: fonts.sans,
              fontWeight: 500,
              cursor: busy || draft.continental_cells.length === 0 ? "default" : "pointer",
            }}
          >
            Clear continents →
          </button>
        </Section>
      </div>

      <footer style={{ padding: "20px 32px 22px" }}>
        <button
          type="button"
          disabled={busy}
          onClick={onBake}
          style={{
            width: "100%",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            background: busy ? "transparent" : "#DED4C3",
            color: busy ? colors.textMuted : colors.bgDeep,
            border: `1px solid ${busy ? colors.borderSoft : "#DED4C3"}`,
            padding: "16px 18px",
            fontSize: 12,
            letterSpacing: "0.32em",
            textTransform: "uppercase",
            fontFamily: fonts.sans,
            fontWeight: 600,
            cursor: busy ? "default" : "pointer",
            transition: "background 140ms",
          }}
        >
          <IconBake size={16} />
          {busy ? "Baking…" : "Bake planet"}
        </button>
      </footer>
    </aside>
  );
}
