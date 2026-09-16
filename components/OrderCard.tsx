import Link from "next/link";
import { Order } from "@/lib/types";
import { ageClass, elapsedLabel, itemsLine, orderFlag } from "@/lib/order-display";

/**
 * One order in the kitchen list.
 *
 * Reads the same in both display modes - what changes between kitchen and
 * standard is size and how loudly age is signalled, never which facts are on
 * screen. The CSS does that; this decides what is true.
 *
 * Number, pickup/delivery, the NEW pill until somebody opens it, the timer,
 * the customer, the total, and one line of what they ordered - the first
 * three items, so the fish can be told from the chicken across the pass.
 * Nothing else. Where the order came from is exactly the kind of thing
 * that does not go here: the restaurant does not care and cannot act on
 * it. orders.source stays in the data and the admin views. The one
 * exception is a TEST order, which says so quietly so nobody cooks it.
 *
 * `now` is passed in rather than read here so every card on the screen agrees
 * about the time, and so the timers move when the dashboard ticks instead of
 * only when the data changes.
 */
export default function OrderCard({ order, now }: { order: Order; now: number }) {
  const flag = orderFlag(order);
  const age = ageClass(order, now);
  const items = itemsLine(order.items);

  return (
    <Link
      href={`/order/${order.id}`}
      className={`card ${age}${order.status === "cancelled" ? " cancelled" : ""}${flag?.tone === "new" ? " unopened" : ""}`}
    >
      <div className="card-top">
        <span className="card-no num">#{order.order_number}</span>
        <span className="card-type">
          {order.order_type === "delivery" ? "Delivery" : "Pickup"}
        </span>
        {flag && <span className={`card-flag ${flag.tone}`}>{flag.label}</span>}
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
  );
}
