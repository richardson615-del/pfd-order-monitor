import Link from "next/link";
import { Order } from "@/lib/types";

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

function timeAgo(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

export default function OrderCard({ order }: { order: Order }) {
  return (
    <Link href={`/order/${order.id}`} className={`order-card status-${order.status}`}>
      <div className="order-card-top">
        <span className="order-number">
          Order #{order.order_number}
          <span className={`badge status-${order.status}`}>{order.status}</span>
        </span>
        {order.customer_total != null && (
          <span className="order-total">${order.customer_total.toFixed(2)}</span>
        )}
      </div>
      <div className="order-meta">
        {order.customer_name || "Customer"} &middot;{" "}
        {order.order_type === "delivery" ? "Delivery" : "Pickup"} &middot;{" "}
        {timeAgo(order.received_at)}
      </div>
      {order.source && SOURCE_LABELS[order.source] && (
        <span className="order-source">{SOURCE_LABELS[order.source]}</span>
      )}
    </Link>
  );
}
