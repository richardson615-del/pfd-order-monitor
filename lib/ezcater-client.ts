import type { EzCaterOrder, EzCaterOrderItem } from "./ezcater";

/**
 * The real ezCater client (Phase 2, Matt 2026-09-28) - the "real
 * implementation" #90's scaffold left for the day credentials existed.
 *
 * Every query, mutation, field and header below is copied from ezCater's
 * public docs, never guessed (read 2026-09-28):
 *   endpoint + headers  https://api.ezcater.io/using-graphql
 *   Caterers            https://api.ezcater.io/caterer-list
 *   Subscribers         https://api.ezcater.io/subscriber-list
 *   createSubscriber    https://api.ezcater.io/subscriber-create
 *   createSubscription  https://api.ezcater.io/subscription-create
 *   deleteSubscriptions https://api.ezcater.io/subscription-delete
 *   Order               https://api.ezcater.io/order-details
 *
 * The token is EZCATER_API_TOKEN (Vercel production only). It is sent raw in
 * `Authorization` - the docs say "using the generated token as its value",
 * not "Bearer <token>".
 */

export const EZCATER_GRAPHQL_URL = "https://api.ezcater.com/graphql";

export class EzCaterApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "EzCaterApiError";
  }
}

export function ezCaterTokenConfigured(): boolean {
  return !!process.env.EZCATER_API_TOKEN?.trim();
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** One named GraphQL operation ("all requests must be named"). Throws EzCaterApiError on HTTP or GraphQL errors. */
export async function ezCaterGraphql<T = any>(query: string, variables: Record<string, unknown> = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  const token = process.env.EZCATER_API_TOKEN?.trim();
  if (!token) throw new EzCaterApiError("EZCATER_API_TOKEN is not set");
  const res = await fetchImpl(EZCATER_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      "Apollographql-client-name": "PFD Order Monitor",
      "Apollographql-client-version": "1",
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new EzCaterApiError(`ezCater answered ${res.status} with non-JSON`, res.status);
  }
  // Errors come back as a non-empty `errors` array beside `data` (troubleshooting page).
  if (Array.isArray(json?.errors) && json.errors.length) {
    throw new EzCaterApiError(json.errors.map((e: any) => e?.message ?? String(e)).join("; "), res.status);
  }
  if (!res.ok) throw new EzCaterApiError(`ezCater answered ${res.status}`, res.status);
  return json.data as T;
}

// ---- Caterers ------------------------------------------------------------------

export const CATERERS_QUERY = `query Caterers($ids: [ID!], $uuids: [ID!]) {
  caterers(ids: $ids, uuids: $uuids) {
    address { city deliveryInstructions name state stateName street street2 street3 zip }
    live
    name
    storeNumber
    uuid
  }
}`;

export interface EzCaterCaterer {
  uuid: string;
  name: string;
  storeNumber: string | null;
  live: boolean | null;
  address: Record<string, string | null> | null;
}

/** Every caterer location this API user can see. No paging, per the docs. */
export async function listCaterers(fetchImpl?: typeof fetch): Promise<EzCaterCaterer[]> {
  const data = await ezCaterGraphql<{ caterers: any[] | null }>(CATERERS_QUERY, {}, fetchImpl);
  return (data.caterers ?? []).map((c) => ({
    uuid: String(c.uuid),
    name: String(c.name ?? ""),
    storeNumber: c.storeNumber ?? null,
    live: typeof c.live === "boolean" ? c.live : null,
    address: c.address ?? null,
  }));
}

// ---- Subscribers & subscriptions -------------------------------------------------

export const SUBSCRIBERS_QUERY = `query Subscribers {
  subscribers {
    id
    name
    subscriptions { eventEntity eventKey parentEntity parentId subscriberId }
    webhookUrl
  }
}`;

export const CREATE_SUBSCRIBER_MUTATION = `mutation CreateSubscriber($subscriberParams: CreateSubscriberFields!) {
  createSubscriber(subscriberParams: $subscriberParams) {
    subscriber {
      id
      name
      subscriptions { eventEntity eventKey parentEntity parentId subscriberId }
      webhookSecret
      webhookUrl
    }
  }
}`;

export const CREATE_SUBSCRIPTION_MUTATION = `mutation CreateSubscription($subscriptionParams: CreateSubscriptionFields!) {
  createSubscription(subscriptionParams: $subscriptionParams) {
    subscription { eventEntity eventKey parentEntity parentId subscriberId }
  }
}`;

/** The docs' only example deletes by caterer (every event for it); nothing narrower is documented. */
export const DELETE_SUBSCRIPTIONS_MUTATION = `mutation DeleteSubscriptions($parentId: ID!) {
  deleteSubscriptions(subscriptionsParams: { parentEntity: Caterer, parentId: $parentId }) { success }
}`;

export interface EzCaterSubscription {
  eventEntity: string;
  eventKey: string;
  parentEntity: string;
  parentId: string;
  subscriberId: string;
}

export interface EzCaterSubscriber {
  id: string;
  name: string;
  webhookUrl: string;
  subscriptions: EzCaterSubscription[];
}

export async function listSubscribers(fetchImpl?: typeof fetch): Promise<EzCaterSubscriber[]> {
  const data = await ezCaterGraphql<{ subscribers: EzCaterSubscriber[] | null }>(SUBSCRIBERS_QUERY, {}, fetchImpl);
  return data.subscribers ?? [];
}

/** Creates THE subscriber (one per API user). The secret comes back here and never again. */
export async function createSubscriber(name: string, webhookUrl: string, fetchImpl?: typeof fetch): Promise<EzCaterSubscriber & { webhookSecret: string }> {
  const data = await ezCaterGraphql<{ createSubscriber: { subscriber: any } }>(CREATE_SUBSCRIBER_MUTATION, { subscriberParams: { name, webhookUrl } }, fetchImpl);
  const s = data.createSubscriber?.subscriber;
  if (!s?.id || !s?.webhookSecret) throw new EzCaterApiError("createSubscriber returned no id or no webhookSecret");
  return s;
}

export async function createOrderSubscription(subscriberId: string, catererUuid: string, eventKey: string, fetchImpl?: typeof fetch): Promise<EzCaterSubscription> {
  const data = await ezCaterGraphql<{ createSubscription: { subscription: EzCaterSubscription } }>(
    CREATE_SUBSCRIPTION_MUTATION,
    { subscriptionParams: { eventEntity: "Order", eventKey, parentEntity: "Caterer", parentId: catererUuid, subscriberId } },
    fetchImpl
  );
  return data.createSubscription.subscription;
}

export async function deleteCatererSubscriptions(catererUuid: string, fetchImpl?: typeof fetch): Promise<boolean> {
  const data = await ezCaterGraphql<{ deleteSubscriptions: { success: boolean } }>(DELETE_SUBSCRIPTIONS_MUTATION, { parentId: catererUuid }, fetchImpl);
  return data.deleteSubscriptions?.success === true;
}

// ---- Order ---------------------------------------------------------------------

/** The documented Order query, verbatim, minus the optional fee-type filter (we want every fee, and the enum values are not on the page). */
export const ORDER_QUERY = `query Order($orderId: ID!) {
  order(id: $orderId) {
    deliveryId
    uuid
    caterer {
      address { city deliveryInstructions name state stateName street street2 street3 zip }
      live
      name
      storeNumber
      uuid
    }
    catererCart {
      feesAndDiscounts { cost { currency subunits subunitsV2 } name }
      orderItems {
        customizations { customizationId customizationTypeId customizationTypeName name posCustomizationId quantity }
        labelFor
        menuItemSizeId
        menuItemSizeName
        name
        noteToCaterer
        posItemId
        quantity
        specialInstructions
        totalInSubunits { currency subunits subunitsV2 }
        uuid
      }
      tableware {
        specialInstructions
        tablewareChoices { choiceUuid isIncluded itemCount name }
      }
      totals { catererTotalDue }
    }
    event {
      address { city deliveryInstructions name state stateName street street2 street3 zip }
      catererHandoffFoodTime
      contact { name phone }
      customerProvidedName
      headcount
      orderType
      thirdPartyDeliveryPartner
      timeZoneIdentifier
      timeZoneOffset
      timestamp
    }
    isTaxExempt
    lifecycle { orderIsCurrently }
    orderCustomer { firstName fullName lastName }
    orderNumber
    orderSourceType
    totals {
      customerTotalDue { currency subunits subunitsV2 }
      pointOfSaleIntegrationFee { currency subunits subunitsV2 }
      salesTax { currency subunits subunitsV2 }
      salesTaxRemittance { currency subunits subunitsV2 }
      subTotal { currency subunits subunitsV2 }
      tip { currency subunits subunitsV2 }
    }
  }
}`;

/** The order as ezCater returns it (data.order), or null when ezCater does not know the id. */
export async function fetchEzCaterOrderRaw(orderId: string, fetchImpl?: typeof fetch): Promise<any | null> {
  const data = await ezCaterGraphql<{ order: any | null }>(ORDER_QUERY, { orderId }, fetchImpl);
  return data.order ?? null;
}

/** Money is `{ subunits, subunitsV2 }` in cents; subunitsV2 is a string (the docs' example). */
function dollarsOf(m: any): number | null {
  if (!m) return null;
  const raw = m.subunitsV2 ?? m.subunits;
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) / 100 : null;
}

const clean = (s: unknown) => (typeof s === "string" && s.trim() ? s.trim() : null);

/**
 * ezCater's order -> our normalised EzCaterOrder (#90). Pure; tested against
 * the docs' own example response. Throws when the one thing we cannot guess
 * is missing (the id, the number, the caterer, a total) - an order with a
 * guessed total would misprice a real payout, which is worse than a loud
 * failure the webhook retries.
 */
export function mapEzCaterOrder(o: any): EzCaterOrder {
  const orderId = clean(o?.uuid);
  const orderNumber = clean(o?.orderNumber);
  const catererLocationId = clean(o?.caterer?.uuid);
  const subtotal = dollarsOf(o?.totals?.subTotal);
  const total = dollarsOf(o?.totals?.customerTotalDue);
  const missing = [!orderId && "uuid", !orderNumber && "orderNumber", !catererLocationId && "caterer.uuid", subtotal === null && "totals.subTotal", total === null && "totals.customerTotalDue"].filter(Boolean);
  if (missing.length) throw new EzCaterApiError(`ezCater order is missing ${missing.join(", ")}`);

  const lifecycle = String(o?.lifecycle?.orderIsCurrently ?? "").toLowerCase();
  const event = o?.event ?? {};
  const orderType = String(event.orderType ?? "").toUpperCase();
  const a = event.address ?? null;

  const items: EzCaterOrderItem[] = (o?.catererCart?.orderItems ?? []).map((it: any) => {
    const size = clean(it?.menuItemSizeName);
    const modifiers: string[] = [];
    for (const c of it?.customizations ?? []) {
      const name = clean(c?.name);
      if (!name) continue;
      const type = clean(c?.customizationTypeName);
      modifiers.push(type ? `${type}: ${name}` : name);
    }
    const note = clean(it?.noteToCaterer);
    if (note) modifiers.push(note);
    const label = clean(it?.labelFor);
    if (label) modifiers.push(`Label: ${label}`);
    return {
      name: size ? `${clean(it?.name) ?? "Item"} (${size})` : (clean(it?.name) ?? "Item"),
      quantity: Number(it?.quantity) || 1,
      total: dollarsOf(it?.totalInSubunits),
      modifiers,
      specialInstructions: clean(it?.specialInstructions),
    };
  });

  // The customer's delivery fee is a caterer-cart fee named "Delivery Fee" in
  // the docs' example; the other entries there ("Preferred Caterer Program",
  // "Rewards Promo") are ezCater's deductions from what the caterer is paid,
  // not the customer's bill. Everything stays in the raw payload.
  const fees = o?.catererCart?.feesAndDiscounts ?? [];
  const deliveryFees = fees.filter((f: any) => /delivery fee/i.test(String(f?.name ?? ""))).map((f: any) => dollarsOf(f?.cost) ?? 0);
  const deliveryFee = deliveryFees.length ? Math.round(deliveryFees.reduce((s: number, n: number) => s + n, 0) * 100) / 100 : null;

  const tableware = (o?.catererCart?.tableware?.tablewareChoices ?? [])
    .filter((t: any) => t?.isIncluded)
    .map((t: any) => `${clean(t?.name) ?? "item"}${t?.itemCount ? ` x${t.itemCount}` : ""}`);
  const notes = [
    clean(event.customerProvidedName) ? `Event: ${clean(event.customerProvidedName)}` : null,
    tableware.length ? `Tableware: ${tableware.join(", ")}` : null,
    clean(o?.catererCart?.tableware?.specialInstructions),
    event.thirdPartyDeliveryPartner ? `Delivery partner: ${event.thirdPartyDeliveryPartner}` : null,
    `ezCater #${orderNumber}`,
  ].filter(Boolean).join("\n");

  return {
    orderId: orderId!,
    orderNumber: orderNumber!,
    catererLocationId: catererLocationId!,
    status: /cancel|reject/.test(lifecycle) ? "cancelled" : "accepted",
    fulfillment: orderType === "TAKEOUT" ? "takeout" : "delivery",
    // The kitchen's deadline is the hand-off to the driver, not the event start.
    eventTime: clean(event.catererHandoffFoodTime) ?? clean(event.timestamp) ?? "",
    placedAt: null,
    headcount: typeof event.headcount === "number" ? event.headcount : null,
    contact: { name: clean(event.contact?.name) ?? clean(o?.orderCustomer?.fullName), phone: clean(event.contact?.phone) },
    deliveryAddress: a
      ? { street: [clean(a.street), clean(a.street2), clean(a.street3)].filter(Boolean).join(", ") || null, city: clean(a.city), state: clean(a.state), zip: clean(a.zip), instructions: clean(a.deliveryInstructions) }
      : null,
    items,
    money: { subtotal: subtotal!, tax: dollarsOf(o?.totals?.salesTax), deliveryFee, tip: dollarsOf(o?.totals?.tip), total: total! },
    notes,
  };
}
