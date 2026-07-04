"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { Order, OrderStatus } from "@/lib/types";
import OrderCard from "./OrderCard";
import PushSetup from "./PushSetup";
import { playAlertBeep } from "@/lib/sound";

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
  const soundIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const hasNewOrders = useMemo(
    () => orders.some((o) => o.status === "new"),
    [orders]
  );

  // Realtime: reflect new orders + status changes made from other devices immediately
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
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [restaurantId]);

  // Sound alert: keep chiming every few seconds while any order is unopened
  useEffect(() => {
    if (hasNewOrders) {
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
  }, [hasNewOrders]);

  const filtered = tab === "all" ? orders : orders.filter((o) => o.status === tab);

  return (
    <div>
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
