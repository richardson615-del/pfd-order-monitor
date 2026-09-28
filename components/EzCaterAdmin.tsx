"use client";

import { useCallback, useEffect, useState } from "react";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * /admin/ezcater (Phase 2). In order: Sync caterers (confirms the six) ->
 * Apply seed (links them, never switches any on) -> Create subscriber ->
 * switch Willie Mae's on (subscribes accepted + cancelled) -> watch the
 * receipts and orders below. Printing is OFF: ingested orders land in
 * ezcater_orders, never in the kitchen's queue.
 */
export default function EzCaterAdmin() {
  const [state, setState] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<any>(null);
  const [orderId, setOrderId] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/ezcater");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) setError(data.error ?? `Failed (${res.status})`);
    else setState(data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(key: string, body: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/ezcater", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Failed (${res.status})`);
      setNotice({ action: body.action, data });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (!state) return <div className="page"><div className="card">{error ? <span className="error-text">{error}</span> : "Loading…"}</div></div>;

  const restaurantName = (id: string | null) => state.restaurants.find((r: any) => r.id === id)?.name ?? null;

  return (
    <div className="page">
      <div className="card">
        <h2>ezCater</h2>
        <p className="muted">
          Order events from ezCater (accepted, which also carries modifications, and cancelled) for active locations land in <code>ezcater_orders</code>. <strong>Nothing prints</strong> and nothing reaches the tablet while ingestion is being proven.
        </p>
        <p>
          API token: {state.tokenConfigured ? <span className="success-text">configured</span> : <span className="error-text">EZCATER_API_TOKEN not set in this deployment</span>}
          {" · "}Subscriber: {state.subscriber ? <span className="success-text">{state.subscriber.id} → {state.subscriber.webhook_url}</span> : <span className="muted">none yet</span>}
          {state.webhookSecretOverride ? " · secret from EZCATER_WEBHOOK_SECRET" : ""}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn primary" disabled={busy !== null} onClick={() => act("sync", { action: "sync" })}>{busy === "sync" ? "Syncing…" : "Sync caterers"}</button>
          <button className="btn small" disabled={busy !== null} onClick={() => act("seed", { action: "apply_seed" })}>{busy === "seed" ? "Linking…" : "Apply seed links"}</button>
          {!state.subscriber && (
            <button className="btn small" disabled={busy !== null} onClick={() => act("sub", { action: "create_subscriber" }, "Create the ezCater subscriber pointing at this site's /api/ingest/ezcater? ezCater allows one per API user.")}>
              {busy === "sub" ? "Creating…" : "Create subscriber"}
            </button>
          )}
        </div>
        {error && <p className="error-text">{error}</p>}
        {notice?.action === "sync" && (
          <div>
            <p className="success-text">Caterers query returned {notice.data.caterers.length} location(s).</p>
            <table className="admin-table">
              <thead><tr><th>Seed</th><th>Prefix</th><th>Found</th></tr></thead>
              <tbody>
                {notice.data.seedCheck.map((s: any) => (
                  <tr key={s.prefix}><td>{s.label}</td><td><code>{s.prefix}</code></td><td>{s.found.length === 1 ? <span className="success-text">{s.found[0]}</span> : <span className="error-text">{s.found.length === 0 ? "not returned" : `${s.found.length} match: ${s.found.join("; ")}`}</span>}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {notice?.action === "apply_seed" && (
          <table className="admin-table">
            <thead><tr><th>Seed</th><th>Caterer</th><th>Restaurant</th><th>Result</th></tr></thead>
            <tbody>
              {notice.data.outcomes.map((o: any) => (
                <tr key={o.prefix}><td>{o.label}</td><td>{o.catererName ?? "—"}</td><td>{o.restaurantName ?? "—"}</td><td className={o.result === "linked" || o.result === "already_linked" ? "success-text" : "error-text"}>{o.result}{o.detail ? ` (${o.detail})` : ""}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Locations ({state.locations.length})</h3>
        <table className="admin-table">
          <thead><tr><th>ezCater location</th><th>Restaurant</th><th>Subscribed</th><th>Ingest</th></tr></thead>
          <tbody>
            {state.locations.map((l: any) => (
              <tr key={l.caterer_uuid}>
                <td>
                  {l.name}
                  <div className="muted"><code>{l.caterer_uuid}</code>{l.live === false ? " · not live on ezCater" : ""}</div>
                </td>
                <td>
                  <select
                    value={l.restaurant_id ?? ""}
                    disabled={busy !== null || l.active}
                    onChange={(e) => act(`link-${l.caterer_uuid}`, { action: "set_location", caterer_uuid: l.caterer_uuid, restaurant_id: e.target.value || null })}
                  >
                    <option value="">— not linked —</option>
                    {state.restaurants.map((r: any) => (
                      <option key={r.id} value={r.id}>{r.name}{r.crm_restaurant_id ? "" : " (no CRM link)"}</option>
                    ))}
                  </select>
                </td>
                <td className="muted">{(l.subscribed_events ?? []).join(", ") || "—"}</td>
                <td>
                  {l.active ? (
                    <button className="btn small" disabled={busy !== null} onClick={() => act(`off-${l.caterer_uuid}`, { action: "set_location", caterer_uuid: l.caterer_uuid, active: false }, `Switch ${l.name} off? Its ezCater subscriptions are deleted and new events are no longer ingested.`)}>On — switch off</button>
                  ) : (
                    <button className="btn small" disabled={busy !== null || !l.restaurant_id || !state.subscriber} onClick={() => act(`on-${l.caterer_uuid}`, { action: "set_location", caterer_uuid: l.caterer_uuid, active: true }, `Switch ${l.name} on? This subscribes it to ${state.subscribedEvents.join(" + ")} at ezCater and stores its orders (${restaurantName(l.restaurant_id)}). Nothing prints.`)}>Off — switch on</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Dry run one order</h3>
        <p className="muted">Fetch and map an ezCater order by its id (uuid) without storing anything.</p>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={orderId} onChange={(e) => setOrderId(e.target.value)} placeholder="ezCater order uuid" style={{ flex: 1 }} />
          <button className="btn small" disabled={busy !== null || !orderId.trim()} onClick={() => act("dry", { action: "dry_run", order_id: orderId })}>{busy === "dry" ? "Fetching…" : "Fetch"}</button>
        </div>
        {notice?.action === "dry_run" && <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{JSON.stringify(notice.data.found ? { location: notice.data.location, order: notice.data.order } : "ezCater does not know that order", null, 2)}</pre>}
      </div>

      <div className="card">
        <h3>Orders stored ({state.orders.length})</h3>
        <table className="admin-table">
          <thead><tr><th>ezCater #</th><th>Status</th><th>Due (handoff)</th><th>Total</th><th>Events</th><th>Updated</th></tr></thead>
          <tbody>
            {state.orders.map((o: any) => (
              <tr key={o.ezcater_order_id}>
                <td>{o.order_number}<div className="muted"><code>{o.ezcater_order_id}</code></div></td>
                <td>{o.status}{o.modified_at ? " · modified" : ""}</td>
                <td>{o.event_time ? new Date(o.event_time).toLocaleString() : "—"}</td>
                <td>{o.customer_total != null ? `$${Number(o.customer_total).toFixed(2)}` : "—"}</td>
                <td>{o.event_count}</td>
                <td>{new Date(o.updated_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Recent notifications</h3>
        <table className="admin-table">
          <thead><tr><th>When</th><th>Status</th><th>HTTP</th><th>Detail</th></tr></thead>
          <tbody>
            {state.receipts.map((r: any, i: number) => (
              <tr key={i}><td>{new Date(r.received_at).toLocaleString()}</td><td>{r.status}</td><td>{r.http_status}</td><td className="muted">{r.detail}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
