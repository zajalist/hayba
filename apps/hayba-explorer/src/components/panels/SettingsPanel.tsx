import React from "react";
import PropertyRow from "../PropertyRow";
import PropertySection from "../PropertySection";
import PropertyStack from "../PropertyStack";
import Select from "../Select";
import Toggle from "../Toggle";
import type { Fidelity } from "../../viewport/bake/fidelity";

/**
 * @deprecated Map-mode UI now lives in the bottom-bar (`equirectMapModes.ts`).
 * The export is retained because `App.tsx` still imports the symbol; once
 * that import is removed this entire constant can be deleted.
 */
export const MAP_MODES: { value: number; label: string }[] = [
  { value: 0,  label: "Final render" },
  { value: 1,  label: "Temperature" },
  { value: 2,  label: "Precipitation" },
  { value: 3,  label: "Biome" },
  { value: 4,  label: "Elevation" },
  { value: 5,  label: "Slope" },
  { value: 6,  label: "Ocean mask" },
  { value: 7,  label: "Insolation" },
  { value: 8,  label: "Base temp" },
  { value: 9,  label: "Distance to ocean" },
  { value: 10, label: "Ocean current ΔT" },
  { value: 11, label: "Orographic (rain shadow)" },
  { value: 12, label: "Continental dryness" },
];

export interface SettingsPanelProps {
  showPlateLabels: boolean;
  showForceArrows: boolean;
  onToggleLabels: (v: boolean) => void;
  onToggleArrows: (v: boolean) => void;
  /** @deprecated kept for App.tsx compatibility; no longer surfaced in the UI. */
  mapMode: number;
  /** @deprecated kept for App.tsx compatibility; no longer surfaced in the UI. */
  onChangeMapMode: (n: number) => void;
  fidelity: Fidelity;
  onChangeFidelity: (f: Fidelity) => void;
  seaLevel: number;
  onChangeSeaLevel: (v: number) => void;
}

export default function SettingsPanel(p: SettingsPanelProps) {
  return (
    <div style={{ flex: 1, overflowY: "auto" }}>
      <PropertySection heading="Performance">
        <PropertyRow
          label="Fidelity"
          value={
            <Select<Fidelity>
              value={p.fidelity}
              onChange={p.onChangeFidelity}
              options={[
                { value: "low",    label: "Low (1024²)" },
                { value: "medium", label: "Medium (2048²)" },
                { value: "high",   label: "High (2560²)" },
              ]}
            />
          }
        />
        <PropertyStack
          label="Sea level"
          value={p.seaLevel.toFixed(3)}
          noSeparator
        >
          <input
            type="range"
            min={-0.2}
            max={0.3}
            step={0.005}
            value={p.seaLevel}
            onChange={(e) => p.onChangeSeaLevel(parseFloat(e.target.value))}
            aria-label="Sea level offset (applied at next bake)"
            style={{ width: "100%" }}
          />
        </PropertyStack>
      </PropertySection>
      <PropertySection heading="Viewport overlays">
        <PropertyRow
          label="Plate labels"
          value={
            <Toggle
              checked={p.showPlateLabels}
              onChange={p.onToggleLabels}
              ariaLabel="Toggle plate labels"
            />
          }
        />
        <PropertyRow
          label="Force arrows"
          noSeparator
          value={
            <Toggle
              checked={p.showForceArrows}
              onChange={p.onToggleArrows}
              ariaLabel="Toggle force arrows"
            />
          }
        />
      </PropertySection>
    </div>
  );
}
