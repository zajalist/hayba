import React from "react";
import PropertyRow from "../PropertyRow";
import PropertySection from "../PropertySection";
import Select from "../Select";
import { SATMAP_NAMES, BIOME_SLOTS, type SatMapName } from "../../viewport/satmap-loader";

export interface TexturingPanelProps {
  assignments: Record<number, SatMapName>;
  onAssign: (biomeIndex: number, name: SatMapName) => void;
}

export default function TexturingPanel(p: TexturingPanelProps): React.ReactElement {
  const opts = SATMAP_NAMES.map((n) => ({ value: n, label: n }));
  return (
    <div style={{ flex: 1, overflowY: "auto" }}>
      <PropertySection heading="Biome SatMaps">
        {BIOME_SLOTS.map((b, i) => (
          <PropertyRow
            key={b.index}
            label={b.label}
            noSeparator={i === BIOME_SLOTS.length - 1}
            value={
              <Select<SatMapName>
                value={p.assignments[b.index] ?? b.defaultName}
                onChange={(v) => p.onAssign(b.index, v)}
                options={opts}
              />
            }
          />
        ))}
      </PropertySection>
    </div>
  );
}
