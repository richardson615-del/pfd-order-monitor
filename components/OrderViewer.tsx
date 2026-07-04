"use client";

import { useState } from "react";
import Link from "next/link";
import { Order, OrderStatus } from "@/lib/types";

export default function OrderViewer({ order: initialOrder }: { order: Order }) {
  const [order, setOrder] = useState(initialOrder);
  const [busy, setBusy] = useState(false);

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

  function printTicket() {
    // The printer kit prints via the restaurant's browser print dialog for
    // MVP; the dedicated ESC/POS thermal-printer path is the next iteration.
    const win = window.open("", "_blank", "width=400,height=600");
    if (!win) return;
    win.document.write(order.raw_html);
    win.document.close();
    win.focus();
    win.print();
    setStatus("printed");
  }

  return (
    <div className="page" style={{ paddingBottom: 90 }}>
      <div className="topbar">
        <Link href="/dashboard" className="btn small">
          &larr; Back
        </Link>
        <h1>Order #{order.order_number}</h1>
        <span className={`badge status-${order.status}`}>{order.status}</span>
      </div>

      <div style={{ padding: 16 }}>
        <iframe
          className="viewer-frame"
          title={`Order ${order.order_number}`}
          srcDoc={order.raw_html}
          sandbox=""
        />
      </div>

      <div className="action-bar">
        <button className="btn" disabled={busy} onClick={printTicket}>
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
