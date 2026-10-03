"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  readGate,
  settleGate,
  type AlertGateState,
  type AlertReason,
  type GateMemory,
  type GateVerdict,
  type SubscriptionRead,
} from "@/lib/alert-gate";
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

/** serviceWorker.ready never rejects - with no worker it just waits. On wake, waiting is a read that failed. */
const SW_READY_TIMEOUT_MS = 10_000;

function serviceWorkerReady(): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("The alert service did not start in time.")), SW_READY_TIMEOUT_MS)
    ),
  ]);
}

/**
 * Records the endpoint against the restaurant.
 *
 * Cookies, not a bearer token: /api/push/subscribe reads the session with
 * supabaseServer(), which is cookie-based. The old button sent an
 * Authorization header the route never looked at.
 */
async function recordSubscription(sub: PushSubscription): Promise<void> {
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
 * Subscribes this browser (if it is not already) and records the endpoint,
 * reporting each half separately - because "the read failed", "there is no
 * subscription" and "the record failed" mean three different things for
 * whether this tablet will ring, and the gate used to treat all three as the
 * worst one (lib/alert-gate.ts readGate, Workstream AG).
 *
 * Idempotent by design - the route upserts on endpoint - so it is safe to run
 * on every mount and every return to the foreground. That repetition is the
 * point: it re-binds an endpoint to the current session after a sign-out and
 * back in, and retries a record that failed last time.
 */
export async function subscribeAndRecord(): Promise<{
  subscription: SubscriptionRead;
  recorded: boolean;
  error: string | null;
}> {
  const message = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

  let reg: ServiceWorkerRegistration;
  let existing: PushSubscription | null;
  try {
    reg = await serviceWorkerReady();
    existing = await reg.pushManager.getSubscription();
  } catch (err) {
    return { subscription: "unknown", recorded: false, error: message(err, "Could not read the alert setting.") };
  }

  let sub = existing;
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!),
      });
    } catch (err) {
      // Known absent: the read worked and said none, and making one failed.
      return { subscription: "absent", recorded: false, error: message(err, "Could not turn alerts on.") };
    }
  }

  try {
    await recordSubscription(sub);
    return { subscription: "present", recorded: true, error: null };
  } catch (err) {
    return { subscription: "present", recorded: false, error: message(err, "Could not record the alert setting.") };
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

/**
 * What the hook tells its owner after every read: whether this screen will
 * ring, and which gate state it landed on. The dashboard puts both on the
 * heartbeat - `blocked` on a managed kiosk means the Hexnode notification
 * policy is missing, and that is the office's to fix, so the office has to
 * be able to see it (migration 037). `reason` says why, and is reported even
 * while the orders stay showing (record_failed, sub_read_failed), so the
 * office sees a tablet the gate decided not to interrupt (migration 047).
 */
export type OnAlertStateChange = (subscribed: boolean, state: AlertGateState, reason: AlertReason | null) => void;

/** How often a blocked screen re-reads the permission with nobody tapping. A kiosk never fires visibilitychange. */
export const BLOCKED_RECHECK_MS = 60_000;

export function useAlertGate(onSubscribedChange?: OnAlertStateChange): AlertGateController {
  const [state, setState] = useState<AlertGateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** What the screen showed after the last read, and since when reads have been failing (settleGate). */
  const memory = useRef<GateMemory>({ shown: null, failingSince: null });
  const recheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // land() schedules a re-read, and check() calls land(): the ref breaks the cycle.
  const checkRef = useRef<() => Promise<void>>(async () => {});

  /** Show `verdict` - through the debounce unless somebody just tapped - and tell the owner. */
  const land = useCallback(
    (verdict: GateVerdict, settle: boolean) => {
      if (recheckTimer.current) {
        clearTimeout(recheckTimer.current);
        recheckTimer.current = null;
      }
      const next = settle
        ? settleGate(memory.current, verdict, Date.now())
        : { shown: verdict.state, failingSince: null, recheckInMs: null };
      memory.current = { shown: next.shown, failingSince: next.failingSince };
      // The confirming read. A kiosk is always visible, so nothing else would ask.
      if (next.recheckInMs !== null) {
        recheckTimer.current = setTimeout(() => void checkRef.current(), next.recheckInMs);
      }
      setState(next.shown);
      onSubscribedChange?.(verdict.subscribed, next.shown, verdict.reason);
    },
    [onSubscribedChange]
  );

  /**
   * Read the truth, and repair it silently where that is possible.
   *
   * Permission granted but no subscription is the case worth noticing: it
   * needs no gesture, so it is fixed without showing anybody anything. That
   * covers a cleared cache, a reinstalled app and an expired endpoint - three
   * things that used to leave a tablet permanently silent with a green screen.
   *
   * What it must NOT do is put the gate up over a working screen because one
   * read on wake failed (Workstream AG): readGate keeps an unreadable or
   * unrecorded subscription hidden, and settleGate wants two failing reads
   * GATE_CONFIRM_MS apart before a screen showing orders stops showing them.
   */
  const check = useCallback(async () => {
    if (!pushSupported()) {
      land(readGate({ supported: false, permission: null, subscription: "unknown", recorded: false }), true);
      return;
    }

    const permission = Notification.permission;
    let subscription: SubscriptionRead = "unknown";
    let recorded = false;
    if (permission === "granted") {
      const result = await subscribeAndRecord();
      subscription = result.subscription;
      recorded = result.recorded;
      // The real message stays on screen for whoever is standing there; the
      // reason code goes to the office on the heartbeat.
      setError(result.error);
    }

    land(readGate({ supported: true, permission, subscription, recorded }), true);
  }, [land]);
  checkRef.current = check;

  useEffect(
    () => () => {
      if (recheckTimer.current) clearTimeout(recheckTimer.current);
    },
    []
  );

  useEffect(() => {
    void check();
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [check]);

  /**
   * Blocked on a kiosk is fixed at the office, not at the tablet: Hexnode
   * re-applies the notification policy and the permission flips to granted
   * with nobody touching the screen. A kiosk is always visible, so the
   * visibilitychange re-read above never fires - this one does, once a
   * minute, so the gate comes down on its own when the fix lands.
   */
  useEffect(() => {
    if (state !== "blocked") return;
    const id = setInterval(() => void check(), BLOCKED_RECHECK_MS);
    return () => clearInterval(id);
  }, [state, check]);

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
      let subscription: SubscriptionRead = "unknown";
      let recorded = false;
      if (permission === "granted") {
        const result = await subscribeAndRecord();
        subscription = result.subscription;
        recorded = result.recorded;
        // The real message, not a shrug. The old button swallowed this into
        // a console nobody on a tablet can open.
        setError(result.error);
        armAudio();
      }
      // Somebody just tapped: show the answer now, no debounce. An unreadable
      // subscription keeps the gate up here - the person is standing there
      // and can tap again, which a wake-up read has nobody to do.
      const verdict = readGate({ supported: true, permission, subscription, recorded });
      land(subscription === "unknown" && permission === "granted" ? { ...verdict, state: "ask" } : verdict, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not turn alerts on.");
    } finally {
      setBusy(false);
    }
  }, [land]);

  return { state, busy, error, check, turnOn };
}
