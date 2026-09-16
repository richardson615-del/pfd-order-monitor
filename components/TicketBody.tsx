import { Order } from "@/lib/types";

/**
 * The order itself: what was ordered, what it costs, what the customer
 * said, how to reach them.
 *
 * Laid out for a kitchen screen (Nick's OrderDetail design, 2026-09-16):
 * big item lines, modifiers in amber underneath each - the modifier is the
 * thing that gets missed - the money in one block, the note where it
 * cannot be skimmed past. Same facts as the paper ticket, from the same
 * row; a different arrangement, because a 48-column thermal layout is the
 * printer's constraint, not the screen's.
 *
 * Server-safe and pure, so the demo page can render the same component.
 */
const money = (n: number | null | undefined) =>
  n == null ? null : `$${n.toFixed(2)}`;

export default function TicketBody({ order }: { order: Order }) {
  const items = order.items ?? [];
  const money_rows: [string, string | null][] = [
    ["Items", money(order.items_total)],
    ["Tax", money(order.tax)],
    ["Service fee", money(order.service_fee)],
    ["Delivery fee", money(order.delivery_fee)],
    ["Tip", money(order.tip)],
    ["Discount", order.discount != null ? `−${money(order.discount)}` : null],
  ];

  return (
    <div className="tk">
      <ol className="tk-items">
        {items.length === 0 && <li className="tk-item tk-empty">No items were listed on this order.</li>}
        {items.map((it, i) => (
          <li key={i} className="tk-item">
            <div className="tk-line">
              <span className="tk-name">{it.name}</span>
              {it.price && <span className="tk-price num">{it.price}</span>}
            </div>
            {it.modifiers?.length > 0 && (
              <ul className="tk-mods">
                {it.modifiers.map((m, j) => (
                  <li key={j}>{m}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>

      <div className="tk-money">
        {money_rows
          .filter(([, v]) => v !== null)
          .map(([k, v]) => (
            <div key={k} className="tk-row">
              <span>{k}</span>
              <span className="num">{v}</span>
            </div>
          ))}
        <div className="tk-row tk-total">
          <span>Total</span>
          <span className="num">{money(order.customer_total) ?? "—"}</span>
        </div>
        {order.payment_type && <div className="tk-pay">{order.payment_type}</div>}
      </div>

      {order.notes && (
        <div className="tk-note">
          <span className="tk-label">Customer note</span>
          <p>{order.notes}</p>
        </div>
      )}

      {(order.customer_phone || order.customer_address) && (
        <div className="tk-contact">
          {order.customer_phone && (
            <a className="tk-phone num" href={`tel:${order.customer_phone.replace(/[^\d+]/g, "")}`}>
              {order.customer_phone}
            </a>
          )}
          {order.customer_address && <span className="tk-address">{order.customer_address}</span>}
        </div>
      )}
    </div>
  );
}
