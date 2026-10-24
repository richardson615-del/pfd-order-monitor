"use client";

import { useEffect, useState } from "react";
import { cents, moneySummary, statusLabel, weekLabel, type StatementView } from "@/lib/statements";

/**
 * Money: the restaurant's weekly statements from Premium (migration 051).
 *
 * The first page of the partner portal (prs-crm brief 2026-10-24, A1).
 * Read-only: each closed week as the CRM pushed it - orders, what Premium
 * owes, paid or not, and the statement itself, which opens on the CRM's
 * own link (the same one the statement email carries). No figure is
 * computed here; a week the CRM has not pushed is simply not listed.
 *
 * Fetched when the tab is opened, like Past week: it is money, not a live
 * order list, and it changes once a week.
 */
export default function MoneyTab() {
  const [rows, setRows] = useState<StatementView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/dashboard/statements", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || !Array.isArray(data?.statements)) {
          setError(data?.error ?? "Could not load your statements.");
          return;
        }
        setRows(data.statements);
      } catch {
        if (!cancelled) setError("Could not reach the server.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const summary = rows ? moneySummary(rows) : null;

  return (
    <div className="money-tab">
      <div className="menu-head">
        <div>
          <div className="menu-title">Money</div>
          <div className="menu-sub">What Premium owes you each week, and when it was paid. Same page on a computer: sign in at this address with your tablet username.</div>
        </div>
      </div>

      {error && (
        <p className="app-empty" role="status">
          {error}
        </p>
      )}
      {!rows && !error && <p className="app-empty">Loading your statements…</p>}

      {summary && rows && rows.length > 0 && (
        <div className="money-strip" role="status">
          <div className="money-stat">
            <span className="money-stat-label">Coming to you</span>
            <span className="money-stat-value num">{cents(summary.owedCents)}</span>
            <span className="money-stat-sub">{summary.owedWeeks === 0 ? "Nothing outstanding" : `${summary.owedWeeks} ${summary.owedWeeks === 1 ? "week" : "weeks"} not yet paid`}</span>
          </div>
          <div className="money-stat">
            <span className="money-stat-label">Last paid</span>
            <span className="money-stat-value num">{summary.lastPaid ? cents(summary.lastPaid.amount_due_cents) : "—"}</span>
            <span className="money-stat-sub">{summary.lastPaid ? `Week of ${weekLabel(summary.lastPaid.period_start, summary.lastPaid.period_end)}` : "No paid week yet"}</span>
          </div>
        </div>
      )}

      {rows && rows.length === 0 && (
        <p className="app-empty">No statements yet. Your first one appears here after your first full week of orders closes.</p>
      )}

      {rows && rows.length > 0 && (
        <div className="money-list" role="list">
          {rows.map((s) => {
            const st = statusLabel(s);
            return (
              <div key={s.period_start} className="money-row" role="listitem">
                <div className="money-week">
                  <span className="money-week-label">{weekLabel(s.period_start, s.period_end)}</span>
                  <span className="money-week-sub">
                    <span className="num">{s.order_count}</span> {s.order_count === 1 ? "order" : "orders"} · statement {s.statement_no}
                    {s.payment_status === "paid" && s.paid_at ? ` · paid ${new Date(s.paid_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
                    {s.payment_status !== "paid" && s.payment_date ? ` · pays ${weekLabel(s.payment_date, s.payment_date).split(" - ")[0]}` : ""}
                  </span>
                </div>
                <div className="money-right">
                  <span className={`money-chip ${st.tone}`}>{st.label}</span>
                  <span className="money-amount num">{cents(s.amount_due_cents)}</span>
                  {s.view_url ? (
                    <a className="btn small" href={s.view_url} target="_blank" rel="noopener noreferrer">
                      Open
                    </a>
                  ) : (
                    <span className="money-chip muted">No statement</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="week-foot">Questions about a payment? Message dispatch from the Orders tab, or call Premium on (615) 619-5081.</p>
    </div>
  );
}
