"use client";

import Link from "next/link";
import { Order } from "@/lib/types";
import { ageClass, dueLabel, elapsedLabel, isScheduled, itemsLine, orderFlag } from "@/lib/order-display";
import { countdown, isUnaccepted } from "@/lib/countdown";
import { RUNNING_LATE_STEPS, isReady, readyChoices, runningLateMinutes } from "@/lib/ready-timer";

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
 * PA5 (Matt 2026-10-26): Accept says how long - the quick picks (the
 * restaurant's target highlighted, and the big Accept button uses it); an
 * accepted order gets a big READY button, separate from COMPLETE on the
 * ticket, and "Running late" +5 / +10. Ready shows READY in the pill.
 *
 * SC1 (Nick 2026-10-29): an order due more than two hours out is SCHEDULED -
 * a calm "Scheduled" pill and "Due Tomorrow 11:30 AM" where the age would
 * be, a plain Accept (it acknowledges; there is nothing to time yet) and no
 * Ready or +5 / +10. Two hours before it is due it is an ordinary card.
 *
 * `now` is passed in rather than read here so every card on the screen agrees
 * about the time, and so the timers move when the dashboard ticks instead of
 * only when the data changes.
 */
export default function OrderCard({
  order,
  now,
  timezone,
  prepMinutes,
  onAccept,
  onReady,
  onRetime,
}: {
  order: Order;
  now: number;
  timezone?: string | null;
  prepMinutes: number;
  onAccept?: (order: Order, minutes?: number) => void;
  onReady?: (order: Order) => void;
  onRetime?: (order: Order, minutes: number) => void;
}) {
  const flag = orderFlag(order);
  const cd = countdown(order, prepMinutes, now);
  const waiting = isUnaccepted(order);
  const ready = isReady(order);
  const scheduled = isScheduled(order, now);
  const cooking = !waiting && !ready && !scheduled && cd !== null;
  const stop = (e: { preventDefault(): void; stopPropagation(): void }) => {
    e.preventDefault();
    e.stopPropagation();
  };
  // An accepted order's rail follows its countdown, not its age: it has been
  // taken, and what matters now is the promise.
  const tone = cd ? `age-${cd.phase === "calm" ? "calm" : cd.phase === "amber" ? "warn" : "late"}` : ageClass(order, now);
  const items = itemsLine(order.items);

  return (
    <div
      className={`card ${tone}${order.status === "cancelled" ? " cancelled" : ""}${waiting ? " unopened" : ""}${cd ? ` counting ${cd.phase}` : ""}${scheduled ? " scheduled" : ""}`}
    >
      <Link href={`/order/${order.id}`} className="card-body">
        <div className="card-top">
          <span className="card-no num">#{order.order_number}</span>
          <span className="card-type">
            {order.order_type === "delivery" ? "Delivery" : "Pickup"}
          </span>
          {scheduled ? (
            <span className="card-flag scheduled">Scheduled</span>
          ) : ready && order.status !== "completed" && order.status !== "cancelled" ? (
            <span className="card-flag ready">Ready</span>
          ) : cd ? (
            <span className={`card-flag countdown ${cd.phase} num`} aria-label={cd.phase === "over" ? `${cd.label}` : `${cd.label} left`}>
              {cd.label}
            </span>
          ) : (
            flag && <span className={`card-flag ${flag.tone}`}>{flag.label}</span>
          )}
          {scheduled ? (
            <span className="card-age card-due num">Due {dueLabel(order.due_time, now, timezone)}</span>
          ) : (
            <span className="card-age num">{elapsedLabel(order, now)}</span>
          )}
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
        <>
          <button
            type="button"
            className="btn card-accept"
            onClick={(e) => {
              stop(e);
              onAccept(order);
            }}
          >
            {/* SC1: a scheduled order is acknowledged, not timed - no minutes. */}
            {scheduled ? "Accept" : <>Accept · {prepMinutes} min</>}
          </button>
          {!scheduled && <div className="card-minutes" role="group" aria-label="Ready in how many minutes">
            <span className="card-minutes-label">Ready in</span>
            {readyChoices(prepMinutes).map((m) => (
              <button
                key={m}
                type="button"
                className={`btn small card-minute num${m === prepMinutes ? " default" : ""}`}
                onClick={(e) => {
                  stop(e);
                  onAccept(order, m);
                }}
              >
                {m}
              </button>
            ))}
          </div>}
        </>
      )}

      {cooking && onReady && (
        <div className="card-ready-row">
          <button
            type="button"
            className="btn card-ready"
            onClick={(e) => {
              stop(e);
              onReady(order);
            }}
          >
            Ready
          </button>
          {onRetime &&
            RUNNING_LATE_STEPS.map((add) => {
              const minutes = runningLateMinutes(order, add, prepMinutes, now);
              return minutes === null ? null : (
                <button
                  key={add}
                  type="button"
                  className="btn small card-late num"
                  aria-label={`Running late, add ${add} minutes`}
                  onClick={(e) => {
                    stop(e);
                    onRetime(order, minutes);
                  }}
                >
                  +{add}
                </button>
              );
            })}
        </div>
      )}
    </div>
  );
}
