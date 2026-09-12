import Link from "next/link";
import { Order } from "@/lib/types";
import { ageClass, elapsedLabel, orderFlag } from "@/lib/order-display";

/**
 * What staff should see an order's origin called.
 *
 * 'email' covers the orders we learn about by reading a Zuppler receipt from
 * the inbox rather than from their webhook - two transports, one platform, and
 * the difference is ours to worry about and not the kitchen's. Labelling those
 * "Email" would put an operational distinction nobody there can act on in
 * front of them, and get the answer to "which platform?" wrong.
 */
const SOURCE_LABELS: Record<string, string> = {
  zuppler: "Zuppler",
  email: "Zuppler",
  test: "Test",
};

/**
 * One order in the list.
 *
 * Reads the same in both display modes - what changes between kitchen and
 * standard is size and how loudly age is signalled, never which facts are on
 * screen. The CSS does that; this decides what is true.
 *
 * `now` is passed in rather than read here so every card on the screen agrees
 * about the time, and so the timers move when the dashboard ticks instead of
 * only when the data changes.
 */
export default function OrderCard({ order, now }: { order: Order; now: number }) {
  const flag = orderFlag(order);
  const age = ageClass(order, now);

  return (
    <Link href={`/order/${order.id}`} className={`card ${age}`}>
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
        {order.source && SOURCE_LABELS[order.source] ? ` ${SOURCE_LABELS[order.source]}` : ""}
      </div>

      {/* Kitchen only - CSS hides it in standard, where a tablet somebody is
          standing at does not need telling that a card is tappable. */}
      <span className="card-tap">Tap to open the ticket</span>
    </Link>
  );
}
