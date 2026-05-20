import React from "react";
import { colors, easings } from "@hayba/design-tokens";

export interface PropertySectionProps {
  /** Section label. Usually a string; ReactNode allows an interactive
   *  header (e.g. the Climate Lab's auto-pair 📊 toggle). */
  heading: React.ReactNode;
  children: React.ReactNode;
  /** Make the heading clickable to collapse/expand the body. Defaults to
   *  non-collapsible (existing behaviour). */
  collapsible?: boolean;
  /** Stable id used to persist collapsed state under
   *  `hayba.panel.<panel>.<sectionId>.collapsed`. Required when
   *  `collapsible` is true. */
  panelId?: string;
  sectionId?: string;
  /** If true, the section starts collapsed on first render (overridden by
   *  any persisted localStorage value). */
  defaultCollapsed?: boolean;
}

const storageKey = (panel: string, section: string): string =>
  `hayba.panel.${panel}.${section}.collapsed`;

const readPersisted = (panel: string | undefined, section: string | undefined): boolean | null => {
  if (!panel || !section) return null;
  try {
    const raw = localStorage.getItem(storageKey(panel, section));
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  } catch {
    return null;
  }
};

const writePersisted = (panel: string | undefined, section: string | undefined, collapsed: boolean): void => {
  if (!panel || !section) return;
  try {
    localStorage.setItem(storageKey(panel, section), collapsed ? "1" : "0");
  } catch { /* noop — quota / private mode */ }
};

/** Small-caps tracked heading + row group. Only place letter-spacing is allowed.
 *
 *  When `collapsible` is set, the heading becomes a button that toggles the
 *  body open/closed with a chevron indicator. The collapsed/expanded state
 *  is persisted per (panelId, sectionId) in localStorage. */
export default function PropertySection({
  heading,
  children,
  collapsible,
  panelId,
  sectionId,
  defaultCollapsed,
}: PropertySectionProps) {
  const [collapsed, setCollapsed] = React.useState<boolean>(() => {
    const persisted = readPersisted(panelId, sectionId);
    if (persisted !== null) return persisted;
    return collapsible ? !!defaultCollapsed : false;
  });

  const toggle = React.useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      writePersisted(panelId, sectionId, next);
      return next;
    });
  }, [panelId, sectionId]);

  const baseHeader: React.CSSProperties = {
    fontSize: 10,
    color: colors.beige,
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    opacity: 0.7,
    padding: "8px 16px 6px",
  };

  if (!collapsible) {
    return (
      <div style={{ marginTop: 12 }}>
        <div style={baseHeader}>{heading}</div>
        {children}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        style={{
          ...baseHeader,
          background: "transparent",
          border: "none",
          width: "100%",
          textAlign: "left",
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: 10,
            color: colors.beige,
            opacity: 0.55,
            transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
            transition: `transform 140ms ${easings.out}`,
          }}
        >
          ▶
        </span>
        <span style={{ flex: 1 }}>{heading}</span>
      </button>
      {!collapsed && children}
    </div>
  );
}
