"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { Order } from "@/lib/types";
import TicketBody from "./TicketBody";
import { ageClass, elapsedLabel, isSettled, orderFlag } from "@/lib/order-display";
import { countdown, isUnaccepted, prepTimeLabel } from "@/lib/countdown";
import { timeLabel } from "@/lib/local-day";
import { useFreshBuildOnReturn } from "@/lib/use-fresh-build";
import { useTicking } from "@/lib/use-ticking";

/**
 * The ticket, on the tablet.
 *
 * Two actions, in order (I3, Nick 2026-09-17): ACCEPT - "we've got it" -
 * which stops the chime and starts the countdown from the restaurant's
 * prep target; then COMPLETE, any time after, which marks it completed
 * and goes back to the kitchen list. Opening this page stamps opened_at
 * for the office's records and changes nothing the kitchen hears.
 *
 * Print again sends it to the restaurant's own printer, and only there.
 * A completed or cancelled ticket is read-only: Print again still works,
 * Complete is gone, and the footer says when it was done and how long the
 * kitchen took.
 */
export default function OrderViewer({
  order: initialOrder,
  timezone,
  prepMinutes,
}: {
  order: Order;
  timezone: string | null;
  /** The restaurant's prep target, minutes - what Accept counts down from. */
  prepMinutes: number;
}) {
  const [order, setOrder] = useState(initialOrder);
  const [busy, setBusy] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  /** What the last Print press did. */
  const [printNote, setPrintNote] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const now = useTicking();

  // A new deployment is taken only when the tablet comes back to the
  // foreground on this ticket, and never mid-Done or mid-Print. Not on a
  // timer: a ticket somebody is reading is not reloaded to get new code.
  const idle = useCallback(() => !busy && !printing, [busy, printing]);
  useFreshBuildOnReturn(idle);

  /**
   * Accept. One PATCH; the row the server hands back replaces ours so the
   * countdown runs from the server's accepted_at. Stays on the ticket -
   * the cook is reading it.
   */
  async function accept() {
    setBusy(true);
    try {
      const res = await fetch(`/api/orders/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accepted: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPrintNote(data.error ?? "Could not accept that. Try again.");
        return;
      }
      if (data.order) setOrder(data.order);
    } catch {
      setPrintNote("Could not reach the server. The order is still waiting.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Complete. Marks it completed, then goes back to the list - a full
   * navigation, so the list is re-read from the server rather than trusting
   * that the next poll beat us there.
   */
  async function markDone() {
    setBusy(true);
    try {
      const res = await fetch(`/api/orders/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPrintNote(data.error ?? "Could not mark that complete. Try again.");
        return;
      }
      if (data.order) setOrder(data.order);
      window.location.assign("/dashboard");
    } catch {
      setPrintNote("Could not reach the server. The order is still in the kitchen.");
    } finally {
      setBusy(false);
    }
  }

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
  const settled = isSettled(order);
  const cd = countdown(order, prepMinutes, now);
  const waiting = isUnaccepted(order);
  // Accepted: the page's colour follows the countdown, not the age.
  const age = cd ? (cd.phase === "calm" ? "age-calm" : cd.phase === "amber" ? "age-warn" : "age-late") : ageClass(order, now);
  const kind = order.order_type === "delivery" ? "Delivery" : "Pickup";
  const prepTaken = prepTimeLabel(order.accepted_at, order.completed_at);

  return (
    <div className={`app ticket-page ${age}${cd ? ` counting ${cd.phase}` : ""}`} data-display="kitchen">
      <div className="ticket-top no-print">
        <Link href="/dashboard" className="btn ticket-back">
          &larr; Orders
        </Link>
        <span className="ticket-kind">
          {kind} · ordered <span className="num">{timeLabel(order.received_at, timezone)}</span>
        </span>
        {/* The word a person can act on, not the database's own. This used
            to render order.status raw, so a ticket said "printed" - a fact
            about the paper channel, which is independent of this screen. */}
        {flag && !cd && <span className={`card-flag ${flag.tone}`}>{flag.label}</span>}
      </div>

      <div className="ticket-head">
        <span className="ticket-no num">#{order.order_number}</span>
        {/* The big number. Accepted: the countdown - the promise, large,
            amber under five minutes, red and counting up past zero. Not yet
            accepted, or settled: the timer - how long the customer has been
            waiting, counting up, in the colour the card had. */}
        {cd ? (
          <span className={`ticket-timer ticket-countdown num ${cd.phase}`} aria-live="off">
            {cd.label}
            <small className="ticket-countdown-age num">waiting {elapsedLabel(order, now)}</small>
          </span>
        ) : (
          <span className={`ticket-timer num ${age}`}>{elapsedLabel(order, now)}</span>
        )}
      </div>

      <div className="ticket-who">
        <span className="ticket-name">{order.customer_name || "Customer"}</span>
        {order.due_time && (
          <span className="ticket-due">
            {kind} at <span className="num">{timeLabel(order.due_time, timezone)}</span>
          </span>
        )}
      </div>

      {order.source === "test" && (
        <p className="ticket-test" role="status">
          Test order — do not make. Sent to check this tablet.
        </p>
      )}

      <TicketBody order={order} />

      {/* The original email, where one exists at all. Kept because it is
          evidence of what was actually sent, and useful when a parsed field
          looks wrong - but it is no longer the view, and there is none for
          any webhook order. */}
      {order.raw_html && (
        <div className="no-print ticket-original">
          <button className="btn small" onClick={() => setShowOriginal((v) => !v)}>
            {showOriginal ? "Hide original email" : "View original email"}
          </button>
          {showOriginal && (
            <iframe
              className="viewer-frame"
              title={`Original email for order ${order.order_number}`}
              srcDoc={order.raw_html}
              sandbox=""
            />
          )}
        </div>
      )}

      {printNote && (
        <p className="no-print print-note" role="status">
          {printNote}
        </p>
      )}

      <div className="ticket-actions no-print">
        {/* Prints the ticket, on the restaurant's printer. It does not set
            status: 'printed' is written by the print pipeline to mean a real
            ticket exists, and a button press is not that. */}
        <button className="btn ticket-print" disabled={busy || printing} onClick={sendToPrinter}>
          {printing ? "Sending…" : "Print again"}
        </button>
        {/* The loud one - Accept first, then Complete - green, tall, and it
            fills the rest of the row, because on a screen read from across
            a kitchen the one action there is should not be the same size
            as "Print again". */}
        {settled ? (
          <span className={`ticket-settled ${order.status}`}>
            {order.status === "cancelled"
              ? `Cancelled ${timeLabel(order.cancelled_at ?? order.received_at, timezone)}`
              : `Completed ${timeLabel(order.completed_at ?? order.received_at, timezone)}${prepTaken ? ` (${prepTaken})` : ""}`}
          </span>
        ) : waiting ? (
          <button className="btn ticket-done ticket-accept" disabled={busy} onClick={accept}>
            {busy ? "Accepting…" : "Accept"}
          </button>
        ) : (
          <button className="btn ticket-done" disabled={busy} onClick={markDone}>
            {busy ? "Completing…" : "Complete"}
          </button>
        )}
      </div>
    </div>
  );
}
