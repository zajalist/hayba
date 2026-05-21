import React from "react";
import { colors, fonts, fontSize } from "@hayba/design-tokens";
import CategoryStrip, { type PanelCategory } from "./CategoryStrip";
import { PropertySearchProvider } from "./propertySearch";

export interface RightPanelProps {
  active: PanelCategory;
  enabled: Record<PanelCategory, boolean>;
  disabledReason?: Partial<Record<PanelCategory, string>>;
  onPick: (cat: PanelCategory) => void;
  /** Panel body — typically one of the panels/*Panel components. */
  children: React.ReactNode;
}

const TITLES: Record<PanelCategory, { title: string; subtitle: string }> = {
  compose:    { title: "Compose",    subtitle: "Initial conditions" },
  texturing:  { title: "Texturing",  subtitle: "Per-biome SatMaps" },
  climate:    { title: "Climate Lab", subtitle: "Tune the model" },
  boundaries: { title: "Boundaries", subtitle: "Post-bake plate seams" },
  densities:  { title: "Densities",  subtitle: "Rank plates by density" },
  simulate:   { title: "Simulate",   subtitle: "Run the tectonic clock" },
  settings:   { title: "Settings",   subtitle: "App preferences" },
};

/** UE5-style Details panel shell. The header carries title + subtitle, then a
 *  thin search input below that filters PropertyRow / PropertyStack matches
 *  through React context (see propertySearch.tsx). Reset on category change. */
export default function RightPanel({ active, enabled, disabledReason, onPick, children }: RightPanelProps) {
  const meta = TITLES[active];
  const [query, setQuery] = React.useState<string>("");
  // Clear the query whenever the user switches categories — otherwise stale
  // filters silently hide the new panel's rows on mount.
  React.useEffect(() => { setQuery(""); }, [active]);
  return (
    <div style={{
      display: "flex",
      height: "100%",
      background: colors.bgPanel,
      borderLeft: `1px solid ${colors.borderSubtle}`,
      color: colors.textPrimary,
      fontFamily: fonts.sans,
    }}>
      <CategoryStrip active={active} enabled={enabled} disabledReason={disabledReason} onPick={onPick} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          padding: "10px 8px",
          gap: 10,
          borderBottom: `1px solid ${colors.borderSubtle}`,
          background: colors.bgPanelHeader,
        }}>
          <span style={{ fontSize: 13, color: colors.textValue, fontWeight: 600 }}>{meta.title}</span>
          <span style={{ fontSize: 11, color: colors.textMuted }}>{meta.subtitle}</span>
        </div>
        {/* UE5 Details-panel search bar — sits directly under the title, no border on focus. */}
        <div style={{
          padding: "6px 8px",
          background: colors.bgPanelHeader,
          borderBottom: `1px solid ${colors.borderSubtle}`,
        }}>
          <div style={{ position: "relative" }}>
            <span
              aria-hidden
              style={{
                position: "absolute",
                left: 6,
                top: "50%",
                transform: "translateY(-50%)",
                color: colors.textMuted,
                display: "inline-flex",
                pointerEvents: "none",
              }}
            >
              <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </span>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="Search"
              aria-label="Filter properties"
              style={{
                width: "100%",
                boxSizing: "border-box",
                height: 22,
                padding: "0 22px 0 22px",
                background: colors.bgDeep,
                border: "none",
                outline: "none",
                color: colors.textValue,
                fontFamily: fonts.sans,
                fontSize: fontSize.label,
                borderRadius: 3,
              }}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                title="Clear"
                style={{
                  position: "absolute",
                  right: 4,
                  top: "50%",
                  transform: "translateY(-50%)",
                  width: 16,
                  height: 16,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "transparent",
                  border: "none",
                  color: colors.textMuted,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <PropertySearchProvider query={query}>{children}</PropertySearchProvider>
        </div>
      </div>
    </div>
  );
}
