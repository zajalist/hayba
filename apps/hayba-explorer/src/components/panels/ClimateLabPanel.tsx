import React from "react";
import { colors, fonts } from "@hayba/design-tokens";
import PropertySection from "../PropertySection";
import PropertyStack from "../PropertyStack";

// ─────────────────────────────────────────────────────────────────────────
// Climate parameters — 1:1 with the Rust `ClimateParams` struct. Every
// default is byte-identical to the constant / inline magic it replaces, so
// shipping DEFAULT_CLIMATE_PARAMS reproduces today's climate exactly until
// the user moves a slider. Field names are camelCase here; Tauri converts
// them to the snake_case Rust struct fields on the wire.
// ─────────────────────────────────────────────────────────────────────────
export interface ClimateParams {
  tEquator: number;
  tLatDrop: number;
  lapseCPerKm: number;
  elevKmScale: number;
  continentalCool: number;
  currentWarm: number;
  currentCold: number;
  moistureDecay: number;
  itczWidthDeg: number;
  orographicGain: number;
  rainShadow: number;
  biomeColdC: number;
  biomeHotC: number;
}

export const DEFAULT_CLIMATE_PARAMS: ClimateParams = {
  tEquator: 30.0,
  tLatDrop: 50.0,
  lapseCPerKm: 4.46,
  elevKmScale: 8.0,
  continentalCool: 6.0,
  currentWarm: 12.0,
  currentCold: 10.0,
  moistureDecay: 0.94,
  itczWidthDeg: 16.0,
  orographicGain: 0.6,
  rainShadow: 0.5,
  biomeColdC: 6.0,
  biomeHotC: 18.0,
};

// Map-mode value (matches SettingsPanel.MAP_MODES) per diagnostic group, so
// focusing a section auto-pairs the on-canvas Map dropdown to its mask.
type MapModeValue = number;

interface FieldSpec {
  key: keyof ClimateParams;
  label: string;
  min: number;
  max: number;
  step: number;
  fmt?: (v: number) => string;
}

interface GroupSpec {
  heading: string;
  /** Map mode the on-canvas viewport switches to when this group is focused. */
  mapMode: MapModeValue;
  fields: FieldSpec[];
}

const GROUPS: GroupSpec[] = [
  {
    heading: "Temperature",
    mapMode: 1, // Temperature
    fields: [
      { key: "tEquator", label: "Equator mean °C", min: 10, max: 40, step: 0.5 },
      { key: "tLatDrop", label: "Equator→pole drop °C", min: 20, max: 80, step: 0.5 },
      { key: "lapseCPerKm", label: "Lapse °C / km", min: 2, max: 9, step: 0.01 },
      { key: "elevKmScale", label: "Elev → km scale", min: 2, max: 16, step: 0.1 },
    ],
  },
  {
    heading: "Moisture",
    mapMode: 2, // Precipitation
    fields: [
      { key: "moistureDecay", label: "Downwind decay", min: 0.8, max: 0.99, step: 0.005, fmt: (v) => v.toFixed(3) },
      { key: "itczWidthDeg", label: "ITCZ width °", min: 6, max: 30, step: 0.5 },
    ],
  },
  {
    heading: "Orographic",
    mapMode: 11, // Orographic (rain shadow)
    fields: [
      { key: "orographicGain", label: "Windward gain", min: 0, max: 1.5, step: 0.01 },
      { key: "rainShadow", label: "Lee rain shadow", min: 0, max: 1.5, step: 0.01 },
    ],
  },
  {
    heading: "Continentality",
    mapMode: 12, // Continental dryness
    fields: [
      { key: "continentalCool", label: "Inland cooling °C", min: 0, max: 15, step: 0.1 },
    ],
  },
  {
    heading: "Currents",
    mapMode: 10, // Ocean current ΔT
    fields: [
      { key: "currentWarm", label: "Warm current cap °C", min: 0, max: 25, step: 0.5 },
      { key: "currentCold", label: "Cold current cap °C", min: 0, max: 25, step: 0.5 },
    ],
  },
  {
    heading: "Biome",
    mapMode: 3, // Biome
    fields: [
      { key: "biomeColdC", label: "Boreal/tundra °C", min: -5, max: 15, step: 0.5 },
      { key: "biomeHotC", label: "Tropical onset °C", min: 12, max: 28, step: 0.5 },
    ],
  },
];

// Named world presets. Earth = the defaults (byte-identical to today). The
// others scale the high-value knobs to a recognisable climate regime.
const PRESETS: Record<string, ClimateParams> = {
  Earth: { ...DEFAULT_CLIMATE_PARAMS },
  Arid: {
    ...DEFAULT_CLIMATE_PARAMS,
    tEquator: 34.0,
    tLatDrop: 46.0,
    moistureDecay: 0.86,
    itczWidthDeg: 10.0,
    orographicGain: 0.45,
    rainShadow: 0.85,
    continentalCool: 9.0,
    biomeHotC: 16.0,
  },
  Ice: {
    ...DEFAULT_CLIMATE_PARAMS,
    tEquator: 16.0,
    tLatDrop: 58.0,
    lapseCPerKm: 5.5,
    continentalCool: 10.0,
    currentWarm: 8.0,
    currentCold: 14.0,
    biomeColdC: 10.0,
    biomeHotC: 22.0,
  },
  Ocean: {
    ...DEFAULT_CLIMATE_PARAMS,
    tEquator: 29.0,
    tLatDrop: 44.0,
    moistureDecay: 0.97,
    itczWidthDeg: 22.0,
    orographicGain: 0.75,
    rainShadow: 0.35,
    continentalCool: 3.0,
    currentWarm: 15.0,
  },
  Hothouse: {
    ...DEFAULT_CLIMATE_PARAMS,
    tEquator: 38.0,
    tLatDrop: 36.0,
    lapseCPerKm: 4.0,
    moistureDecay: 0.96,
    itczWidthDeg: 24.0,
    continentalCool: 4.0,
    biomeColdC: 2.0,
    biomeHotC: 14.0,
  },
};

export interface ClimateLabPanelProps {
  params: ClimateParams;
  onChange: (next: ClimateParams) => void;
  /** Auto-pair: focusing a group switches the on-canvas Map mode to its mask. */
  onFocusGroup: (mapMode: MapModeValue) => void;
}

/** Post-bake climate tuning. Grouped sliders + world presets + auto-pair:
 *  focusing a section header (📊) flips the on-canvas Map dropdown to the
 *  matching diagnostic mask so the change is immediately legible. */
export default function ClimateLabPanel(p: ClimateLabPanelProps): React.ReactElement {
  const set = (key: keyof ClimateParams, v: number): void => {
    p.onChange({ ...p.params, [key]: v });
  };

  const applyPreset = (name: string): void => {
    const preset = PRESETS[name];
    if (preset) p.onChange({ ...preset });
  };

  const sliderStyle: React.CSSProperties = { flex: 1, accentColor: colors.accent };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Presets + reset-all (fixed top) */}
      <div style={{ padding: "10px 12px 8px", borderBottom: `1px solid ${colors.borderMid}` }}>
        <div style={{ fontSize: 11, color: colors.textMuted, marginBottom: 4 }}>World preset</div>
        <div style={{ display: "flex", gap: 6 }}>
          <select
            defaultValue="Earth"
            onChange={(e) => applyPreset(e.target.value)}
            style={{
              flex: 1,
              padding: "4px 6px",
              fontSize: 11,
              fontFamily: fonts.sans,
              background: colors.bgBase,
              color: colors.beige,
              border: `1px solid ${colors.borderMid}`,
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            {Object.keys(PRESETS).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <button
            type="button"
            title="Reset every parameter to the Earth defaults"
            onClick={() => p.onChange({ ...DEFAULT_CLIMATE_PARAMS })}
            style={{
              padding: "4px 10px",
              fontSize: 11,
              fontFamily: fonts.sans,
              background: "transparent",
              color: colors.beige,
              border: `1px solid ${colors.borderSoft}`,
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            Reset all
          </button>
        </div>
      </div>

      {/* Grouped sliders (scrollable). Each section is collapsible — the
          first group (Temperature) defaults open, the rest collapsed, to
          shorten the panel since Climate Lab has 6+ sections. */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {GROUPS.map((g, gi) => (
          <PropertySection
            key={g.heading}
            collapsible
            panelId="climate"
            sectionId={g.heading.toLowerCase()}
            defaultCollapsed={gi !== 0}
            heading={
              <span
                role="button"
                tabIndex={0}
                title={`Show the ${g.heading} diagnostic mask on the planet`}
                onFocus={() => p.onFocusGroup(g.mapMode)}
                onClick={(e) => {
                  // Emit the map-mode side-effect, then let the click
                  // bubble to the surrounding header button so the
                  // section still toggles collapse.
                  p.onFocusGroup(g.mapMode);
                  e.stopPropagation();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") p.onFocusGroup(g.mapMode);
                }}
                style={{ cursor: "pointer", outline: "none" }}
              >
                {g.heading} <span style={{ opacity: 0.6 }}>📊</span>
              </span>
            }
          >
            {g.fields.map((f, fi) => {
              const v = p.params[f.key];
              const def = DEFAULT_CLIMATE_PARAMS[f.key];
              const fmt = f.fmt ?? ((x: number) => x.toFixed(2));
              return (
                <PropertyStack
                  key={f.key}
                  label={f.label}
                  value={fmt(v)}
                  noSeparator={fi === g.fields.length - 1}
                >
                  <input
                    type="range"
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    value={v}
                    onFocus={() => p.onFocusGroup(g.mapMode)}
                    onChange={(e) => set(f.key, Number(e.target.value))}
                    style={sliderStyle}
                    aria-label={f.label}
                  />
                  <button
                    type="button"
                    title={`Reset ${f.label} to ${fmt(def)}`}
                    onClick={() => set(f.key, def)}
                    disabled={v === def}
                    style={{
                      width: 18,
                      height: 18,
                      marginLeft: 6,
                      padding: 0,
                      fontSize: 10,
                      lineHeight: "16px",
                      background: "transparent",
                      color: v === def ? colors.textMuted : colors.beige,
                      border: `1px solid ${colors.borderSoft}`,
                      borderRadius: 2,
                      cursor: v === def ? "default" : "pointer",
                      opacity: v === def ? 0.4 : 1,
                    }}
                  >
                    ↺
                  </button>
                </PropertyStack>
              );
            })}
          </PropertySection>
        ))}

        {/* TODO: 2-D Whittaker editor (see QA doc §B4) */}
      </div>
    </div>
  );
}
