import React, { useState } from "react";
import { colors, fonts } from "@hayba/design-tokens";
import type { WizardDraft, PresetName } from "../wizard/state";
import { PRESETS } from "../wizard/state";
import { PRESETS as RESOLUTION_PRESETS } from "../wizard/ResolutionChips";

export interface SettingsCornerProps {
  draft: WizardDraft;
  busy: boolean;
  onChangeDivisions: (divisions: number) => void;
  onChangePreset: (preset: PresetName) => void;
  onReroll: () => void;
  onClearContinents: () => void;
  onBake: () => void;
}

export default function SettingsCorner({
  draft, busy, onChangeDivisions, onChangePreset, onReroll, onClearContinents, onBake,
}: SettingsCornerProps) {
  const [open, setOpen] = useState(true);

  const resolution = RESOLUTION_PRESETS.find((p) => p.divisions === draft.divisions);
  const preset = PRESETS.find((p) => p.name === draft.preset);

  return (
    <aside
      style={{
        position: "fixed",
        right: 20,
        top: 20,
        zIndex: 60,
        width: 280,
        background: colors.bgBase,
        border: `1px solid ${colors.borderMid}`,
        color: colors.textSecondary,
        fontFamily: fonts.sans,
        backdropFilter: "blur(8px)",
      }}
    >
      {/* Header: wordmark + collapse toggle */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: open ? `1px solid ${colors.borderMid}` : "none",
          cursor: "pointer",
        }}
        onClick={() => setOpen((o) => !o)}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 10, color: colors.accentText, letterSpacing: "0.32em", textTransform: "uppercase", fontWeight: 500 }}>
            New planet
          </span>
          {!open && (
            <span style={{ fontSize: 11, color: colors.textMuted, letterSpacing: "0.02em" }}>
              {resolution?.label.toLowerCase()} · {preset?.plates} plates · seed {String(draft.seed).slice(-6)}
            </span>
          )}
        </div>
        <span style={{ color: colors.accentText, fontSize: 14, fontFamily: fonts.mono }}>
          {open ? "−" : "+"}
        </span>
      </div>

      {open && (
        <div>
          <Subsection label="Detail" hint="resolution">
            {RESOLUTION_PRESETS.map((p) => (
              <Row
                key={p.divisions}
                active={p.divisions === draft.divisions}
                onClick={() => onChangeDivisions(p.divisions)}
                disabled={busy}
                label={p.label}
                meta={p.cellsLabel}
              />
            ))}
          </Subsection>

          <Subsection label="Tectonic preset" hint="plates">
            {PRESETS.map((p) => (
              <Row
                key={p.name}
                active={p.name === draft.preset}
                onClick={() => onChangePreset(p.name)}
                disabled={busy}
                label={p.label}
                sub={p.note}
                meta={`${p.plates}`}
              />
            ))}
          </Subsection>

          <Subsection label="Determinism" hint="seed">
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 0",
              borderTop: `1px solid ${colors.borderMid}`,
            }}>
              <span style={{
                fontFamily: fonts.mono, fontSize: 11, color: colors.textPrimary,
                letterSpacing: "0.04em",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160,
              }}>
                {draft.seed.toString()}
              </span>
              <button type="button" disabled={busy} onClick={onReroll} style={btnLink}>Reroll →</button>
            </div>
          </Subsection>

          <Subsection label="Continents" hint={`${draft.continental_cells.length.toLocaleString()} cells`}>
            <button
              type="button"
              disabled={busy || draft.continental_cells.length === 0}
              onClick={onClearContinents}
              style={{
                ...btnLink,
                marginTop: 4,
                opacity: draft.continental_cells.length === 0 ? 0.4 : 1,
                cursor: draft.continental_cells.length === 0 ? "default" : "pointer",
              }}
            >
              Clear continents →
            </button>
          </Subsection>

          <div style={{ padding: "14px 16px", borderTop: `1px solid ${colors.borderMid}` }}>
            <button
              type="button"
              disabled={busy}
              onClick={onBake}
              style={{
                width: "100%",
                background: "transparent",
                border: `1px solid ${busy ? colors.borderSoft : colors.accentText}`,
                color: busy ? colors.textMuted : colors.accentText,
                padding: "10px 14px",
                fontSize: 11,
                letterSpacing: "0.32em",
                textTransform: "uppercase",
                fontFamily: fonts.sans,
                fontWeight: 500,
                cursor: busy ? "default" : "pointer",
                transition: "background 140ms, color 140ms",
              }}
            >
              {busy ? "Baking…" : "Bake planet →"}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

function Subsection({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: "12px 16px", borderBottom: `1px solid ${colors.borderMid}` }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 10, color: colors.textPrimary, letterSpacing: "0.24em", textTransform: "uppercase", fontWeight: 500 }}>
          {label}
        </span>
        {hint && (
          <span style={{ fontSize: 9, color: colors.textMuted, letterSpacing: "0.28em", textTransform: "uppercase" }}>
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Row({ label, sub, meta, active, disabled, onClick }: {
  label: string; sub?: string; meta: string; active: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        width: "100%",
        padding: "6px 0",
        background: "transparent",
        border: "none",
        borderTop: `1px solid ${colors.borderMid}`,
        color: active ? colors.textPrimary : colors.textSecondary,
        fontFamily: "inherit",
        fontSize: 12,
        letterSpacing: "0.02em",
        cursor: disabled ? "default" : "pointer",
        textAlign: "left",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8 }}>
        <span style={{
          fontFamily: "JetBrains Mono, Consolas, monospace",
          fontSize: 10,
          color: active ? colors.accentText : colors.textMuted,
          width: 10,
        }}>
          {active ? "→" : ""}
        </span>
        <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <span>{label}</span>
          {sub && <span style={{ fontSize: 9, color: colors.textMuted, letterSpacing: "0.04em" }}>{sub}</span>}
        </span>
      </span>
      <span style={{
        fontFamily: "JetBrains Mono, Consolas, monospace",
        fontSize: 10,
        color: active ? colors.accentText : colors.textMuted,
      }}>
        {meta}
      </span>
    </button>
  );
}

const btnLink: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: colors.accentText,
  padding: 0,
  fontSize: 10,
  letterSpacing: "0.24em",
  textTransform: "uppercase",
  fontFamily: "inherit",
  fontWeight: 500,
  cursor: "pointer",
};
