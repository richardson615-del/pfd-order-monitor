"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { Order, OrderStatus } from "@/lib/types";
import OrderCard from "./OrderCard";
import PushSetup from "./PushSetup";
import { armAudio, isAudioArmed, playAlertBeep } from "@/lib/sound";
import {
  Connection,
  isStale,
  kioskWarning,
  pollIntervalMs,
  realtimeConnection,
  unaccepted,
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
}: {
  initialOrders: Order[];
  restaurantId: string;
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

  // Drives the staleness check. A screen that cannot reach the database has to
  // say so on its own, without waiting for an event that is not coming.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
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
    <div>
      {warning && (
        <div className={`kiosk-banner kiosk-${warning.level}`} role="status">
          {warning.text}
        </div>
      )}

      {/* Why the room is beeping, in one line, readable from a distance. */}
      {hasNewOrders && (
        <div className="waiting-bar" role="status">
          {waiting.length === 1
            ? "1 order waiting — open it and press Accept"
            : `${waiting.length} orders waiting — open each one and press Accept`}
        </div>
      )}

      <div className="topbar">
        <h1>PFD Orders</h1>
        <PushSetup />
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`tab ${tab === t.key ? "active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.key !== "all" &&
              ` (${orders.filter((o) => o.status === t.key).length})`}
          </button>
        ))}
      </div>

      <div className="order-list">
        {filtered.length === 0 && (
          <div className="empty-state">No orders here yet.</div>
        )}
        {filtered.map((order) => (
          <OrderCard key={order.id} order={order} />
        ))}
      </div>
    </div>
  );
}
