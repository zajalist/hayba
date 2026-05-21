import React from "react";

/**
 * Lightweight context used to drive UE5-style Details-panel search:
 *
 *   - RightPanel writes the current search query.
 *   - PropertyRow / PropertyStack hide themselves on miss and announce the
 *     match to the nearest PropertySection via SectionVisibilityContext.
 *   - PropertySection counts announcements and hides itself when zero rows
 *     match (and the query is non-empty).
 *
 * Sections opt OUT of filtering by setting filterable=false (useful for
 * sections whose body is bespoke layout — e.g. brush-mode grid — rather
 * than PropertyRow rows).
 */
export interface PropertySearchValue {
  /** Lower-cased trimmed query. Empty string means "no filtering". */
  query: string;
}

const PropertySearchContext = React.createContext<PropertySearchValue>({ query: "" });

export function PropertySearchProvider({
  query,
  children,
}: {
  query: string;
  children: React.ReactNode;
}) {
  const value = React.useMemo<PropertySearchValue>(
    () => ({ query: query.trim().toLowerCase() }),
    [query],
  );
  return (
    <PropertySearchContext.Provider value={value}>{children}</PropertySearchContext.Provider>
  );
}

export function usePropertySearch(): PropertySearchValue {
  return React.useContext(PropertySearchContext);
}

/** Returns true when the row's label matches the active query, OR when no
 *  query is active. Case-insensitive substring match. */
export function rowMatches(label: string, query: string): boolean {
  if (!query) return true;
  return label.toLowerCase().includes(query);
}

// --- Section visibility ---------------------------------------------------

interface SectionVisibilityValue {
  register: (key: string, visible: boolean) => void;
}

const SectionVisibilityContext = React.createContext<SectionVisibilityValue | null>(null);

export function useSectionVisibility(): SectionVisibilityValue | null {
  return React.useContext(SectionVisibilityContext);
}

export function SectionVisibilityProvider({
  onCountChange,
  children,
}: {
  onCountChange: (visibleCount: number) => void;
  children: React.ReactNode;
}) {
  // Track each row's visibility in a ref + bump a counter to keep effects stable.
  const map = React.useRef<Map<string, boolean>>(new Map());
  const recompute = React.useCallback(() => {
    let visible = 0;
    for (const v of map.current.values()) if (v) visible++;
    onCountChange(visible);
  }, [onCountChange]);

  const value = React.useMemo<SectionVisibilityValue>(
    () => ({
      register: (key, visible) => {
        const prev = map.current.get(key);
        if (prev === visible) return;
        map.current.set(key, visible);
        recompute();
      },
    }),
    [recompute],
  );

  return (
    <SectionVisibilityContext.Provider value={value}>{children}</SectionVisibilityContext.Provider>
  );
}
