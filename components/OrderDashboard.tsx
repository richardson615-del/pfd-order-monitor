"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { Order, OrderStatus } from "@/lib/types";
import OrderCard from "./OrderCard";
import { type DisplayMode } from "@/lib/order-display";
import PushSetup from "./PushSetup";
import { armAudio, isAudioArmed, playAlertBeep } from "@/lib/sound";
import {
  Connection,
  isStale,
  kioskWarning,
  pollIntervalMs,
  realtimeConnection,
  unaccepted,
  HEARTBEAT_EVERY_MS,
} from "@/lib/kiosk";

const TABS: { key: OrderStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "new", label: "New" },
  { key: "opened", label: "Opened" },
  { key: "completed", label: "Completed" },
  { key: "printed", label: "Printed" },
];

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
  const [tab, setTab] = useState<OrderStatus | "all">("all");
  const [connection, setConnection] = useState<Connection>("connecting");
  const [soundArmed, setSoundArmed] = useState(true); // assume ok until checked
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
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
      void fetch("/api/dashboard/heartbeat", { method: "POST" }).catch(() => {});
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
  }, []);

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

  const filtered = tab === "all" ? orders : orders.filter((o) => o.status === tab);
  const warning = kioskWarning({
    connection,
    soundArmed,
    stale: isStale(lastSyncAt, now),
  });

  return (
    <div className="app" data-display={mode}>
      {warning && (
        <div className={`kiosk-banner kiosk-${warning.level}`} role="status">
          {warning.text}
        </div>
      )}

      <div className="app-head">
        {/* The count IS the headline. Everything else on this screen is
            detail about it, and on a kitchen tablet the only question being
            asked from across the room is "is anything waiting". */}
        <span className={`app-head-count num ${hasNewOrders ? "busy" : "idle"}`}>
          {hasNewOrders ? `${waiting.length} WAITING` : "All clear"}
        </span>

        <div className="app-head-right">
          <span className={`app-live ${connection}`}>
            {connection === "live"
              ? "Live"
              : connection === "connecting"
                ? "Connecting"
                : "Offline"}
          </span>
          <span className="app-clock num">
            {new Date(now).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </span>
          <PushSetup />
        </div>
      </div>

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
            {t.key !== "all" && ` (${orders.filter((o) => o.status === t.key).length})`}
          </button>
        ))}
      </div>

      <div className="app-list">
        {filtered.length === 0 && (
          <div className="app-empty">
            {tab === "all"
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
