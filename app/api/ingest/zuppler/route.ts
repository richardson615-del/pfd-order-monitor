import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { ingestOrder } from "@/lib/canonical";
import {
  fetchZupplerOrder,
  implausibleTotalReason,
  mapZupplerGraphqlOrder,
} from "@/lib/zuppler-mapper";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Zuppler order webhook (their real flow, per Zuppler's Feb 2026 spec):
 *
 *   POST /api/ingest/zuppler
 *   Authorization: <ZUPPLER_WEBHOOK_SECRET>   (exact match - the token we
 *   generated and shared with Zuppler; they send it verbatim, no "Bearer")
 *   Body: JSON containing order_uuid
 *
 * The webhook is thin - we fetch the full order from their GraphQL API,
 * map it to canonical, and ingest. Idempotent: Zuppler retries and
 * duplicate deliveries resolve to { status: "duplicate" }.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Finds order_uuid anywhere reasonable in the webhook body. */
function extractOrderUuid(body: any): string | null {
  if (!body || typeof body !== "object") return null;
  const direct =
    body.order_uuid ?? body.orderUuid ?? body.uuid ?? body.order?.uuid;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  // Shallow scan one level down for an order_uuid key
  for (const k of Object.keys(body)) {
    const v = body[k];
    if (v && typeof v === "object" && typeof v.order_uuid === "string") {
      return v.order_uuid.trim();
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  const secret = process.env.ZUPPLER_WEBHOOK_SECRET;
  const authHeader = req.headers.get("authorization");
  // Accept the raw token (Zuppler's filter model) or Bearer-prefixed
  const ok =
    !!secret && (authHeader === secret || authHeader === `Bearer ${secret}`);
  if (!ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const orderUuid = extractOrderUuid(body);
  if (!orderUuid) {
    return NextResponse.json(
      { error: "no order_uuid in payload" },
      { status: 422 }
    );
  }

  // Fast duplicate check before hitting Zuppler's API
  const admin = supabaseAdmin();
  const { data: existing } = await admin
    .from("orders")
    .select("id")
    .eq("source", "zuppler")
    .eq("external_id", orderUuid)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ ok: true, status: "duplicate", orderId: existing.id });
  }

  let mapped;
  try {
    const resp = await fetchZupplerOrder(orderUuid);
    mapped = mapZupplerGraphqlOrder(resp);
  } catch (err: any) {
    console.error("Zuppler fetch/map failed for", orderUuid, err?.message);
    // 500 so Zuppler/the bridge retries - transient API failures self-heal
    return NextResponse.json({ error: "order fetch failed" }, { status: 500 });
  }

  if (!mapped.externalId) {
    return NextResponse.json({ error: "order not found at Zuppler" }, { status: 422 });
  }

  if (!mapped.zupplerRestaurantId) {
    console.error("Zuppler order has no restaurantId", orderUuid);
    return NextResponse.json({ ok: false, error: "no restaurant id in order" });
  }

  const { data: restaurant } = await admin
    .from("restaurants")
    .select("id, name")
    .eq("zuppler_restaurant_id", mapped.zupplerRestaurantId)
    .eq("is_active", true)
    .maybeSingle();

  if (!restaurant) {
    // 200 so retries stop; the mapping just needs to be added in admin
    console.error(
      "Zuppler webhook: no restaurant mapped for zuppler_restaurant_id",
      mapped.zupplerRestaurantId
    );
    return NextResponse.json({ ok: false, error: "unmapped restaurant" });
  }

  // Never drop the order over suspect money - the kitchen still needs the
  // food. But do not present wrong figures as fact either: flag it on the
  // ticket so whoever reads it knows the totals are unverified.
  const moneyProblem = implausibleTotalReason(mapped.canonical);
  if (moneyProblem) {
    console.error("Zuppler order has implausible totals", {
      orderUuid,
      reason: moneyProblem,
      totals: {
        itemsTotal: mapped.canonical.itemsTotal,
        tax: mapped.canonical.tax,
        serviceFee: mapped.canonical.serviceFee,
        deliveryFee: mapped.canonical.deliveryFee,
        tip: mapped.canonical.tip,
        customerTotal: mapped.canonical.customerTotal,
      },
      amountsMode: process.env.ZUPPLER_AMOUNTS || "cents",
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

  if (result.status === "error") {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...result });
}
