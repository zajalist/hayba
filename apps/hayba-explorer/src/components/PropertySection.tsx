import React from "react";
import { colors, easings, space, fontSize } from "@hayba/design-tokens";
import { SectionVisibilityProvider, usePropertySearch } from "./propertySearch";

export interface PropertySectionProps {
  /** Section label. Usually a string; ReactNode allows an interactive
   *  header (e.g. the Climate Lab's auto-pair toggle). */
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

/** UE5-style section header: thin 24px band with chevron + small-caps tracked label.
 *  Body renders flush — rows butt up to the section edges (no inner padding). */
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
  const [hover, setHover] = React.useState(false);
  const { query } = usePropertySearch();
  // Track how many child PropertyRow / PropertyStack rows currently match the
  // search query. When a query is active and the count is zero, hide the
  // section header entirely so search results read as a flat filtered list.
  const [visibleCount, setVisibleCount] = React.useState<number>(0);
  // When the section has no PropertyRow children at all (bespoke layouts —
  // e.g. brush-mode grid, Templates buttons), the counter stays at 0 even
  // without a query. Detect "no rows registered" by checking whether any
  // descendant ever called register().
  const seenAnyRef = React.useRef(false);
  const onCountChange = React.useCallback((n: number) => {
    if (n > 0) seenAnyRef.current = true;
    setVisibleCount(n);
  }, []);
  const hiddenByFilter =
    query.length > 0 && seenAnyRef.current && visibleCount === 0;

  const toggle = React.useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      writePersisted(panelId, sectionId, next);
      return next;
    });
  }, [panelId, sectionId]);

  // When a search query is active, force-expand so matching rows are visible.
  const expanded = query.length > 0 ? true : !collapsed;
  const baseHeader: React.CSSProperties = {
    height: space.sectionBandH,
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: `0 ${space.rowPadX}px`,
    background: hover ? colors.bgElevated : colors.bgSectionBand,
    borderBottom: `1px solid ${colors.borderSubtle}`,
    fontSize: fontSize.section,
    color: colors.textLabel,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    transition: `background 120ms ${easings.out}`,
  };

  const chevron = (
    <span
      aria-hidden
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 10,
        height: 10,
        color: colors.textLabel,
        opacity: 0.85,
        transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
        transition: `transform 140ms ${easings.out}`,
      }}
    >
      {/* Lucide chevron-down inline */}
      <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </span>
  );

  // Always render children once into a SectionVisibilityProvider so the
  // visible-row counter stays accurate even when the section is collapsed
  // (otherwise unmount nukes registrations and visibleCount drops to 0 → the
  // section gets mis-hidden by the filter). When collapsed we hide the body
  // via CSS instead of unmounting.
  const body = (
    <SectionVisibilityProvider onCountChange={onCountChange}>
      <div style={{ display: expanded ? "block" : "none" }}>{children}</div>
    </SectionVisibilityProvider>
  );

  if (hiddenByFilter) return <>{body}</>;

  if (!collapsible) {
    return (
      <div>
        <div
          style={baseHeader}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
        >
          {chevron}
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{heading}</span>
        </div>
        {body}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          ...baseHeader,
          border: "none",
          width: "100%",
          textAlign: "left",
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        {chevron}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{heading}</span>
      </button>
      {body}
    </div>
  );
}
