"use client";

import { Order } from "@/lib/types";
import { customerChangeBanner } from "@/lib/customer-change-banner";
import { timeLabel } from "@/lib/local-day";

/**
 * ED3 (2026-11-28): dispatch changed this order's customer details in the
 * CRM. A yellow bar, "Customer details changed 6:42 PM", with what changed,
 * until somebody taps it (PATCH { customer_seen: true }, which clears it on
 * every screen at the restaurant). The details themselves are already the
 * new ones - the card and the ticket read the same columns.
 *
 * Renders nothing for an order with no change, a settled order, or a row
 * from before migration 069.
 */
export default function CustomerChangedBanner({
  order,
  timezone,
  onSeen,
}: {
  order: Order;
  timezone?: string | null;
  onSeen?: (order: Order) => void;
}) {
  const banner = customerChangeBanner(order);
  if (!banner) return null;
  const what = banner.fields.length ? ` · ${banner.fields.join(", ")}` : "";
  return (
    <button
      type="button"
      className="customer-changed"
      role="status"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSeen?.(order);
      }}
    >
      <span className="customer-changed-text">
        Customer details changed <span className="num">{timeLabel(banner.at, timezone)}</span>
        {what}
      </span>
      <span className="customer-changed-ok">Tap when seen</span>
    </button>
  );
}
