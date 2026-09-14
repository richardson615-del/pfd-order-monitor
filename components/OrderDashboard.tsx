"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { Order } from "@/lib/types";
import OrderCard from "./OrderCard";
import { ageMs, elapsedLabel, type DisplayMode } from "@/lib/order-display";
import { Brand } from "./Brand";
import AlertGate from "./AlertGate";
import { armAudio, isAudioArmed, playAlertBeep } from "@/lib/sound";
import {
  Connection,
  isStale,
  kioskWarning,
  pollIntervalMs,
  realtimeConnection,
  unaccepted,
  liveState,
  HEARTBEAT_EVERY_MS,
} from "@/lib/kiosk";

/**
 * What the lists are called.
 *
 * Was New / Opened / Completed / Printed - the database's own words. Two of
 * those are not distinctions a kitchen can act on: 'opened' only means
 * somebody tapped the row, and 'printed' is a fact about the paper channel,
 * which is independent of the tablet. orderFlag() already collapses them, so
 * the tabs now say the same three things the cards do.
 *
 * "Done" deliberately includes cancelled: nothing is owed on it either. The
 * card still shows it as cancelled, struck through, so it cannot be mistaken
 * for something that was cooked.
 */
type TabKey = "waiting" | "accepted" | "done" | "all";

const TABS: { key: TabKey; label: string }[] = [
  { key: "waiting", label: "Waiting" },
  { key: "accepted", label: "Accepted" },
  { key: "done", label: "Done" },
  { key: "all", label: "Show all" },
];

function inTab(order: Order, key: TabKey): boolean {
  if (key === "all") return true;
  if (order.status === "cancelled" || order.status === "completed") return key === "done";
  if (order.accepted_at) return key === "accepted";
  return key === "waiting";
}

export default function OrderDashboard({
  initialOrders,
  restaurantId,
  mode,
  restaurantName,
}: {
  initialOrders: Order[];
  restaurantId: string;
  /** kitchen or standard, from the restaurant's own setting. */
  mode: DisplayMode;
  restaurantName: string;
}) {
  const [orders, setOrders] = useState<Order[]>(initialOrders);
  const [tab, setTab] = useState<TabKey>("waiting");
  const [connection, setConnection] = useState<Connection>("connecting");
  const [soundArmed, setSoundArmed] = useState(true); // assume ok until checked
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  /**
   * When the office last heard from this screen, and whether this browser has
   * a push subscription. Both feed the status pill. null means NOT YET KNOWN,
   * which is not the same as missing - see liveState().
   */
  const [heartbeatOkAt, setHeartbeatOkAt] = useState<number | null>(null);
  const [pushSubscribed, setPushSubscribed] = useState<boolean | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const soundIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * What the chime is sounding for.
   *
   * Keyed on acceptance, not on status 'new'. 'new' cleared itself the moment
   * anyone tapped the order, so a glance or a mis-tap silenced the tablet
   * without a single person having agreed to cook anything.
   */
  const waiting = useMemo(() => unaccepted(orders), [orders]);
  const hasNewOrders = waiting.length > 0;

  /**
   * Reconcile against the database directly.
   *
   * Runs on a timer whether or not the socket is healthy, because realtime is
   * an optimisation here and not the guarantee. A websocket that has been open
   * for three weeks on a kitchen wall and quietly died is the failure this
   * survives - and a missed order costs far more than a query a minute.
   */
  const sync = useCallback(async () => {
    const supabase = supabaseBrowser();
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("restaurant_id", restaurantId)
      .order("received_at", { ascending: false })
      .limit(200);
    if (error || !data) return;
    setOrders(data as Order[]);
    setLastSyncAt(Date.now());
  }, [restaurantId]);

  // --- Realtime, with its status actually observed ---------------------------
  // .subscribe() used to be called with no callback at all, so a dropped
  // channel was invisible: the list simply stopped updating and the screen
  // kept saying what it said an hour ago.
  useEffect(() => {
    const supabase = supabaseBrowser();
    const channel = supabase
      .channel(`orders-${restaurantId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "orders",
          filter: `restaurant_id=eq.${restaurantId}`,
        },
        (payload) => {
          setLastSyncAt(Date.now());
          setOrders((prev) => {
            if (payload.eventType === "INSERT") {
              const newOrder = payload.new as Order;
              if (prev.some((o) => o.id === newOrder.id)) return prev;
              return [newOrder, ...prev];
            }
            if (payload.eventType === "UPDATE") {
              const updated = payload.new as Order;
              return prev.map((o) => (o.id === updated.id ? updated : o));
            }
            return prev;
          });
        }
      )
      .subscribe((status) => {
        const next = realtimeConnection(status);
        setConnection(next);
        // Coming back from a drop, the list is by definition behind - whatever
        // arrived while the socket was down was never delivered to this tab.
        if (next === "live") void sync();
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [restaurantId, sync]);

  // --- Poll, always, faster when the socket is known to be down -------------
  useEffect(() => {
    const id = setInterval(() => void sync(), pollIntervalMs(connection));
    return () => clearInterval(id);
  }, [connection, sync]);

  // Drives the staleness check AND the age timers on every card.
  //
  // Every second, not the 10 it used to be: the cards count up in m:ss, and a
  // clock that jumps ten seconds at a time reads as broken rather than live.
  // It is one setState of a number - the work is the re-render, and this
  // screen is a list of at most a couple of hundred rows.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // --- Sound has to be armed by a real gesture ------------------------------
  // Any touch anywhere counts, so the first person to walk past and prod the
  // screen fixes it - which is the only thing that will happen on a tablet
  // that rebooted overnight with nobody watching.
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const ok = await armAudio();
      if (!cancelled) setSoundArmed(ok);
    };
    void check();

    const onGesture = () => void check();
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    // Android suspends the context when the kiosk is backgrounded; coming back
    // to the foreground needs it resumed or the next order arrives in silence.
    document.addEventListener("visibilitychange", onGesture);
    return () => {
      cancelled = true;
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
      document.removeEventListener("visibilitychange", onGesture);
    };
  }, []);

  // --- Say that a signed-in screen is actually open --------------------------
  //
  // A push subscription belongs to the browser's service worker, not to the
  // session, so it outlives being signed out: a tablet sitting on a login
  // screen kept reporting delivered pushes while nobody saw a single order.
  // This is the one signal that tells a watched screen from a dead one.
  //
  // Fire-and-forget. A heartbeat that failed to record must never disturb the
  // thing it is reporting on.
  useEffect(() => {
    const beat = () => {
      // Still fire-and-forget for the REQUEST, but the outcome is recorded:
      // the pill claimed the office could see this tablet with nothing behind
      // the claim, and "the office cannot see you" is a thing a restaurant can
      // act on.
      void fetch("/api/dashboard/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // So the office can tell an open screen that will ring from an open
        // screen that will not. null until AlertGate has answered.
        body: JSON.stringify({ pushSubscribed }),
      })
        .then((res) => {
          if (res.ok) setHeartbeatOkAt(Date.now());
        })
        .catch(() => {});
    };
    beat();
    const id = setInterval(beat, HEARTBEAT_EVERY_MS);
    // Coming back to the foreground, say so immediately rather than waiting
    // out the interval - a tablet that was backgrounded is exactly when the
    // monitor is closest to deciding nobody is there.
    const onVisible = () => {
      if (document.visibilityState === "visible") beat();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // Re-run when the subscription answer changes: with [] this closure would
    // capture the first value (null, before AlertGate has looked) and report
    // it for the life of the tab.
  }, [pushSubscribed]);

  // The push subscription is read and repaired by AlertGate, which owns that
  // question - it reports the answer here through onSubscribedChange so the
  // status pill and the gate cannot disagree about whether this tablet will
  // ring. Two separate probes is how they start to.

  // --- Keep the screen on ---------------------------------------------------
  // A kiosk whose screen has gone to sleep is a kiosk nobody can see an order
  // on. The lock is dropped whenever the page is hidden, so it is re-taken on
  // every return to the foreground.
  useEffect(() => {
    let lock: any = null;
    const request = async () => {
      try {
        if (document.visibilityState !== "visible") return;
        lock = await (navigator as any).wakeLock?.request("screen");
      } catch {
        // Unsupported, or refused on battery. The kiosk launcher's own
        // keep-awake setting is the real guarantee; this is belt and braces.
      }
    };
    void request();
    document.addEventListener("visibilitychange", request);
    return () => {
      document.removeEventListener("visibilitychange", request);
      try {
        lock?.release();
      } catch {
        /* already gone */
      }
    };
  }, []);

  // --- Chime while anything is unopened -------------------------------------
  useEffect(() => {
    if (hasNewOrders && soundArmed) {
      if (!soundIntervalRef.current) {
        playAlertBeep();
        soundIntervalRef.current = setInterval(playAlertBeep, 8000);
      }
    } else if (soundIntervalRef.current) {
      clearInterval(soundIntervalRef.current);
      soundIntervalRef.current = null;
    }
    return () => {
      if (soundIntervalRef.current) {
        clearInterval(soundIntervalRef.current);
        soundIntervalRef.current = null;
      }
    };
  }, [hasNewOrders, soundArmed]);

  const filtered = orders.filter((o) => inTab(o, tab));
  const stale = isStale(lastSyncAt, now);
  const warning = kioskWarning({ connection, soundArmed, stale });
  const live = liveState({
    connection,
    stale,
    soundArmed,
    pushSubscribed,
    heartbeatOkAt,
    now,
  });

  /**
   * The oldest thing nobody has accepted. "3 waiting" says how much; this
   * says how bad, which is the number somebody in a kitchen acts on.
   */
  const oldest = waiting.reduce<Order | null>((worst, o) => {
    if (!worst) return o;
    return (ageMs(o, now) ?? 0) > (ageMs(worst, now) ?? 0) ? o : worst;
  }, null);

  // The tab a restaurant sees on the wall all day. Naming the restaurant
  // means a tablet showing the wrong one is obvious at a glance rather than
  // after somebody wonders why the orders look unfamiliar.
  useEffect(() => {
    document.title = `${restaurantName} — Premium Orders`;
  }, [restaurantName]);

  return (
    <div className="app" data-display={mode}>
      {/* Above everything. Nothing below this renders while alerts are off -
          a tablet that cannot ring is not a tablet, it is a screen. */}
      <AlertGate restaurantName={restaurantName} onSubscribedChange={setPushSubscribed} />

      {warning && (
        <div className={`kiosk-banner kiosk-${warning.level}`} role="status">
          {warning.text}
        </div>
      )}

      <div className="app-head">
        <div className="app-head-id">
          <Brand size="sm" />
          {/* The restaurant's own name, which this screen never showed. A
              tablet signed into the wrong restaurant used to look exactly
              like one signed into the right one. */}
          <span className="app-head-restaurant">{restaurantName}</span>
        </div>

        {/* The count IS the headline. Everything else on this screen is
            detail about it, and on a kitchen tablet the only question being
            asked from across the room is "is anything waiting". */}
        <span className={`app-head-count num ${hasNewOrders ? "busy" : "idle"}`}>
          {hasNewOrders ? `${waiting.length} WAITING` : "All clear"}
          {hasNewOrders && oldest && (
            <span className="app-head-oldest num">oldest {elapsedLabel(oldest, now)}</span>
          )}
        </span>

        <div className="app-head-right">
          {/* Says the worst true thing, not the one that happens to be
              working. See liveState(). */}
          <span className={`app-live ${live.level}`} title={live.detail ?? undefined}>
            {live.label}
          </span>
          <span className="app-clock num">
            {new Date(now).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </span>
        </div>
      </div>

      {/* What is wrong and what to do about it, under the name where it is
          read. The pill is one word; this is the sentence. */}
      {live.detail && live.level !== "offline" && (
        <p className="app-head-detail" role="status">
          {live.detail}
        </p>
      )}

      {/* Why the room is beeping, in one line, and what stops it. */}
      {hasNewOrders && (
        <div className="waiting-bar" role="status">
          {waiting.length === 1
            ? "1 order waiting — open it and press Accept"
            : `${waiting.length} orders waiting — open each one and press Accept`}
        </div>
      )}

      <div className="app-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`app-tab ${tab === t.key ? "active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.key !== "all" && ` (${orders.filter((o) => inTab(o, t.key)).length})`}
          </button>
        ))}
      </div>

      <div className="app-list">
        {filtered.length === 0 && (
          <div className="app-empty">
            {tab === "waiting"
              ? "Nothing waiting. All caught up."
              : tab === "all"
                ? `No orders for ${restaurantName} yet today.`
                : "Nothing in this list."}
          </div>
        )}
        {filtered.map((order) => (
          <OrderCard key={order.id} order={order} now={now} />
        ))}
      </div>
    </div>
  );
}
