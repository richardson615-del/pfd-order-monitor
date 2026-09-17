"use client";

import Link from "next/link";
import { Order } from "@/lib/types";
import { ageClass, elapsedLabel, itemsLine, orderFlag } from "@/lib/order-display";
import { countdown, isUnaccepted } from "@/lib/countdown";

/**
 * One order in the kitchen list.
 *
 * Reads the same in both display modes - what changes between kitchen and
 * standard is size and how loudly age is signalled, never which facts are on
 * screen. The CSS does that; this decides what is true.
 *
 * Number, pickup/delivery, the pill, the timer, the customer, the total, and
 * one line of what they ordered - the first three items, so the fish can be
 * told from the chicken across the pass. Nothing else. Where the order came
 * from is exactly the kind of thing that does not go here: the restaurant
 * does not care and cannot act on it. The one exception is a TEST order,
 * which says so quietly so nobody cooks it.
 *
 * The pill (I3, Nick 2026-09-17): NEW with an ACCEPT button until somebody
 * taps it; then the countdown - calm, amber under five minutes, red and
 * counting up past zero. The timer on the right always counts up from
 * arrival; the countdown is the promise, the timer is the truth.
 *
 * `now` is passed in rather than read here so every card on the screen agrees
 * about the time, and so the timers move when the dashboard ticks instead of
 * only when the data changes.
 */
export default function OrderCard({
  order,
  now,
  prepMinutes,
  onAccept,
}: {
  order: Order;
  now: number;
  prepMinutes: number;
  onAccept?: (order: Order) => void;
}) {
  const flag = orderFlag(order);
  const cd = countdown(order, prepMinutes, now);
  const waiting = isUnaccepted(order);
  // An accepted order's rail follows its countdown, not its age: it has been
  // taken, and what matters now is the promise.
  const tone = cd ? `age-${cd.phase === "calm" ? "calm" : cd.phase === "amber" ? "warn" : "late"}` : ageClass(order, now);
  const items = itemsLine(order.items);

  return (
    <div
      className={`card ${tone}${order.status === "cancelled" ? " cancelled" : ""}${waiting ? " unopened" : ""}${cd ? ` counting ${cd.phase}` : ""}`}
    >
      <Link href={`/order/${order.id}`} className="card-body">
        <div className="card-top">
          <span className="card-no num">#{order.order_number}</span>
          <span className="card-type">
            {order.order_type === "delivery" ? "Delivery" : "Pickup"}
          </span>
          {cd ? (
            <span className={`card-flag countdown ${cd.phase} num`} aria-label={cd.phase === "over" ? `${cd.label}` : `${cd.label} left`}>
              {cd.label}
            </span>
          ) : (
            flag && <span className={`card-flag ${flag.tone}`}>{flag.label}</span>
          )}
          <span className="card-age num">{elapsedLabel(order, now)}</span>
        </div>

        <div className="card-who">
          <span className="card-name">{order.customer_name || "Customer"}</span>
          {order.customer_total != null && (
            <span className="card-total num">${order.customer_total.toFixed(2)}</span>
          )}
        </div>

        {(items || order.source === "test") && (
          <div className="card-items">
            {items}
            {order.source === "test" && <span className="card-test">Test — do not make</span>}
          </div>
        )}
      </Link>

      {waiting && onAccept && (
        <button
          type="button"
          className="btn card-accept"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onAccept(order);
          }}
        >
          Accept
        </button>
      )}
    </div>
  );
}
