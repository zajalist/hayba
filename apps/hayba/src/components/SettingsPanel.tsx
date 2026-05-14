import React from "react";
import { colors, fonts, radii } from "@hayba/design-tokens";
import type { WizardDraft, PresetName } from "../wizard/state";
import { PRESETS } from "../wizard/state";
import { PRESETS as RESOLUTION_PRESETS } from "../wizard/ResolutionChips";
import { IconSphere, IconPlates, IconSeed, IconBrush, IconReroll, IconClear, IconBake } from "./icons";

export interface SettingsPanelProps {
  draft: WizardDraft;
  busy: boolean;
  topOffset: number;
  bottomOffset: number;
  onChangeDivisions: (divisions: number) => void;
  onChangePreset: (preset: PresetName) => void;
  onReroll: () => void;
  onClearContinents: () => void;
  onBake: () => void;
}

export default function SettingsPanel({
  draft, busy, topOffset, bottomOffset,
  onChangeDivisions, onChangePreset, onReroll, onClearContinents, onBake,
}: SettingsPanelProps) {
  return (
    <aside
      style={{
        position: "fixed",
        right: 0,
        top: topOffset,
        bottom: bottomOffset,
        zIndex: 60,
        width: 300,
        background: colors.bgBase,
        borderLeft: `1px solid ${colors.borderMid}`,
        color: colors.textSecondary,
        fontFamily: fonts.sans,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* UE-style tab cap */}
      <div style={{
        display: "flex",
        alignItems: "stretch",
        background: colors.bgDeep,
        borderBottom: `1px solid ${colors.borderMid}`,
      }}>
        <div style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "0 16px",
          height: 28,
          background: colors.bgBase,
          borderRight: `1px solid ${colors.borderMid}`,
          borderTop: `2px solid ${colors.accent}`,
          marginTop: -1,
          fontSize: 10,
          color: colors.textPrimary,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          fontWeight: 500,
        }}>
          New Planet
        </div>
        <div style={{ flex: 1, background: colors.bgDeep }} />
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        <Subsection icon={<IconSphere size={14} />} label="Detail" hint="resolution">
          {RESOLUTION_PRESETS.map((p) => (
            <Row
              key={p.divisions}
              active={p.divisions === draft.divisions}
              onClick={() => onChangeDivisions(p.divisions)}
              disabled={busy}
              label={p.label}
              meta={`${p.cellsLabel} cells`}
            />
          ))}
        </Subsection>

        <Subsection icon={<IconPlates size={14} />} label="Tectonic preset" hint="plates">
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

        <Subsection icon={<IconSeed size={14} />} label="Determinism" hint="seed">
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
            <button
              type="button"
              disabled={busy}
              onClick={onReroll}
              style={{ ...btnLink, display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <IconReroll size={12} />
              Reroll →
            </button>
          </div>
        </Subsection>

        <Subsection icon={<IconBrush size={14} />} label="Continents" hint={`${draft.continental_cells.length.toLocaleString()} cells`}>
          <button
            type="button"
            disabled={busy || draft.continental_cells.length === 0}
            onClick={onClearContinents}
            style={{
              ...btnLink,
              marginTop: 6,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              opacity: draft.continental_cells.length === 0 ? 0.4 : 1,
              cursor: draft.continental_cells.length === 0 ? "default" : "pointer",
            }}
          >
            <IconClear size={12} />
            Clear continents →
          </button>
        </Subsection>
      </div>

      <div style={{
        padding: "14px 16px",
        borderTop: `1px solid ${colors.borderMid}`,
        background: colors.bgPanelHeader,
      }}>
        <button
          type="button"
          disabled={busy}
          onClick={onBake}
          style={{
            width: "100%",
            background: busy ? "transparent" : "rgba(181, 106, 29, 0.10)",
            border: `1px solid ${busy ? colors.borderSoft : colors.accent}`,
            borderRadius: radii.xs,
            color: busy ? colors.textMuted : colors.accent,
            padding: "10px 14px",
            fontSize: 11,
            letterSpacing: "0.32em",
            textTransform: "uppercase",
            fontFamily: fonts.sans,
            fontWeight: 600,
            cursor: busy ? "default" : "pointer",
            transition: "background 140ms",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <IconBake size={14} />
            {busy ? "Baking…" : "Bake planet →"}
          </span>
        </button>
      </div>
    </aside>
  );
}

function Subsection({ icon, label, hint, children }: { icon?: React.ReactNode; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: "12px 16px", borderBottom: `1px solid ${colors.borderMid}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {icon}
          <span style={{ fontSize: 10, color: colors.textPrimary, letterSpacing: "0.24em", textTransform: "uppercase", fontWeight: 500 }}>
            {label}
          </span>
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
          color: active ? colors.accent : colors.textMuted,
          width: 10,
        }}>
          {active ? "→" : ""}
        </span>
        <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <span style={{ fontWeight: active ? 600 : 400 }}>{label}</span>
          {sub && <span style={{ fontSize: 9, color: colors.textMuted, letterSpacing: "0.04em" }}>{sub}</span>}
        </span>
      </span>
      <span style={{
        fontFamily: "JetBrains Mono, Consolas, monospace",
        fontSize: 10,
        color: active ? colors.accent : colors.textMuted,
      }}>
        {meta}
      </span>
    </button>
  );
}

const btnLink: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: colors.accent,
  padding: 0,
  fontSize: 10,
  letterSpacing: "0.24em",
  textTransform: "uppercase",
  fontFamily: "inherit",
  fontWeight: 600,
  cursor: "pointer",
};
