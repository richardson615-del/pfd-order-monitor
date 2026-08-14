import type { CanonicalOrderInput } from "./canonical";

/**
 * Zuppler integration - real flow per Zuppler's spec (Jerry Dani, Feb 2026):
 *
 *   1. Zuppler POSTs a thin webhook payload containing order_uuid, with an
 *      Authorization header set to a token WE generated and shared with them.
 *   2. We fetch the full order from their GraphQL API:
 *      https://orders-api5.zuppler.com/graphql  (explorer: graphiql.zuppler.com)
 *   3. mapZupplerGraphqlOrder() maps the response to the canonical order.
 *
 * The LoadOrder query below is exactly the one Zuppler provided. Expand it
 * via graphiql.zuppler.com if more fields are needed - do NOT add guessed
 * field names, GraphQL rejects the whole query on any unknown field.
 *
 * The delivery address lives under carts.settings.service.address (confirmed
 * by Jerry Dani, Aug 2026). Amounts are cents, also per Jerry. The webhook is
 * channel-level - one hook covers every restaurant - and fires on order CREATE
 * (at confirmation) and order CANCEL, so a payload may describe an order that
 * is no longer live.
 */

export const ZUPPLER_GRAPHQL_ENDPOINT = "https://orders-api5.zuppler.com/graphql";

export const LOAD_ORDER_QUERY = `query LoadOrder($order_uuid: ID!) { order(id: $order_uuid) { uuid pickupTime paymentInfo { authorization dateTime } fireTime dueTime deliveryTime createdAt confirmationTime totals { delivery discount hidden includedTax service subtotal tax tip total } shortUuid state workflowId carts { channelId integrationId restaurantId comments instructions settings { service { id address { street city state zip full crossStreet deliveryInstructions } } tender { id } } customer { uuid name email phone } discounts { id title promocode } items { id category comments name menu menuId quantity itemTotal servingQty } } } }`;

/* eslint-disable @typescript-eslint/no-explicit-any */

function str(v: any): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Zuppler money values may be integer cents (their own sample code hedges on
 * this: "If totals.total is cents (e.g. 1699), convert to dollars").
 * ZUPPLER_AMOUNTS=cents|dollars controls conversion; default cents.
 * VERIFY against the first real order and set the env var accordingly.
 */
function money(v: any): number | null {
  let n: number | null = null;
  if (typeof v === "number" && isFinite(v)) n = v;
  else if (typeof v === "string" && v.trim()) {
    const p = parseFloat(v);
    if (isFinite(p)) n = p;
  }
  if (n == null) return null;
  const mode = process.env.ZUPPLER_AMOUNTS === "dollars" ? "dollars" : "cents";
  return mode === "cents" ? Math.round(n) / 100 : n;
}

function isoOrNull(v: any): string | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export interface MappedZupplerOrder {
  externalId: string | null;
  /** Zuppler's order state, e.g. "confirmed" / "cancelled". */
  state: string | null;
  /** Zuppler's numeric restaurantId from the cart - our routing key. */
  zupplerRestaurantId: string | null;
  canonical: Omit<CanonicalOrderInput, "source" | "externalId" | "restaurantId">;
}

/** Maps a LoadOrder GraphQL response (or just its order object) to canonical. */
export function mapZupplerGraphqlOrder(resp: any): MappedZupplerOrder {
  const order = resp?.data?.order ?? resp?.order ?? resp ?? {};
  const carts = Array.isArray(order.carts) ? order.carts : order.carts ? [order.carts] : [];
  const cart = carts[0] ?? {};
  const customer = cart.customer ?? {};
  const totals = order.totals ?? {};

  // Order type: prefer the service setting id, fall back to which time is set
  const serviceId = String(cart.settings?.service?.id ?? "").toLowerCase();
  let orderType: "pickup" | "delivery" | null = /deliv/.test(serviceId)
    ? "delivery"
    : /pick|takeout|carry|curb/.test(serviceId)
      ? "pickup"
      : null;
  if (!orderType) {
    if (str(order.deliveryTime)) orderType = "delivery";
    else if (str(order.pickupTime)) orderType = "pickup";
  }

  const rawItems: any[] = Array.isArray(cart.items) ? cart.items : [];
  const items = rawItems.map((it) => {
    const qty = typeof it.quantity === "number" ? it.quantity : 1;
    const name = str(it.name) ?? str(it.menu) ?? "Item";
    const priceNum = money(it.itemTotal);
    const modifiers: string[] = [];
    const comment = str(it.comments);
    if (comment) modifiers.push(comment);
    return {
      name: qty > 1 ? `${qty}x ${name}` : name,
      price: priceNum != null ? `$${priceNum.toFixed(2)}` : null,
      modifiers,
    };
  });

  // Notes: cart-level comments + instructions, both free text from customer
  const notes =
    [str(cart.comments), str(cart.instructions)].filter(Boolean).join(" | ") ||
    null;

  const dueTime =
    isoOrNull(order.dueTime) ??
    isoOrNull(order.deliveryTime) ??
    isoOrNull(order.pickupTime) ??
    isoOrNull(order.fireTime);

  // Zuppler splits money into subtotal / delivery / service / tax / tip /
  // total. Each maps to its own column so the stored figures reconcile to
  // customerTotal; the tip is the driver's money and prints on the ticket.
  const discount = money(totals.discount);

  return {
    externalId: str(order.uuid),
    state: str(order.state)?.toLowerCase() ?? null,
    zupplerRestaurantId:
      cart.restaurantId != null ? String(cart.restaurantId) : null,
    canonical: {
      orderNumber: str(order.shortUuid) ?? str(order.ivrCode) ?? str(order.uuid) ?? "",
      ticketRestaurantName: null,
      // Zuppler knows when the order was actually placed; use it rather than
      // the moment we happened to ingest, which differs by days on a replay.
      receivedAt:
        isoOrNull(order.createdAt) ??
        isoOrNull(order.confirmationTime) ??
        null,
      orderType,
      dueTime,
      customerName: str(customer.name),
      customerPhone: str(customer.phone),
      customerAddress: (() => {
        const a = cart.settings?.service?.address;
        if (!a) return null;
        // Prefer their preformatted "full"; otherwise assemble the parts.
        const full = str(a.full);
        // "street, city, ST zip" - state and zip belong together, not comma
        // separated, or the address reads wrong on a driver's ticket.
        const stateZip = [str(a.state), str(a.zip)].filter(Boolean).join(" ");
        const parts = [str(a.street), str(a.city), stateZip || null]
          .filter(Boolean)
          .join(", ");
        const base = full ?? (parts || null);
        const extra = [str(a.crossStreet), str(a.deliveryInstructions)].filter(Boolean);
        return base ? [base, ...extra].join(" | ") : (extra.join(" | ") || null);
      })(),
      items,
      itemsTotal: money(totals.subtotal),
      tax: money(totals.tax),
      serviceFee: money(totals.service),
      deliveryFee: money(totals.delivery),
      tip: money(totals.tip),
      customerTotal: money(totals.total),
      paymentType: str(cart.settings?.tender?.id),
      notes:
        discount != null && discount !== 0
          ? [notes, `Discount applied: $${Math.abs(discount).toFixed(2)}`]
              .filter(Boolean)
              .join(" | ")
          : notes,
      rawPayload: resp,
    },
  };
}

/** Fetches the full order from Zuppler's GraphQL API by uuid. */
export async function fetchZupplerOrder(orderUuid: string): Promise<any> {
  const res = await fetch(ZUPPLER_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: LOAD_ORDER_QUERY,
      variables: { order_uuid: orderUuid },
    }),
  });
  if (!res.ok) {
    throw new Error(`Zuppler GraphQL ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Zuppler GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json;
}

/**
 * Plausibility check on mapped money, to catch a units mismatch.
 *
 * ZUPPLER_AMOUNTS decides whether their integers are cents or dollars, and
 * getting it wrong does not throw - it prints a ticket that looks entirely
 * normal with every figure 100x off. Note that internal consistency cannot
 * detect this: in the wrong mode every field scales together, so
 * subtotal + tax + fees + tip still equals the total. Only magnitude gives
 * it away, which is why the ceiling is a restaurant-sized order rather than
 * a generous round number - a real $84.34 order read as dollars is $8,434.
 *
 * Returns a human-readable reason when something looks wrong, else null.
 */
export function implausibleTotalReason(
  canonical: { customerTotal?: number | null; itemsTotal?: number | null }
): string | null {
  const total = canonical.customerTotal;
  if (total == null) return "no order total was mapped";
  if (!Number.isFinite(total)) return `order total is not a number (${total})`;
  if (total < 0) return `order total is negative (${total})`;

  const max = Number(process.env.ZUPPLER_MAX_ORDER_TOTAL || 1000);
  const min = Number(process.env.ZUPPLER_MIN_ORDER_TOTAL || 1);
  if (total > max) {
    return `order total $${total.toFixed(2)} exceeds $${max} - check ZUPPLER_AMOUNTS (cents vs dollars)`;
  }
  if (total < min) {
    return `order total $${total.toFixed(2)} is under $${min} - check ZUPPLER_AMOUNTS (cents vs dollars)`;
  }
  // Subtotal larger than the total means fields are mismatched or mis-scaled.
  const items = canonical.itemsTotal;
  if (items != null && Number.isFinite(items) && items > total + 0.01) {
    return `subtotal $${items.toFixed(2)} exceeds total $${total.toFixed(2)}`;
  }
  return null;
}
