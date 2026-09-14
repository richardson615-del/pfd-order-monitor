"use client";

import { useState } from "react";
import Link from "next/link";
import { Order, OrderStatus } from "@/lib/types";
import OrderTicket from "./OrderTicket";
import { orderFlag } from "@/lib/order-display";

export default function OrderViewer({ order: initialOrder }: { order: Order }) {
  const [order, setOrder] = useState(initialOrder);
  const [busy, setBusy] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  /** What the last Print press did. */
  const [printNote, setPrintNote] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);

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

  /**
   * Send this ticket to the restaurant's own printer. Only there.
   *
   * This button used to call window.print(), the BROWSER's print dialog. On a
   * kiosk tablet that reaches nothing - the Epson is not a system printer, it
   * polls the server and prints what it is handed back - so the one device in
   * the building that can make a ticket was the one thing this button could
   * not talk to.
   *
   * The first fix kept that dialog as a fallback for a site with no Epson.
   * That was wrong, and it was found the way you would expect (2026-09-14):
   * "it gives me options to print to printers on the local wifi but not the
   * epson printer". The Android chooser lists system and network printers,
   * and the Epson is structurally incapable of appearing among them - so the
   * dialog is a dead end dressed up as a choice, and the one printer the
   * restaurant actually owns is the only one missing from it.
   *
   * So there is no fallback. Either it goes to the restaurant's printer, or
   * this says why it could not. A refusal somebody can read beats a menu that
   * cannot contain the right answer.
   */
  async function sendToPrinter() {
    setPrinting(true);
    setPrintNote(null);
    try {
      const res = await fetch(`/api/orders/${order.id}/print`, { method: "POST" });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        const where = (data.devices ?? []).join(", ");
        setPrintNote(`Sent to ${where || "the printer"}. It prints in a few seconds.`);
        return;
      }

      // Deliberately NO window.print() fallback, including when there is no
      // printer to send to. See the note on this function.
      setPrintNote(data.error ?? "Could not send that to the printer.");
    } catch {
      setPrintNote("Could not reach the server. Nothing was sent to the printer.");
    } finally {
      setPrinting(false);
    }
  }

  const flag = orderFlag(order);

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
        {/* The word a person can act on, not the database's own. This used
            to render order.status raw, so a ticket said "printed" - a fact
            about the paper channel, which is independent of this screen and
            says nothing about whether anybody has agreed to cook it. */}
        <span className={`badge status-${flag.tone}`}>{flag.label}</span>
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

      {printNote && (
        <p className="no-print print-note" role="status">
          {printNote}
        </p>
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
        <button className="btn" disabled={busy || printing} onClick={sendToPrinter}>
          {printing ? "Sending…" : "Print"}
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
