import Link from "next/link";
import { Order } from "@/lib/types";
import { timeLabel } from "@/lib/local-day";

/**
 * One row in Completed, or under a day in Past week.
 *
 * Quieter than a kitchen card on purpose: nothing here is owed. A dot for
 * the state, the number, who and what kind, the total, and when it was
 * done. A cancelled order is in the list - struck through, red dot - so
 * that a ticket somebody remembers seeing does not simply vanish. An order
 * that was never marked Done (it aged out at midnight) says so; it is not
 * dressed up as completed.
 *
 * Tap opens the ticket read-only: Print again works, Done is gone.
 */
export type CompletedRowOrder = Pick<
  Order,
  "id" | "order_number" | "order_type" | "customer_name" | "customer_total" | "status" | "source" | "received_at" | "completed_at" | "cancelled_at"
>;

export default function CompletedRow({
  order,
  timezone,
}: {
  order: CompletedRowOrder;
  timezone: string | null | undefined;
}) {
  const state =
    order.status === "cancelled" ? "cancelled" : order.status === "completed" ? "done" : "open";
  const when =
    state === "done"
      ? `Done ${timeLabel(order.completed_at ?? order.received_at, timezone)}`
      : state === "cancelled"
        ? `Cancelled ${timeLabel(order.cancelled_at ?? order.received_at, timezone)}`
        : "Not marked done";

  return (
    <Link href={`/order/${order.id}`} className={`done-row ${state}`}>
      <span className="done-dot" aria-hidden="true" />
      <span className="done-no num">#{order.order_number}</span>
      <span className="done-who">
        <span className="done-name">{order.customer_name || "Customer"}</span>
        <span className="done-kind">
          {order.order_type === "delivery" ? "Delivery" : "Pickup"}
          {order.source === "test" ? " · Test" : ""}
        </span>
      </span>
      {order.customer_total != null && <span className="done-total num">${order.customer_total.toFixed(2)}</span>}
      <span className="done-when num">{when}</span>
    </Link>
  );
}
