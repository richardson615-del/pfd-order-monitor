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
 * KNOWN GAP: this query has no delivery address field. Until the right field
 * name is confirmed in graphiql (or with Zuppler), delivery tickets print
 * without an address. customerAddress stays null-safe throughout.
 */

export const ZUPPLER_GRAPHQL_ENDPOINT = "https://orders-api5.zuppler.com/graphql";

export const LOAD_ORDER_QUERY = `query LoadOrder($order_uuid: ID!) { order(id: $order_uuid) { uuid pickupTime paymentInfo { authorization dateTime } fireTime dueTime deliveryTime createdAt confirmationTime totals { delivery discount hidden includedTax service subtotal tax tip total } shortUuid state workflowId carts { channelId integrationId restaurantId comments instructions settings { service { id } tender { id } } customer { uuid name email phone } discounts { id title promocode } items { id category comments name menu menuId quantity itemTotal servingQty } } } }`;

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
    zupplerRestaurantId:
      cart.restaurantId != null ? String(cart.restaurantId) : null,
    canonical: {
      orderNumber: str(order.shortUuid) ?? str(order.ivrCode) ?? str(order.uuid) ?? "",
      ticketRestaurantName: null,
      orderType,
      dueTime,
      customerName: str(customer.name),
      customerPhone: str(customer.phone),
      customerAddress: null, // see KNOWN GAP above
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
