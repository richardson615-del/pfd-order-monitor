/**
 * A link from an order in the CRM back to the same order in Zuppler's
 * customer-service area (M1b, Nick 2026-09-18), so a dispatcher can edit
 * or refund it there.
 *
 * Zuppler gives us no such link: what we store as raw_payload is the
 * LoadOrder GraphQL response (lib/zuppler-mapper.ts), and GraphQL returns
 * only what the query selects - no field in that selection set is a URL.
 * So the address is built from a template the office sets in the
 * environment, ZUPPLER_ORDER_URL_TEMPLATE, once Nick has pasted a real
 * order link and we know its shape. Never a guessed hostname: with the
 * template unset the link is null and the CRM shows no button.
 *
 * Placeholders: {order_uuid} (Zuppler's uuid, our external_id),
 * {order_number} (their shortUuid, what a ticket shows), {restaurant_id}
 * (Zuppler's numeric restaurant id, restaurants.zuppler_restaurant_id).
 * Values are URL-encoded into place. A placeholder whose value we do not
 * have makes the whole link null - half an address opens the wrong page.
 */

export const ZUPPLER_URL_PLACEHOLDERS = ["order_uuid", "order_number", "restaurant_id"] as const;
export type ZupplerUrlPlaceholder = (typeof ZUPPLER_URL_PLACEHOLDERS)[number];

export interface ZupplerLinkInput {
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
    out = out.split(token).join(encodeURIComponent(v.trim()));
  }
  // Anything still in braces is a placeholder this file does not know -
  // a typo in the template, not an address.
  if (/\{[a-z_]+\}/i.test(out)) return null;
  return out;
}

/** The template from the environment, or null when unset. */
export function zupplerUrlTemplate(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = (env.ZUPPLER_ORDER_URL_TEMPLATE ?? "").trim();
  return t || null;
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
  template: string | null
): ZupplerLink | null {
  if (order.source !== "zuppler") return null;
  const order_uuid = order.external_id ?? null;
  const restaurant_id = restaurant?.zuppler_restaurant_id ?? null;
  return {
    order_uuid,
    restaurant_id,
    admin_url: zupplerAdminUrl(template, { order_uuid, order_number: order.order_number, restaurant_id }),
  };
}
