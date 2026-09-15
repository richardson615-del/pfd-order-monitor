"use client";

import { useCallback, useEffect, useState } from "react";
import { Brand } from "./Brand";
import { alertGateState, gateBlocks, type AlertGateState } from "@/lib/alert-gate";
import { armAudio } from "@/lib/sound";

/** The number on the printed login ticket, so a restaurant reads the same one everywhere. */
const SUPPORT_PHONE = "(615) 619-5081";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

const pushSupported = () =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

/**
 * Subscribes this browser and records the endpoint against the restaurant.
 *
 * Idempotent by design - the route upserts on endpoint - so it is safe to run
 * on every mount and every return to the foreground. That repetition is the
 * point: it re-binds an endpoint to the current session after a sign-out and
 * back in, which the old button could not do because it only ever ran when
 * somebody pressed it.
 */
async function subscribeAndRecord(): Promise<void> {
  const reg = await navigator.serviceWorker.ready;

  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!),
    }));

  // Cookies, not a bearer token: /api/push/subscribe reads the session with
  // supabaseServer(), which is cookie-based. The old button sent an
  // Authorization header the route never looked at.
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(sub),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? `The server refused the subscription (${res.status}).`);
  }
}

/**
 * The gate. Nothing below it renders while alerts are off.
 *
 * `onSubscribedChange` lets the dashboard's status pill read the same fact
 * this component just established, rather than probing for it separately and
 * disagreeing.
 */
export default function AlertGate({
  restaurantName,
  onSubscribedChange,
}: {
  restaurantName: string;
  onSubscribedChange?: (subscribed: boolean) => void;
}) {
  const [state, setState] = useState<AlertGateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Read the truth, and repair it silently where that is possible.
   *
   * Permission granted but no subscription is the case worth noticing: it
   * needs no gesture, so it is fixed without showing anybody anything. That
   * covers a cleared cache, a reinstalled app and an expired endpoint - three
   * things that used to leave a tablet permanently silent with a green screen.
   */
  const check = useCallback(async () => {
    if (!pushSupported()) {
      setState("unsupported");
      onSubscribedChange?.(false);
      return;
    }

    const permission = Notification.permission;
    let hasSubscription: boolean | null = null;
    try {
      const reg = await navigator.serviceWorker.ready;
      hasSubscription = Boolean(await reg.pushManager.getSubscription());
    } catch {
      hasSubscription = null;
    }

    if (permission === "granted") {
      try {
        await subscribeAndRecord();
        setState("hidden");
        setError(null);
        onSubscribedChange?.(true);
        return;
      } catch (err) {
        /**
         * Granted, but recording it failed.
         *
         * This used to block, on the reasoning that an unrecorded endpoint is
         * as silent as no endpoint. That was wrong for the case it actually
         * hit: when the BROWSER already holds a subscription, the server very
         * likely holds it too from a previous run, and today's refresh
         * failing says nothing about whether a push will arrive. Blocking
         * there locks a kitchen out of its live orders over a write that did
         * not need to succeed.
         *
         * So it blocks only when there is no browser subscription at all -
         * which is genuinely silent - and otherwise lets them through with
         * the error showing and the status pill amber. Found the hard way: an
         * RLS refusal on every re-record put the gate up on a working tablet.
         */
        setError(err instanceof Error ? err.message : "Could not turn alerts on.");
        if (hasSubscription) {
          setState("hidden");
          // Still false: the office should see this tablet as not confirmed,
          // and the pill should say so, even though the orders are reachable.
          onSubscribedChange?.(false);
          return;
        }
        setState("ask");
        onSubscribedChange?.(false);
        return;
      }
    }

    const next = alertGateState({ permission, hasSubscription, supported: true });
    setState(next);
    onSubscribedChange?.(next === "hidden");
  }, [onSubscribedChange]);

  useEffect(() => {
    void check();
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [check]);

  /**
   * The one tap.
   *
   * Permission, subscription and AUDIO in a single handler, because all three
   * need the same user gesture and asking for it three times is how two of
   * them end up never happening.
   */
  async function turnOn() {
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "ask");
        onSubscribedChange?.(false);
        return;
      }
      await subscribeAndRecord();
      armAudio();
      setState("hidden");
      onSubscribedChange?.(true);
    } catch (err) {
      // The real message, not a shrug. The old button swallowed this into a
      // console nobody on a tablet can open.
      setError(err instanceof Error ? err.message : "Could not turn alerts on.");
      onSubscribedChange?.(false);
    } finally {
      setBusy(false);
    }
  }

  // Nothing decided yet: show nothing rather than flashing a gate over a
  // working screen for the half-second the async read takes.
  if (state === null || !gateBlocks(state)) return null;

  return (
    <div className="alert-gate" role="dialog" aria-modal="true" aria-labelledby="alert-gate-title">
      <div className="alert-gate-inner">
        <Brand size="md" />
        <p className="alert-gate-restaurant">{restaurantName}</p>

        {state === "ask" && (
          <>
            <h1 id="alert-gate-title">Turn on order alerts</h1>
            <p>
              This tablet will not ring for a new order until alerts are on. It takes one tap, and
              it only has to be done once on this device.
            </p>
            <button className="btn primary alert-gate-action" disabled={busy} onClick={turnOn}>
              {busy ? "Turning on…" : "Turn on alerts"}
            </button>
          </>
        )}

        {state === "blocked" && (
          <>
            <h1 id="alert-gate-title">Alerts are blocked on this tablet</h1>
            <p>
              Notifications were turned off for this app, and only Android can turn them back on —
              this screen is not allowed to ask again.
            </p>
            <ol className="alert-gate-steps">
              <li>Open Android <strong>Settings</strong>.</li>
              <li>
                Go to <strong>Apps</strong> → <strong>Premium</strong> → <strong>Notifications</strong>.
              </li>
              <li>Turn notifications <strong>on</strong>.</li>
              <li>Come back here and tap <strong>Check again</strong>.</li>
            </ol>
            <button className="btn primary alert-gate-action" disabled={busy} onClick={() => void check()}>
              Check again
            </button>
            <p className="alert-gate-help">
              Stuck? Call Premium on <strong>{SUPPORT_PHONE}</strong>.
            </p>
          </>
        )}

        {state === "unsupported" && (
          <>
            <h1 id="alert-gate-title">Open this in the Premium app</h1>
            <p>
              This browser cannot receive order alerts. Install the app on the tablet and sign in
              there — the alert is the whole point of the screen.
            </p>
            <a className="btn primary alert-gate-action" href="/install.html">
              How to install it
            </a>
            <p className="alert-gate-help">
              Stuck? Call Premium on <strong>{SUPPORT_PHONE}</strong>.
            </p>
          </>
        )}

        {error && <p className="alert-gate-error">{error}</p>}
      </div>
    </div>
  );
}
