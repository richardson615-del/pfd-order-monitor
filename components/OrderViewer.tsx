"use client";

import { useState } from "react";
import Link from "next/link";
import { Order, OrderStatus } from "@/lib/types";
import OrderTicket from "./OrderTicket";

export default function OrderViewer({ order: initialOrder }: { order: Order }) {
  const [order, setOrder] = useState(initialOrder);
  const [busy, setBusy] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch(`/api/orders/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.order) setOrder(data.order);
    } finally {
      setBusy(false);
    }
  }

  const setStatus = (status: OrderStatus) => patch({ status });
  const accept = () => patch({ accepted: true });

  const acceptedAt = order.accepted_at
    ? new Date(order.accepted_at).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

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
        {/* The ticket prints the number as plain text, the way paper does.
            The tablet is the thing in someone's hand when an order is wrong,
            so the action lives beside the ticket rather than inside it. */}
        {order.customer_phone && (
          <a
            className="btn"
            href={`tel:${order.customer_phone.replace(/[^\d+]/g, "")}`}
          >
            Call customer
          </a>
        )}
        <button className="btn" disabled={busy} onClick={() => window.print()}>
          Print
        </button>
        {/*
          Accept is the loud one, and it is what stops the chime. Deliberately
          bigger than everything beside it: it is the action the tablet is
          sounding for, and on a screen read from across a kitchen the thing
          that silences the room should not be the same size as "Print".

          It stays visible once accepted, showing when - so the next person to
          walk past can see the order was picked up rather than wondering
          whether the tablet had simply been ignored.
        */}
        {order.accepted_at ? (
          <span className="accepted-mark">Accepted {acceptedAt}</span>
        ) : (
          <button className="btn accept" disabled={busy} onClick={accept}>
            Accept order
          </button>
        )}
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
