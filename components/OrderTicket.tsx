import { Order } from "@/lib/types";
import { splitQuantity } from "@/lib/ticket";

/**
 * An order as the kitchen reads it, rendered from the normalised row.
 *
 * This screen used to be an iframe of `raw_html` - the original order EMAIL.
 * Webhook orders have never had one (migration 002 dropped the NOT NULL for
 * that reason), so every Zuppler order opened to a blank page: an alert, a
 * total, and no way to find out what to cook.
 *
 * Rendering from the columns instead means one normalised order however it
 * arrived, which is the same thing the printer and the email leg already do.
 * The original email is still available underneath where one exists, as
 * evidence rather than as the view.
 *
 * The layout deliberately follows the paper ticket's decisions rather than
 * inventing its own, because a cook reading one and then the other should not
 * have to re-learn where to look: type and due time first, quantity in its own
 * column, modifiers attached to their item and never lighter than it.
 */

const money = (v: number | string | null | undefined): string | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : null;
};

const localTime = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    weekday: "short", hour: "numeric", minute: "2-digit",
  });
};

export default function OrderTicket({ order }: { order: Order }) {
  const type = (order.order_type || "order").toUpperCase();
  const due = localTime(order.due_time);

  // A due time before the order was placed means a replayed or backfilled
  // order, not a deadline already missed. Saying so beats letting the kitchen
  // read it as urgently late. Same rule the paper ticket applies.
  const dueMs = order.due_time ? new Date(order.due_time).getTime() : NaN;
  const recvMs = order.received_at ? new Date(order.received_at).getTime() : NaN;
  const stale = Number.isFinite(dueMs) && Number.isFinite(recvMs) && dueMs < recvMs;

  // The mapper joins street, cross street and delivery instructions with
  // " | ", which reads fine in a database and badly to a driver. The street is
  // the address; anything after it is an instruction.
  const [street, ...instructions] = String(order.customer_address ?? "").split(" | ");

  const items = Array.isArray(order.items) ? order.items : [];

  const totals: [string, string | null][] = [
    ["Items", money(order.items_total)],
    ["Tax", money(order.tax)],
    ["Service", money(order.service_fee)],
    ["Delivery", money(order.delivery_fee)],
    ["Tip", money(order.tip)],
    ["Discount", order.discount ? `-${money(order.discount)}` : null],
  ];

  return (
    <article className="ticket">
      {order.cancelled_at && (
        <p className="ticket-cancelled">
          Cancelled {localTime(order.cancelled_at)} &middot; do not make this order
        </p>
      )}

      <header className={`ticket-type ticket-type-${order.order_type ?? "unknown"}`}>
        {type}
      </header>

      {due && (
        <p className="ticket-due">
          Due {due}
          {stale && <span className="ticket-due-past"> (past)</span>}
        </p>
      )}

      <p className="ticket-placed">
        Order #{order.order_number}
        {localTime(order.received_at) && ` · placed ${localTime(order.received_at)}`}
      </p>

      {(order.customer_name || order.customer_phone || order.customer_address) && (
        <section className="ticket-block">
          {order.customer_name && <p className="ticket-customer">{order.customer_name}</p>}
          {order.customer_phone && (
            // A tap-to-call is the difference between reading a number off a
            // screen and actually ringing a customer whose order is wrong.
            <p>
              <a className="ticket-phone" href={`tel:${order.customer_phone.replace(/[^\d+]/g, "")}`}>
                {order.customer_phone}
              </a>
            </p>
          )}
          {street && (
            <div className="ticket-address">
              <p className="ticket-street">{street}</p>
              {instructions.map((ins, i) => (
                <p key={i} className="ticket-instruction">{ins}</p>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="ticket-block">
        <div className="ticket-items-head">
          <span>Qty</span>
          <span>Item</span>
          <span>Amount</span>
        </div>

        {items.length === 0 && (
          <p className="ticket-noitems">No itemisation available for this order.</p>
        )}

        {items.map((it, idx) => {
          const { qty, name } = splitQuantity(it?.name ?? "Item", it as any);
          const price = typeof it?.price === "string" ? it.price : money(it?.price);
          return (
            <div className="ticket-item" key={idx}>
              <span className="ticket-qty">{qty}</span>
              <div className="ticket-item-body">
                <p className="ticket-item-name">{name}</p>
                {/* Modifiers are what ruins a plate when missed, so they are
                    never set lighter than the item they belong to. */}
                {(it?.modifiers ?? []).map((mod, i) => (
                  <p key={i} className="ticket-mod">{mod}</p>
                ))}
              </div>
              <span className="ticket-price">{price ?? ""}</span>
            </div>
          );
        })}
      </section>

      {order.notes && (
        <section className="ticket-note">
          <h2>Note</h2>
          <p>{order.notes}</p>
        </section>
      )}

      <section className="ticket-block ticket-totals">
        {totals.map(([label, value]) =>
          value ? (
            <p key={label}>
              <span>{label}</span>
              <span>{value}</span>
            </p>
          ) : null
        )}
        {money(order.customer_total) && (
          <p className="ticket-total">
            <span>Total</span>
            <span>{money(order.customer_total)}</span>
          </p>
        )}
        {order.payment_type && <p className="ticket-payment"><span>{order.payment_type}</span></p>}
      </section>
    </article>
  );
}
