import React from "react";
import PropertyRow from "../PropertyRow";
import PropertySection from "../PropertySection";

export interface SettingsPanelProps {
  showPlateLabels: boolean;
  showForceArrows: boolean;
  onToggleLabels: (v: boolean) => void;
  onToggleArrows: (v: boolean) => void;
}

export default function SettingsPanel(p: SettingsPanelProps) {
  return (
    <div style={{ flex: 1, overflowY: "auto" }}>
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
