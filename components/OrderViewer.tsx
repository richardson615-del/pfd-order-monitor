"use client";

import { useState } from "react";
import Link from "next/link";
import { Order, OrderStatus } from "@/lib/types";
import OrderTicket from "./OrderTicket";

export default function OrderViewer({ order: initialOrder }: { order: Order }) {
  const [order, setOrder] = useState(initialOrder);
  const [busy, setBusy] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);

  async function setStatus(status: OrderStatus) {
    setBusy(true);
    try {
      const res = await fetch(`/api/orders/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (data.order) setOrder(data.order);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page" style={{ paddingBottom: 90 }}>
      <div className="topbar no-print">
        <Link href="/dashboard" className="btn small">
          &larr; Back
        </Link>
        <h1>Order #{order.order_number}</h1>
        <span className={`badge status-${order.status}`}>{order.status}</span>
      </div>

      <OrderTicket order={order} />

      {/* The original email, where one exists at all. Kept because it is
          evidence of what was actually sent, and useful when a parsed field
          looks wrong - but it is no longer the view, and there is none for
          any webhook order. */}
      {order.raw_html && (
        <div className="no-print" style={{ marginTop: 16 }}>
          <button className="btn small" onClick={() => setShowOriginal((v) => !v)}>
            {showOriginal ? "Hide original email" : "View original email"}
          </button>
          {showOriginal && (
            <iframe
              className="viewer-frame"
              title={`Original email for order ${order.order_number}`}
              srcDoc={order.raw_html}
              sandbox=""
              style={{ marginTop: 12 }}
            />
          )}
        </div>
      )}

      <div className="action-bar no-print">
        {/*
          Prints the ticket above, not the original email - which a webhook
          order does not have, so this used to open a blank window and then
          mark the order printed anyway.

          It no longer sets status. A browser gives no signal that anything
          reached paper - window.print() returns the same whether it printed
          or the dialog was cancelled - and 'printed' is written by the print
          pipeline to mean a real ticket exists. Guessing it from a button
          press made the Printed tab describe intentions rather than tickets.
        */}
        <button className="btn" disabled={busy} onClick={() => window.print()}>
          Print
        </button>
        <button
          className="btn primary"
          disabled={busy || order.status === "completed"}
          onClick={() => setStatus("completed")}
        >
          {order.status === "completed" ? "Completed" : "Mark complete"}
        </button>
      </div>
    </div>
  );
}
