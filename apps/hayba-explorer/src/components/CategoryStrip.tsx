import React from "react";
import { colors } from "@hayba/design-tokens";
import { ICON_URLS } from "./icons";

export type PanelCategory = "compose" | "paint-heights" | "boundaries" | "densities" | "simulate" | "settings";

export interface CategoryStripProps {
  active: PanelCategory;
  /** Which categories are currently selectable (others render disabled). */
  enabled: Record<PanelCategory, boolean>;
  /** Optional tooltips shown on disabled categories ("Bake the planet to edit boundaries"). */
  disabledReason?: Partial<Record<PanelCategory, string>>;
  onPick: (cat: PanelCategory) => void;
}

interface Item {
  id: PanelCategory;
  label: string;
  icon: string;
  bottom?: boolean;
}

const ITEMS: Item[] = [
  { id: "compose",       label: "Compose",       icon: ICON_URLS.categoryCompose },
  { id: "paint-heights", label: "Paint heights", icon: ICON_URLS.categoryCompose },
  { id: "boundaries",    label: "Boundaries",    icon: ICON_URLS.categoryBoundaries },
  { id: "densities",  label: "Densities",  icon: ICON_URLS.categoryDensities },
  { id: "simulate",   label: "Simulate",   icon: ICON_URLS.categorySimulate },
  { id: "settings",   label: "Settings",   icon: ICON_URLS.categorySettings, bottom: true },
];

export default function CategoryStrip({ active, enabled, disabledReason, onPick }: CategoryStripProps) {
  const top    = ITEMS.filter((i) => !i.bottom);
  const bottom = ITEMS.filter((i) =>  i.bottom);

  const renderButton = (item: Item) => {
    const isActive  = item.id === active;
    const isEnabled = enabled[item.id];
    const tooltip   = !isEnabled ? disabledReason?.[item.id] ?? "" : item.label;
    return (
      <button
        key={item.id}
        type="button"
        title={tooltip}
        disabled={!isEnabled}
        onClick={() => isEnabled && onPick(item.id)}
        style={{
          height: 42,
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: isActive ? colors.bgBase : "transparent",
          border: "none",
          borderLeft: `2px solid ${isActive ? colors.accent : "transparent"}`,
          color: isActive ? colors.beige : colors.textSecondary,
          opacity: isEnabled ? 1 : 0.4,
          cursor: isEnabled ? "pointer" : "not-allowed",
          padding: 0,
        }}
      >
        <img
          src={item.icon}
          alt={item.label}
          width={18}
          height={18}
          style={{ filter: "brightness(0) invert(1)", opacity: isActive ? 1 : 0.75 }}
        />
      </button>
    );
  };

  return (
    <div style={{
      width: 44,
      background: colors.bgCategoryStrip,
      borderRight: `1px solid ${colors.borderMid}`,
      display: "flex",
      flexDirection: "column",
      paddingTop: 6,
    }}>
      {top.map(renderButton)}
      <div style={{ flex: 1 }} />
      {bottom.map(renderButton)}
    </div>
  );
}
