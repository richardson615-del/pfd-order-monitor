import Link from "next/link";
import { Order } from "@/lib/types";
import { ageClass, elapsedLabel, orderFlag } from "@/lib/order-display";

/**
 * One order in the list.
 *
 * Reads the same in both display modes - what changes between kitchen and
 * standard is size and how loudly age is signalled, never which facts are on
 * screen. The CSS does that; this decides what is true.
 *
 * Five things and the flag: number, pickup/delivery, timer, customer, total.
 * Nothing else - if it does not change what the kitchen does next it goes on
 * the ticket or in the CRM, not here. Where the order came from used to be
 * printed after the flag (the platform name), and it is exactly that kind of thing:
 * the restaurant does not care, and cannot act on it. orders.source stays in
 * the data and the admin views; it just never renders on the tablet. The one
 * exception is a TEST order, which gets a muted chip so nobody cooks it.
 *
 * `now` is passed in rather than read here so every card on the screen agrees
 * about the time, and so the timers move when the dashboard ticks instead of
 * only when the data changes.
 */
export default function OrderCard({ order, now }: { order: Order; now: number }) {
  const flag = orderFlag(order);
  const age = ageClass(order, now);

  return (
    <Link
      href={`/order/${order.id}`}
      className={`card ${age}${order.status === "cancelled" ? " cancelled" : ""}`}
    >
      <div className="card-top">
        <span className="card-no num">#{order.order_number}</span>
        <span className="card-type">
          {order.order_type === "delivery" ? "Delivery" : "Pickup"}
        </span>
        <span className="card-age num">{elapsedLabel(order, now)}</span>
      </div>

      <div className="card-who">
        <span className="card-name">{order.customer_name || "Customer"}</span>
        {order.customer_total != null && (
          <span className="card-total num">${order.customer_total.toFixed(2)}</span>
        )}
      </div>

      <div className="card-sub">
        <span className={`card-flag ${flag.tone}`}>{flag.label}</span>
        {order.source === "test" && <span className="card-test">Test — do not make</span>}
      </div>
    </Link>
  );
}
