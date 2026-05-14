import React, { useState } from "react";
import { colors, fonts, radii } from "@hayba/design-tokens";
import type { WizardDraft, PresetName } from "../wizard/state";
import { PRESETS } from "../wizard/state";
import { PRESETS as RESOLUTION_PRESETS } from "../wizard/ResolutionChips";
import { IconSphere, IconPlates, IconSeed, IconReroll, IconBake } from "./icons";

export interface SettingsModalProps {
  draft: WizardDraft;
  busy: boolean;
  topOffset: number;
  onChangeDivisions: (divisions: number) => void;
  onChangePreset: (preset: PresetName) => void;
  onReroll: () => void;
  onBake: () => void;
}

export default function SettingsModal({
  draft, busy, topOffset,
  onChangeDivisions, onChangePreset, onReroll, onBake,
}: SettingsModalProps) {
  const [collapsed, setCollapsed] = useState(false);

  const resolution = RESOLUTION_PRESETS.find((p) => p.divisions === draft.divisions);
  const preset = PRESETS.find((p) => p.name === draft.preset);

  return (
    <aside
      style={{
        position: "fixed",
        right: 22,
        top: topOffset + 22,
        zIndex: 60,
        width: 280,
        background: "rgba(34, 38, 46, 0.92)",
        border: `1px solid ${colors.borderMid}`,
        borderRadius: radii.sm,
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        color: colors.textSecondary,
        fontFamily: fonts.sans,
        overflow: "hidden",
      }}
    >
      {/* Header / collapse toggle */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: colors.bgPanelHeader,
          borderBottom: collapsed ? "none" : `1px solid ${colors.borderMid}`,
          padding: "10px 14px",
          fontFamily: fonts.sans,
          cursor: "pointer",
          border: "none",
          borderLeft: `2px solid ${colors.accent}`,
          textAlign: "left",
        }}
      >
        <span style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 9, color: colors.accent, letterSpacing: "0.32em", textTransform: "uppercase", fontWeight: 600 }}>
            Compose
          </span>
          {collapsed && (
            <span style={{ fontSize: 10, color: colors.textMuted, letterSpacing: "0.04em" }}>
              {resolution?.label.toLowerCase()} · {preset?.plates} plates · seed {String(draft.seed).slice(-6)}
            </span>
          )}
        </span>
        <span style={{ color: colors.textSecondary, fontSize: 12, fontFamily: fonts.mono }}>
          {collapsed ? "▸" : "▾"}
        </span>
      </button>

      {!collapsed && (
        <>
          <Subsection icon={<IconSphere size={14} />} label="Detail" hint="resolution">
            <ChipRow>
              {RESOLUTION_PRESETS.map((p) => (
                <Chip
                  key={p.divisions}
                  active={p.divisions === draft.divisions}
                  onClick={() => onChangeDivisions(p.divisions)}
                  disabled={busy}
                >
                  {p.label}
                  <span style={{
                    fontFamily: fonts.mono,
                    fontSize: 9,
                    marginLeft: 6,
                    opacity: 0.7,
                  }}>
                    {p.cellsLabel}
                  </span>
                </Chip>
              ))}
            </ChipRow>
          </Subsection>

          <Subsection icon={<IconPlates size={14} />} label="Plate number" hint="preset">
            <ChipRow>
              {PRESETS.map((p) => (
                <Chip
                  key={p.name}
                  active={p.name === draft.preset}
                  onClick={() => onChangePreset(p.name)}
                  disabled={busy}
                  small
                >
                  {p.note ? `${p.plates}*` : p.plates}
                </Chip>
              ))}
            </ChipRow>
            <div style={{ marginTop: 6, fontSize: 9, color: colors.textMuted, letterSpacing: "0.04em" }}>
              {preset?.note ? "* uneven distribution" : " "}
            </div>
          </Subsection>

          <Subsection icon={<IconSeed size={14} />} label="Seed" hint="determinism">
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 0 4px",
              gap: 8,
            }}>
              <span style={{
                fontFamily: fonts.mono, fontSize: 11, color: colors.textPrimary,
                letterSpacing: "0.04em",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1,
              }}>
                {draft.seed.toString()}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={onReroll}
                title="Roll a new seed"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  background: "transparent",
                  border: "none",
                  color: colors.accent,
                  padding: 0,
                  fontSize: 10,
                  letterSpacing: "0.24em",
                  textTransform: "uppercase",
                  fontFamily: fonts.sans,
                  fontWeight: 600,
                  cursor: busy ? "default" : "pointer",
                }}
              >
                <IconReroll size={11} />
                Reroll →
              </button>
            </div>
          </Subsection>

          <div style={{ padding: "12px 14px", background: colors.bgPanelHeader }}>
            <button
              type="button"
              disabled={busy}
              onClick={onBake}
              style={{
                width: "100%",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                background: busy ? "transparent" : colors.accent,
                border: `1px solid ${busy ? colors.borderSoft : colors.accent}`,
                borderRadius: radii.xs,
                color: busy ? colors.textMuted : "#1b1e24",
                padding: "10px 14px",
                fontSize: 11,
                letterSpacing: "0.32em",
                textTransform: "uppercase",
                fontFamily: fonts.sans,
                fontWeight: 700,
                cursor: busy ? "default" : "pointer",
                transition: "background 140ms",
                boxShadow: "none",
              }}
            >
              <IconBake size={14} />
              {busy ? "Baking…" : "Bake planet →"}
            </button>
          </div>
        </>
      )}
    </aside>
  );
}

function Subsection({ icon, label, hint, children }: { icon: React.ReactNode; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: "12px 14px", borderBottom: `1px solid ${colors.borderMid}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {icon}
          <span style={{ fontSize: 10, color: colors.textPrimary, letterSpacing: "0.24em", textTransform: "uppercase", fontWeight: 600 }}>
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

function ChipRow({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>{children}</div>;
}

function Chip({ active, onClick, disabled, children, small }: {
  active: boolean; onClick: () => void; disabled?: boolean; children: React.ReactNode; small?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        background: active ? colors.accentDim : "rgba(255,255,255,0.03)",
        border: `1px solid ${active ? colors.accent : colors.borderMid}`,
        borderRadius: radii.xs,
        color: active ? colors.accent : colors.textSecondary,
        padding: small ? "4px 10px" : "5px 10px",
        fontSize: small ? 11 : 11,
        fontFamily: small ? "JetBrains Mono, Consolas, monospace" : fonts.sans,
        fontWeight: active ? 600 : 500,
        letterSpacing: "0.02em",
        cursor: disabled ? "default" : "pointer",
        transition: "background 90ms, border-color 90ms, color 90ms",
        minWidth: small ? 32 : "auto",
        textAlign: "center",
      }}
    >
      {children}
    </button>
  );
}
