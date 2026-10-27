"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { centsLabel, type SalesReceipt, type SalesReport, type SalesRow } from "@/lib/sales";
import { SALES_PERIODS, includesToday, periodRange, type SalesPeriod } from "@/lib/sales-periods";

/**
 * Sales (PA6, 2026-10-27): what the restaurant sold, for any period.
 *
 * Replaces Past week. Chef's Market asked to see every transaction after an
 * item went through uncharged; Matt: "easy to use and not cluttered". So:
 * one row of period chips, one summary, a calm line when something needs a
 * look, the orders, and a CSV button. Everything else (by day, channels,
 * payments, best sellers) sits behind "More detail", closed by default.
 *
 * The server does the adding up (lib/sales.ts); this only draws. A period
 * that includes today refreshes itself every minute.
 */
export default function SalesTab({ timezone }: { timezone: string | null | undefined }) {
  const [period, setPeriod] = useState<SalesPeriod>("today");
  const [report, setReport] = useState<SalesReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyChecks, setOnlyChecks] = useState(false);
  const [detail, setDetail] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const range = useMemo(() => periodRange(period, Date.now(), timezone), [period, timezone]);
  const qs = `from=${range.from}&to=${range.to}`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/dashboard/sales?${qs}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.totals) {
        setError(data?.error ?? "Could not load your sales.");
        return;
      }
      setError(null);
      setReport(data);
    } catch {
      setError("Could not reach the server.");
    }
  }, [qs]);

  useEffect(() => {
    setReport(null);
    setOnlyChecks(false);
    void load();
    if (!includesToday(range, Date.now(), timezone)) return;
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load, range, timezone]);

  const multiDay = range.from !== range.to;
  const rows = report ? (onlyChecks ? report.rows.filter((r) => r.checks.length) : report.rows) : [];
  const t = report?.totals;

  return (
    <div className="money-tab sales-tab">
      <div className="menu-head">
        <div>
          <div className="menu-title">Sales</div>
          <div className="menu-sub">Every order and what it was charged. Same page on a computer: sign in at this address with your tablet username.</div>
        </div>
        <a className="btn small" href={`/api/dashboard/sales/export?${qs}`} download>
          Download CSV
        </a>
      </div>

      <div className="sales-periods" role="tablist" aria-label="Period">
        {SALES_PERIODS.map((p) => (
          <button key={p.key} role="tab" aria-selected={p.key === period} className={`sales-chip ${p.key === period ? "active" : ""}`} onClick={() => setPeriod(p.key)}>
            {p.label}
          </button>
        ))}
      </div>

      {error && (
        <p className="app-empty" role="status">
          {error}
        </p>
      )}
      {!report && !error && <p className="app-empty">Loading your sales…</p>}

      {report && t && (
        <>
          <div className="money-strip" role="status">
            <div className="money-stat">
              <span className="money-stat-label">Sales</span>
              <span className="money-stat-value num">{centsLabel(t.food_cents)}</span>
              <span className="money-stat-sub">Food sold, after discounts</span>
            </div>
            <div className="money-stat">
              <span className="money-stat-label">Orders</span>
              <span className="money-stat-value num">{t.orders}</span>
              <span className="money-stat-sub">{t.orders ? `Average ${centsLabel(t.average_cents)}` : "None yet"}</span>
            </div>
          </div>

          {t.to_check > 0 && (
            <button className={`sales-check ${onlyChecks ? "active" : ""}`} onClick={() => setOnlyChecks((v) => !v)}>
              {t.to_check === 1 ? "1 order has an item with no price." : `${t.to_check} orders have an item with no price.`}{" "}
              <u>{onlyChecks ? "Show all orders" : "Show them"}</u>
            </button>
          )}

          <button className="sales-more" aria-expanded={detail} onClick={() => setDetail((v) => !v)}>
            {detail ? "Less detail" : "More detail"}
          </button>
          {detail && <SalesDetail report={report} multiDay={multiDay} />}

          <div className="money-list" role="list">
            {rows.length === 0 && <p className="app-empty">{onlyChecks ? "Nothing to check." : "No orders in this period."}</p>}
            {rows.map((r) => (
              <SalesListRow key={r.id} row={r} multiDay={multiDay} open={open === r.id} onToggle={() => setOpen((o) => (o === r.id ? null : r.id))} />
            ))}
          </div>
          {report.truncated && <p className="week-foot">This period has more orders than one page shows. Pick a shorter period, or download the CSV for a month at a time.</p>}
        </>
      )}

      <p className="week-foot">What Premium pays you each week is under Money.</p>
    </div>
  );
}

function SalesDetail({ report, multiDay }: { report: SalesReport; multiDay: boolean }) {
  const t = report.totals;
  const lines: [string, string][] = [
    ["Customers paid", centsLabel(t.paid_cents)],
    ["Tax", centsLabel(t.tax_cents)],
    ["Delivery and service fees", centsLabel(t.fees_cents)],
    ["Tips", centsLabel(t.tip_cents)],
  ];
  if (t.discount_cents) lines.push(["Discounts", `-${centsLabel(t.discount_cents)}`]);
  if (t.cancelled.orders) lines.push([`Cancelled (${t.cancelled.orders})`, centsLabel(t.cancelled.paid_cents)]);
  const maxDay = Math.max(1, ...report.days.map((d) => d.paid_cents));
  return (
    <div className="sales-detail">
      <SalesBlock title="Breakdown">
        {lines.map(([k, v]) => (
          <div key={k} className="sales-line">
            <span>{k}</span>
            <span className="num">{v}</span>
          </div>
        ))}
      </SalesBlock>
      {multiDay && (
        <SalesBlock title="By day">
          {report.days.map((d) => (
            <div key={d.key} className="sales-line sales-bar-line">
              <span className="sales-day">{d.label === "Today" || d.label === "Yesterday" ? d.label : `${d.label} ${d.key.slice(5).replace("-", "/")}`}</span>
              <span className="sales-bar" aria-hidden="true">
                <span style={{ width: `${Math.round((d.paid_cents / maxDay) * 100)}%` }} />
              </span>
              <span className="num">
                {d.orders} · {centsLabel(d.paid_cents)}
              </span>
            </div>
          ))}
        </SalesBlock>
      )}
      {report.channels.length > 0 && (
        <SalesBlock title="Where orders came from">
          {report.channels.map((g) => (
            <div key={g.label} className="sales-line">
              <span>{g.label}</span>
              <span className="num">
                {g.orders} · {centsLabel(g.paid_cents)}
              </span>
            </div>
          ))}
        </SalesBlock>
      )}
      {report.payments.length > 0 && (
        <SalesBlock title="How they paid">
          {report.payments.map((g) => (
            <div key={g.label} className="sales-line">
              <span>{g.label}</span>
              <span className="num">
                {g.orders} · {centsLabel(g.paid_cents)}
              </span>
            </div>
          ))}
        </SalesBlock>
      )}
      {report.top_items.length > 0 && (
        <SalesBlock title="Best sellers">
          {report.top_items.map((i) => (
            <div key={i.name} className="sales-line">
              <span>{i.name}</span>
              <span className="num">{i.quantity}</span>
            </div>
          ))}
        </SalesBlock>
      )}
    </div>
  );
}

function SalesBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="sales-block">
      <h3 className="money-stat-label">{title}</h3>
      {children}
    </section>
  );
}

function SalesListRow({ row, multiDay, open, onToggle }: { row: SalesRow; multiDay: boolean; open: boolean; onToggle: () => void }) {
  return (
    <div role="listitem">
      <button className={`money-row sales-row ${row.cancelled ? "cancelled" : ""}`} aria-expanded={open} onClick={onToggle}>
        <span className="money-week">
          <span className="money-week-label">
            {multiDay ? `${row.day.slice(5).replace("-", "/")} ` : ""}
            {row.time} · #{row.order_number}
          </span>
          <span className="money-week-sub">
            {[row.channel, row.order_type === "delivery" ? "Delivery" : row.order_type === "pickup" ? "Pickup" : null, row.customer].filter(Boolean).join(" · ")}
            {row.checks.length > 0 && <span className="sales-flag"> · {row.checks.join(", ")}</span>}
          </span>
        </span>
        <span className="money-right">
          {row.cancelled && <span className="money-chip">Cancelled</span>}
          <span className="money-amount num">{row.paid_cents === null ? "—" : centsLabel(row.paid_cents)}</span>
        </span>
      </button>
      {open && <Receipt id={row.id} />}
    </div>
  );
}

function Receipt({ id }: { id: string }) {
  const [r, setR] = useState<SalesReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/dashboard/sales/${id}`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || !data?.receipt) setError(data?.error ?? "Could not load this order.");
        else setR(data.receipt);
      } catch {
        if (!cancelled) setError("Could not reach the server.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);
  if (error) return <p className="app-empty">{error}</p>;
  if (!r) return <p className="app-empty">Loading the order…</p>;
  return (
    <div className="sales-receipt">
      {r.items.map((it, i) => (
        <div key={i} className="sales-item">
          <div className="sales-line">
            <span>{it.name}</span>
            <span className={`num ${it.unpriced ? "sales-flag" : ""}`}>{it.unpriced ? "No price" : it.price_cents === null ? "" : centsLabel(it.price_cents)}</span>
          </div>
          {it.modifiers.map((m, j) => (
            <div key={j} className="sales-mod">
              {m}
            </div>
          ))}
        </div>
      ))}
      <div className="sales-sep" />
      {r.lines.map((l) => (
        <div key={l.label} className="sales-line">
          <span>{l.label}</span>
          <span className="num">{centsLabel(l.cents)}</span>
        </div>
      ))}
      <div className="sales-line sales-total">
        <span>Total</span>
        <span className="num">{r.paid_cents === null ? "—" : centsLabel(r.paid_cents)}</span>
      </div>
      <div className="sales-line">
        <span>Payment</span>
        <span>{r.payment}</span>
      </div>
    </div>
  );
}
