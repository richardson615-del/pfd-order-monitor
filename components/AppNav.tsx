"use client";

/**
 * The app's sections, one control for three screens (partner portal A2,
 * 2026-10-24; Matt: "the partner portal need to be part of their app ... use
 * same login online to see on computer", then "make mobile friendly too").
 *
 *   - Tablet (the kitchen): the segmented control it has always been.
 *   - Phone (640px and narrower): a bar along the bottom, icon over a short
 *     word, in thumb reach.
 *   - Computer (wide AND a mouse - a landscape kitchen tablet is wide too,
 *     but its pointer is a finger): a column down the left.
 *
 * Same buttons in all three; only CSS moves them (globals.css, "APP NAV").
 */

export type TabKey = "orders" | "completed" | "past" | "stats" | "menu" | "money" | "store";

export interface NavTab {
  key: TabKey;
  label: string;
  short: string;
  count?: number | null;
  /** A dot on the icon - something on that tab wants a look (the store is paused). */
  flag?: boolean;
}

const ICON_PATHS: Record<TabKey, string> = {
  // A ticket
  orders: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6",
  // A tick in a circle
  completed: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.5l2.5 2.5L16 9.5",
  // A calendar
  past: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  // Bars
  stats: "M5 20V11M12 20V5M19 20v-6",
  // A list
  menu: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  // A banknote
  money: "M3 7h18v10H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 10v4M18 10v4",
  // A shop front
  store: "M4 10v10h16V10M3 10l2-6h14l2 6zM9 20v-6h6v6",
};

function NavIcon({ name }: { name: TabKey }) {
  return (
    <svg className="app-tab-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

export default function AppNav({ tabs, active, onSelect }: { tabs: NavTab[]; active: TabKey; onSelect: (key: TabKey) => void }) {
  return (
    <nav className="app-tabs" aria-label="Sections">
      <div className="app-tabs-track" role="tablist">
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={active === t.key} aria-label={t.count != null ? `${t.label}, ${t.count}` : t.label} className={`app-tab ${active === t.key ? "active" : ""}`} onClick={() => onSelect(t.key)}>
            <span className="app-tab-iconwrap">
              <NavIcon name={t.key} />
              {t.flag && <span className="app-tab-flag" aria-hidden="true" />}
            </span>
            <span className="app-tab-label">{t.label}</span>
            <span className="app-tab-short" aria-hidden="true">{t.short}</span>
            {t.count != null && <span className={`app-tab-n num${t.count === 0 ? " zero" : ""}`}>{t.count}</span>}
          </button>
        ))}
      </div>
    </nav>
  );
}
