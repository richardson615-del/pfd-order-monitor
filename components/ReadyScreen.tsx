"use client";

import { useEffect, useState } from "react";
import { Brand } from "./Brand";
import { useAlertGate, type OnAlertStateChange } from "./useAlertGate";
import { READY_AUTO_ADVANCE_MS, SUPPORT_PHONE, allReady, readyChecks } from "@/lib/first-run";

/**
 * "You're all set" - the first thing a tablet shows at a store, once.
 *
 * Shown when the app has a network and a session and this device has never
 * finished setup (lib/first-run.ts). Three checks, each read from real
 * state and never assumed: connected (this page loaded, and the list
 * synced - if it is not, the kiosk's own Wi-Fi button is the fix, and the
 * row says so; this app draws no Wi-Fi control), order alerts (the same hook the alert gate uses - if they are off, the
 * one tap happens here as the last step), and the kitchen printer (from the
 * bridge's own view; the row is omitted when there is no printer, not
 * ticked).
 *
 * It moves on by itself twenty seconds after everything is green, or on a
 * tap - a tablet nobody is looking at must not sit on a welcome page while
 * an order arrives. It does NOT move on while alerts are off: that would be
 * the old dismissible button under a new name.
 */
export default function ReadyScreen({
  restaurantName,
  online,
  onSubscribedChange,
  onDone,
}: {
  restaurantName: string;
  /** The dashboard's own view: connected and synced at least once. */
  online: boolean;
  onSubscribedChange?: OnAlertStateChange;
  onDone: () => void;
}) {
  const gate = useAlertGate(onSubscribedChange);
  const alertsOn = gate.state === null ? null : gate.state === "hidden";

  const [printer, setPrinter] = useState<{ online: boolean | null } | null | undefined>(undefined);

  const readStatus = async () => {
    try {
      const res = await fetch("/api/dashboard/status", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setPrinter(data?.printer ? { online: typeof data.printer.online === "boolean" ? data.printer.online : null } : null);
    } catch {
      // Unknown stays unknown. The row says "checking" rather than a tick.
    }
  };
  useEffect(() => {
    void readStatus();
  }, []);

  const checks = readyChecks({
    online,
    alertsOn,
    alertsWhy: gate.state === "blocked" || gate.state === "unsupported" || gate.state === "ask" ? gate.state : null,
    printer: printer === undefined ? { online: null } : printer,
  });
  const ready = allReady(checks);

  // The countdown. Restarts if anything goes red again.
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!ready) {
      setSecondsLeft(null);
      return;
    }
    const end = Date.now() + READY_AUTO_ADVANCE_MS;
    setSecondsLeft(Math.ceil(READY_AUTO_ADVANCE_MS / 1000));
    const id = setInterval(() => {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) {
        clearInterval(id);
        onDone();
      }
    }, 250);
    return () => clearInterval(id);
    // onDone is stable enough for this; re-arming on every parent render
    // would restart the clock each second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const [testNote, setTestNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  async function sendTest() {
    setSending(true);
    setTestNote(null);
    try {
      const res = await fetch("/api/dashboard/test-order", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      setTestNote(res.ok ? (data.note ?? "Sent.") : (data.error ?? "Could not send a test order."));
    } catch {
      setTestNote("Could not reach the server. Nothing was sent.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="alert-gate ready" role="dialog" aria-modal="true" aria-labelledby="ready-title">
      <div className="alert-gate-inner ready-inner">
        <Brand size="md" />
        <h1 id="ready-title">You&apos;re all set, {restaurantName}</h1>
        <p>Orders will show on this screen and ring until they&apos;re opened.</p>

        <ul className="ready-checks">
          {checks.map((c) => (
            <li key={c.key} className={`ready-check ${c.ok === true ? "ok" : c.ok === false ? "todo" : "unknown"}`}>
              <span className="ready-mark" aria-hidden="true">
                {c.ok === true ? "✓" : c.ok === false ? "!" : "…"}
              </span>
              <span className="ready-label">
                {c.label}
                {c.ok === null && <span className="ready-sub">Checking…</span>}
                {c.ok === false && c.action && <span className="ready-sub">{c.action}</span>}
              </span>
              {c.key === "alerts" && c.ok === false && gate.state === "ask" && (
                <button className="btn primary ready-action" disabled={gate.busy} onClick={() => void gate.turnOn()}>
                  {gate.busy ? "Turning on…" : "Turn on alerts"}
                </button>
              )}
              {c.key === "alerts" && (gate.state === "blocked" || gate.state === "unsupported") && (
                <button className="btn ready-action" disabled={gate.busy} onClick={() => void gate.check()}>
                  Check again
                </button>
              )}
              {c.key === "printer" && c.ok === false && (
                <button className="btn ready-action" onClick={() => void readStatus()}>
                  Check again
                </button>
              )}
            </li>
          ))}
        </ul>

        {gate.state === "blocked" && (
          <p className="alert-gate-help">
            Alerts are off on this tablet — call Premium on <strong>{SUPPORT_PHONE}</strong> and we
            can turn them back on from the office. Nothing needs doing on this screen.
          </p>
        )}
        {gate.state === "unsupported" && (
          <p className="alert-gate-help">
            This browser cannot receive order alerts. Orders should be watched in the Premium app on
            the tablet Premium set up for you. Call <strong>{SUPPORT_PHONE}</strong> and we&apos;ll sort it out.
          </p>
        )}
        {gate.error && <p className="alert-gate-error">{gate.error}</p>}

        <div className="ready-actions">
          <button className="btn ready-test" disabled={sending || !ready} onClick={sendTest}>
            {sending ? "Sending…" : "Send me a test order"}
          </button>
          <button className="btn primary alert-gate-action" disabled={!ready} onClick={onDone}>
            {ready && secondsLeft !== null ? `Show my orders (${secondsLeft})` : "Show my orders"}
          </button>
        </div>
        {testNote && (
          <p className="print-note" role="status">
            {testNote}
          </p>
        )}
      </div>
    </div>
  );
}
