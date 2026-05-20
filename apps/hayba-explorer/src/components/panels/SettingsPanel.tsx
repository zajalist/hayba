import React from "react";
import PropertyRow from "../PropertyRow";
import PropertySection from "../PropertySection";
import type { Fidelity } from "../../viewport/bake/fidelity";

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
  mapMode: number;
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
            <select
              aria-label="Bake fidelity"
              value={p.fidelity}
              onChange={(e) => p.onChangeFidelity(e.target.value as Fidelity)}
            >
              <option value="low">Low — fastest (1024²)</option>
              <option value="medium">Medium (2048²)</option>
              <option value="high">High — slowest (2560²)</option>
            </select>
          }
        />
        <PropertyRow
          label={`Sea level (${p.seaLevel.toFixed(3)})`}
          noSeparator
          value={
            <input
              type="range"
              min={-0.2}
              max={0.3}
              step={0.005}
              value={p.seaLevel}
              onChange={(e) => p.onChangeSeaLevel(parseFloat(e.target.value))}
              aria-label="Sea level offset (applied at next bake)"
            />
          }
        />
      </PropertySection>
      <PropertySection heading="Viewport overlays">
        <PropertyRow
          label="Plate labels"
          value={
            <input
              type="checkbox"
              checked={p.showPlateLabels}
              onChange={(e) => p.onToggleLabels(e.target.checked)}
              aria-label="Toggle plate labels"
            />
          }
        />
        <PropertyRow
          label="Force arrows"
          noSeparator
          value={
            <input
              type="checkbox"
              checked={p.showForceArrows}
              onChange={(e) => p.onToggleArrows(e.target.checked)}
              aria-label="Toggle force arrows"
            />
          }
        />
      </PropertySection>
    </div>
  );
}
