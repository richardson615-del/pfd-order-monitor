"use client";

import { useCallback, useEffect, useState } from "react";
import { DAY_KEYS, DAY_LABELS, MAX_RANGES_PER_DAY, PAUSE_CHOICES, clockLabel, dayLine, emptyWeek, time12, type PauseChoice, type WeeklyHours } from "@/lib/store";
import { COOK_TIME_CHOICES, type KitchenAlert } from "@/lib/kitchen-alerts";

/**
 * Store: the restaurant runs its own store from the app (migration 052;
 * prs-crm brief 2026-10-24 §2, A3). Four things:
 *
 *   - Pause online orders for a while, and turn them back on. Takes effect
 *     in the CRM within a minute; dispatch is told so every ordering site
 *     is paused too.
 *   - Change the weekly hours. Sent to Premium, who apply them; the tab
 *     shows "Sent to Premium" until the new hours come back.
 *   - KT1 (Ticket #779): the default cook time Accept pre-selects.
 *   - KT1: this restaurant's printer and tablet alerts, in plain words
 *     (lib/kitchen-alerts.ts). The dashboard polls them and passes them in.
 */

type StoreState = {
  timezone: string;
  pause: { until: string; reason: string | null; at: string | null } | null;
  hours: WeeklyHours | null;
  hours_lines: string[];
  pending_hours: { sent_at: string; hours: WeeklyHours | null } | null;
  prep_minutes: number;
};

const TIMES: string[] = (() => {
  const out: string[] = [];
  for (let h = 0; h < 24; h++) for (const m of ["00", "15", "30", "45"]) out.push(`${String(h).padStart(2, "0")}:${m}`);
  return out;
})();

export default function StoreTab({
  onPauseChange,
  onCookTimeChange,
  alerts,
}: {
  onPauseChange?: (pause: StoreState["pause"]) => void;
  onCookTimeChange?: (minutes: number) => void;
  /** null = not checked yet / could not be read. */
  alerts?: KitchenAlert[] | null;
}) {
  const [s, setS] = useState<StoreState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState<WeeklyHours | null>(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard/store", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setError(data?.error ?? "Could not load your store settings.");
      setS(data as StoreState);
      onPauseChange?.((data as StoreState).pause);
      if (typeof (data as StoreState).prep_minutes === "number") onCookTimeChange?.((data as StoreState).prep_minutes);
      setError(null);
    } catch {
      setError("Could not reach the server.");
    }
  }, [onPauseChange, onCookTimeChange]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(t);
  }, [load]);

  async function post(path: string, body: unknown, ok: string) {
    setBusy(path);
    setMsg(null);
    try {
      const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setMsg({ ok: false, text: data?.error ?? "That didn't go through. Try again." });
      setMsg({ ok: true, text: ok });
      await load();
      return true;
    } catch {
      setMsg({ ok: false, text: "Could not reach the server." });
    } finally {
      setBusy(null);
    }
  }

  async function pause(choice: PauseChoice) {
    await post("/api/dashboard/store/pause", { choice, reason: reason || undefined }, "Paused. Premium is pausing your other ordering sites too.");
    setReason("");
  }

  async function sendHours() {
    if (!editing) return;
    const done = await post("/api/dashboard/store/hours", { hours: editing, note: note || undefined }, "Sent to Premium. Your new hours show here once they're live.");
    if (done) {
      setEditing(null);
      setNote("");
    }
  }

  const zone = s?.timezone ?? "America/Chicago";

  return (
    <div className="menu-tab store-tab">
      <div className="menu-head">
        <div>
          <div className="menu-title">Store</div>
          <div className="menu-sub">Pause online orders when the kitchen needs a breather, and keep your hours right.</div>
        </div>
      </div>
      {error && <p className="app-empty" role="status">{error}</p>}
      {!s && !error && <p className="app-empty">Loading…</p>}
      {msg && <p className={`store-msg ${msg.ok ? "ok" : "bad"}`} role="status">{msg.text}</p>}

      {s && (
        <>
          <section className={`store-card ${s.pause ? "paused" : ""}`}>
            <h3 className="store-h">Online orders</h3>
            {s.pause ? (
              <>
                <p className="store-big">Paused until {clockLabel(new Date(s.pause.until), zone)}</p>
                {s.pause.reason && <p className="store-sub">Reason: {s.pause.reason}</p>}
                <button className="btn primary store-wide" disabled={busy !== null} onClick={() => void post("/api/dashboard/store/pause", { resume: true }, "Online orders are back on.")}>
                  Turn online orders back on
                </button>
              </>
            ) : (
              <>
                <p className="store-big on">Taking orders</p>
                <p className="store-sub">Pause new online orders for:</p>
                <div className="store-choices">
                  {PAUSE_CHOICES.map((c) => (
                    <button key={c.key} className="btn store-choice" disabled={busy !== null} onClick={() => void pause(c.key)}>
                      {c.label}
                    </button>
                  ))}
                </div>
                <input className="menu-search store-reason" placeholder="Why? (optional - busy, short staffed, equipment)" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
              </>
            )}
          </section>

          <section className="store-card">
            <h3 className="store-h">Default cook time</h3>
            <p className="store-sub">What Accept picks unless you tap another time. Orders already accepted keep theirs.</p>
            <div className="store-choices">
              {COOK_TIME_CHOICES.map((m) => (
                <button
                  key={m}
                  className={`btn store-choice num${m === s.prep_minutes ? " primary" : ""}`}
                  disabled={busy !== null || m === s.prep_minutes}
                  aria-pressed={m === s.prep_minutes}
                  onClick={() => void post("/api/dashboard/store/cook-time", { prep_minutes: m }, `Default cook time is now ${m} minutes.`)}
                >
                  {m} min
                </button>
              ))}
            </div>
            {!COOK_TIME_CHOICES.includes(s.prep_minutes) && <p className="store-sub">Now: {s.prep_minutes} min (set by Premium).</p>}
          </section>

          <section className={`store-card ${alerts?.some((a) => a.severity === "critical") ? "paused" : ""}`}>
            <h3 className="store-h">Alerts</h3>
            {alerts === undefined || alerts === null ? (
              <p className="store-sub">{alerts === null ? "Could not check your printer and tablet right now." : "Checking…"}</p>
            ) : alerts.length === 0 ? (
              <p className="store-big on">No printer or tablet problems</p>
            ) : (
              <ul className="store-alerts">
                {alerts.map((a) => (
                  <li key={a.key} className={`store-alert ${a.severity}`}>
                    <div className="store-alert-title">{a.title}</div>
                    <div className="store-sub">{a.detail}</div>
                    {a.since && <div className="store-sub">Since {new Date(a.since).toLocaleString("en-US", { timeZone: zone, weekday: "short", hour: "numeric", minute: "2-digit" })}</div>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="store-card">
            <div className="store-row">
              <h3 className="store-h">Hours</h3>
              {!editing && (
                <button className="btn small" disabled={busy !== null} onClick={() => setEditing(structuredClone(s.pending_hours?.hours ?? s.hours ?? emptyWeek()))}>
                  Change hours
                </button>
              )}
            </div>
            {s.pending_hours && !editing && (
              <p className="menu-sent">Sent to Premium {new Date(s.pending_hours.sent_at).toLocaleString("en-US", { timeZone: zone, weekday: "short", hour: "numeric", minute: "2-digit" })}. Your new hours show here once they&apos;re live.</p>
            )}
            {!editing && (
              <ul className="store-hours">
                {s.hours
                  ? DAY_KEYS.map((d) => <li key={d}>{dayLine(d, s.hours![d])}</li>)
                  : s.hours_lines.length
                    ? s.hours_lines.map((l) => <li key={l}>{l}</li>)
                    : <li>No hours on file yet. Tap Change hours to send them to Premium.</li>}
              </ul>
            )}
            {editing && (
              <div className="store-edit">
                {DAY_KEYS.map((d) => {
                  const ranges = editing[d];
                  const set = (next: typeof ranges) => setEditing({ ...editing, [d]: next });
                  return (
                    <div key={d} className="store-day">
                      <div className="store-day-name">{DAY_LABELS[d]}</div>
                      <div className="store-day-ranges">
                        {ranges.length === 0 && <span className="store-closed">Closed</span>}
                        {ranges.map((r, i) => (
                          <span key={i} className="store-range">
                            <select value={r.open} onChange={(e) => set(ranges.map((x, j) => (j === i ? { ...x, open: e.target.value } : x)))}>
                              {TIMES.map((t) => <option key={t} value={t}>{time12(t)}</option>)}
                            </select>
                            <span>to</span>
                            <select value={r.close} onChange={(e) => set(ranges.map((x, j) => (j === i ? { ...x, close: e.target.value } : x)))}>
                              {TIMES.map((t) => <option key={t} value={t}>{time12(t)}</option>)}
                            </select>
                            <button className="btn small" onClick={() => set(ranges.filter((_, j) => j !== i))} aria-label="Remove these hours">
                              Remove
                            </button>
                          </span>
                        ))}
                      </div>
                      <div className="store-day-actions">
                        {ranges.length === 0 && <button className="btn small" onClick={() => set([{ open: "11:00", close: "21:00" }])}>Open this day</button>}
                        {ranges.length > 0 && ranges.length < MAX_RANGES_PER_DAY && <button className="btn small" onClick={() => set([...ranges, { open: "17:00", close: "21:00" }])}>Add a split</button>}
                        {ranges.length > 0 && <button className="btn small" onClick={() => set([])}>Closed</button>}
                      </div>
                    </div>
                  );
                })}
                <input className="menu-search store-reason" placeholder="Anything Premium should know? (optional)" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
                <div className="store-row">
                  <button className="btn primary" disabled={busy !== null} onClick={() => void sendHours()}>
                    Send to Premium
                  </button>
                  <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
                </div>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
