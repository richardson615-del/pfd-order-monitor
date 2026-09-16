"use client";

import { useEffect, useState } from "react";
import CompletedRow from "./CompletedRow";
import { money, type HistoryDay } from "@/lib/history";

/**
 * Past week: seven day tiles, and the selected day's orders under them.
 *
 * Read-only, counts and totals. Fetched when the tab is opened rather than
 * with the live list - it is history, it does not need to be live, and the
 * realtime channel is for orders that are happening. The server groups the
 * days in the restaurant's timezone (lib/history.ts); this only draws.
 *
 * Older than a week lives in the Premium statement, and the footer says so
 * rather than offering a "load more" that would turn a kitchen tablet into
 * a reporting tool.
 */
export default function PastWeek({ timezone }: { timezone: string | null | undefined }) {
  const [days, setDays] = useState<HistoryDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/dashboard/history", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || !Array.isArray(data?.days)) {
          setError(data?.error ?? "Could not load the week.");
          return;
        }
        setDays(data.days);
        setSelected((s) => s ?? data.days[data.days.length - 1]?.key ?? null);
      } catch {
        if (!cancelled) setError("Could not reach the server.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const day = days?.find((d) => d.key === selected) ?? null;

  return (
    <div className="week">
      {error && (
        <p className="app-empty" role="status">
          {error}
        </p>
      )}
      {!days && !error && <p className="app-empty">Loading the week…</p>}

      {days && (
        <div className="week-tiles" role="tablist">
          {days.map((d) => (
            <button
              key={d.key}
              role="tab"
              aria-selected={d.key === selected}
              className={`week-tile ${d.key === selected ? "active" : ""}`}
              onClick={() => setSelected(d.key)}
            >
              <span className="week-day">{d.label}</span>
              <span className="week-count num">{d.count}</span>
              <span className="week-total num">{money(d.total)}</span>
            </button>
          ))}
        </div>
      )}

      {day && (
        <>
          <div className="app-hero done" role="status">
            <b className="num">{day.count}</b> {day.count === 1 ? "order" : "orders"} {day.label === "Today" ? "today" : `on ${day.label}`}
            {day.count > 0 && (
              <>
                {" "}· <span className="num">{money(day.total)}</span>
              </>
            )}
          </div>
          <div className="app-list completed">
            {day.orders.length === 0 && <div className="app-empty">No orders that day.</div>}
            {day.orders.map((o) => (
              <CompletedRow key={o.id} order={o} timezone={timezone} />
            ))}
            {day.truncated && <div className="app-empty">Showing the first {day.orders.length}. The full day is in your Premium statement.</div>}
          </div>
        </>
      )}

      <p className="week-foot">Older history is in your Premium statement.</p>
    </div>
  );
}
