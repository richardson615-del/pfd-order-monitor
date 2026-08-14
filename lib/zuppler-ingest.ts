import { supabaseAdmin } from "./supabase-server";
import { ingestOrder } from "./canonical";
import {
  fetchZupplerOrder,
  implausibleTotalReason,
  mapZupplerGraphqlOrder,
} from "./zuppler-mapper";

export interface ZupplerIngestResult {
  status: "created" | "updated" | "duplicate" | "cancelled" | "unmapped" | "not_found" | "error";
  orderId?: string;
  /** Zuppler's numeric restaurant id - logged so an unmapped one is findable. */
  zupplerRestaurantId?: string | null;
  error?: string;
}

/**
 * Fetch a Zuppler order by uuid, map it, and ingest it.
 *
 * Shared by the webhook and the receipt-email path so both produce byte
 * identical orders - the webhook and the email are only ever two ways of
 * learning the same order_uuid, never two different pipelines.
 */
export async function ingestZupplerOrderByUuid(
  orderUuid: string
): Promise<ZupplerIngestResult> {
  let mapped;
  try {
    mapped = mapZupplerGraphqlOrder(await fetchZupplerOrder(orderUuid));
  } catch (err: any) {
    return { status: "error", error: err?.message ?? "zuppler fetch failed" };
  }

  if (!mapped.externalId) return { status: "not_found" };
  if (!mapped.zupplerRestaurantId) {
    return { status: "unmapped", zupplerRestaurantId: null };
  }

  const admin = supabaseAdmin();

  // The webhook fires on cancel as well as create, so a payload may describe
  // an order that should NOT be made. Never let one become a fresh ticket.
  if (mapped.state && /cancel/.test(mapped.state)) {
    const { data: existing } = await admin
      .from("orders")
      .select("id")
      .eq("source", "zuppler")
      .eq("external_id", mapped.externalId)
      .maybeSingle();

    if (existing) {
      await admin
        .from("orders")
        .update({ status: "cancelled" })
        .eq("id", existing.id);
      // Pull any ticket that has not been picked up yet. One already printed
      // cannot be recalled - but nothing should print after a cancellation.
      await admin
        .from("print_jobs")
        .update({ status: "failed", error: "order cancelled", finished_at: new Date().toISOString() })
        .eq("order_id", existing.id)
        .in("status", ["queued", "claimed"]);
      console.log("Zuppler order cancelled", { orderId: existing.id, orderUuid });
      return { status: "cancelled", orderId: existing.id };
    }

    // Cancelled before we ever saw it: nothing to make, nothing to record.
    console.log("Zuppler cancel for an order we never ingested", { orderUuid });
    return { status: "cancelled" };
  }

  const { data: restaurant } = await admin
    .from("restaurants")
    .select("id, name")
    .eq("zuppler_restaurant_id", mapped.zupplerRestaurantId)
    .eq("is_active", true)
    .maybeSingle();

  if (!restaurant) {
    return { status: "unmapped", zupplerRestaurantId: mapped.zupplerRestaurantId };
  }

  // Never drop an order over suspect money - the kitchen still needs the
  // food - but do not present wrong figures as fact either.
  const moneyProblem = implausibleTotalReason(mapped.canonical);
  if (moneyProblem) {
    console.error("Zuppler order has implausible totals", {
      orderUuid,
      reason: moneyProblem,
      amountsMode: process.env.ZUPPLER_AMOUNTS || "cents",
      customerTotal: mapped.canonical.customerTotal,
    });
  }

  const result = await ingestOrder({
    source: "zuppler",
    externalId: mapped.externalId,
    restaurantId: restaurant.id,
    ...mapped.canonical,
    ticketRestaurantName: mapped.canonical.ticketRestaurantName ?? restaurant.name,
    notes: moneyProblem
      ? [`** CHECK TOTALS: ${moneyProblem} **`, mapped.canonical.notes]
          .filter(Boolean)
          .join(" | ")
      : mapped.canonical.notes,
  });

  if (result.status === "error") return { status: "error", error: result.error };
  return {
    status: result.status as "created" | "updated" | "duplicate",
    orderId: result.orderId,
    zupplerRestaurantId: mapped.zupplerRestaurantId,
  };
}
