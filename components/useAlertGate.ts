"use client";

import { useCallback, useEffect, useState } from "react";
import { alertGateState, type AlertGateState } from "@/lib/alert-gate";
import { armAudio } from "@/lib/sound";

/**
 * The alert gate's brain, separate from its two faces.
 *
 * Two screens ask the same question - "will this tablet ring?" - and act
 * on the same answer with the same one tap. AlertGate is the full-screen
 * gate a working tablet shows if alerts are ever off; the Ready screen on
 * first run shows the same fact as one of its three checks, with the tap
 * as the last step of setup (Workstream I folds C3 into first run). One
 * hook, so the two cannot disagree about whether alerts are on, and so the
 * subscribe-and-record path exists exactly once.
 */

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

export const pushSupported = () =>
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
export async function subscribeAndRecord(): Promise<void> {
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

export interface AlertGateController {
  /** null until the first read has finished. */
  state: AlertGateState | null;
  busy: boolean;
  error: string | null;
  /** Re-read the truth (and repair silently where that is possible). */
  check: () => Promise<void>;
  /** The one tap: permission, subscription and audio in one gesture. */
  turnOn: () => Promise<void>;
}

export function useAlertGate(onSubscribedChange?: (subscribed: boolean) => void): AlertGateController {
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
  const turnOn = useCallback(async () => {
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
  }, [onSubscribedChange]);

  return { state, busy, error, check, turnOn };
}
