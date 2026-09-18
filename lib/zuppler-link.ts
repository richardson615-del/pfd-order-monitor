/**
 * A link from an order in the CRM back to the same order in Zuppler's
 * customer-service area (M1b, Nick 2026-09-18), so a dispatcher can edit
 * or refund it there.
 *
 * Zuppler gives us no such link: what we store as raw_payload is the
 * LoadOrder GraphQL response (lib/zuppler-mapper.ts), and GraphQL returns
 * only what the query selects - no field in that selection set is a URL.
 *
 * The shape is known (FACT, Nick 2026-09-18, from a real link in Zuppler
 * customer service, confirmed on a second order from a different
 * restaurant):
 *
 *   https://customer-service.zuppler.com/#/lists/<list id>/order/<order uuid>
 *
 * where the list id is ONE saved list shared by every restaurant (it did
 * not change between the two orders) and the order uuid is the same value
 * the webhook hands us and the mapper stores as external_id (order.uuid).
 * So the default template below needs only the list id, from
 * ZUPPLER_CS_LIST_ID; ZUPPLER_ORDER_URL_TEMPLATE overrides the whole
 * template if Zuppler ever moves. With neither set the link is null and
 * the CRM shows no button - never a guessed address.
 *
 * Placeholders: {list_id}, {order_uuid} (Zuppler's uuid, our external_id
 * - refused unless it is uuid-shaped, because the link's order segment
 * is), {order_number} (their shortUuid, what a ticket shows),
 * {restaurant_id} (Zuppler's numeric restaurant id). Values are
 * URL-encoded into place. A placeholder whose value we do not have makes
 * the whole link null - half an address opens the wrong page.
 */

export const ZUPPLER_CS_URL_TEMPLATE_DEFAULT = "https://customer-service.zuppler.com/#/lists/{list_id}/order/{order_uuid}";

export const ZUPPLER_URL_PLACEHOLDERS = ["list_id", "order_uuid", "order_number", "restaurant_id"] as const;
export type ZupplerUrlPlaceholder = (typeof ZUPPLER_URL_PLACEHOLDERS)[number];

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ZupplerLinkInput {
  list_id?: string | null | undefined;
  order_uuid: string | null | undefined;
  order_number: string | null | undefined;
  restaurant_id: string | null | undefined;
}

export function zupplerAdminUrl(template: string | null | undefined, values: ZupplerLinkInput): string | null {
  const t = (template ?? "").trim();
  if (!/^https?:\/\//i.test(t)) return null;
  let out = t;
  for (const key of ZUPPLER_URL_PLACEHOLDERS) {
    const token = `{${key}}`;
    if (!out.includes(token)) continue;
    const v = values[key];
    if (typeof v !== "string" || !v.trim()) return null;
    // The CS link's order segment is a uuid. An external_id that is not
    // one is not that order's address, whatever else it might be.
    if (key === "order_uuid" && !UUID_SHAPE.test(v.trim())) return null;
    out = out.split(token).join(encodeURIComponent(v.trim()));
  }
  // Anything still in braces is a placeholder this file does not know -
  // a typo in the template, not an address.
  if (/\{[a-z_]+\}/i.test(out)) return null;
  return out;
}

/**
 * The template: ZUPPLER_ORDER_URL_TEMPLATE when set (Zuppler moved),
 * otherwise the customer-service shape above. Always a string now; what
 * makes the LINK null is a missing value - the list id, in practice.
 */
export function zupplerUrlTemplate(env: NodeJS.ProcessEnv = process.env): string {
  const t = (env.ZUPPLER_ORDER_URL_TEMPLATE ?? "").trim();
  return t || ZUPPLER_CS_URL_TEMPLATE_DEFAULT;
}

/** The one saved list every restaurant's orders sit under, from ZUPPLER_CS_LIST_ID; null when unset. */
export function zupplerListId(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = (env.ZUPPLER_CS_LIST_ID ?? "").trim();
  return v || null;
}

export interface ZupplerLink {
  order_uuid: string | null;
  restaurant_id: string | null;
  admin_url: string | null;
}

/** The `zuppler` object on an order detail: null for anything that did not come from Zuppler. */
export function zupplerLinkFor(
  order: { source: string | null; external_id?: string | null; order_number: string },
  restaurant: { zuppler_restaurant_id?: string | null } | null | undefined,
  template: string | null,
  listId: string | null = null
): ZupplerLink | null {
  if (order.source !== "zuppler") return null;
  const order_uuid = order.external_id ?? null;
  const restaurant_id = restaurant?.zuppler_restaurant_id ?? null;
  return {
    order_uuid,
    restaurant_id,
    admin_url: zupplerAdminUrl(template, { list_id: listId, order_uuid, order_number: order.order_number, restaurant_id }),
  };
}
