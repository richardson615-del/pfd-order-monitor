import { NextRequest, NextResponse } from "next/server";
import { ingestZupplerOrderByUuid } from "@/lib/zuppler-ingest";

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
 * The webhook is thin - the full order is fetched from Zuppler's GraphQL API
 * by ingestZupplerOrderByUuid(), which the receipt-email path also uses, so
 * both routes produce identical orders.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Finds order_uuid anywhere reasonable in the webhook body. */
function extractOrderUuid(body: any): string | null {
  if (!body || typeof body !== "object") return null;
  const direct =
    body.order_uuid ?? body.orderUuid ?? body.uuid ?? body.order?.uuid;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
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
    return NextResponse.json({ error: "no order_uuid in payload" }, { status: 422 });
  }

  const result = await ingestZupplerOrderByUuid(orderUuid);

  switch (result.status) {
    case "error":
      // 500 so Zuppler retries - transient API failures self-heal.
      console.error("Zuppler ingest failed for", orderUuid, result.error);
      return NextResponse.json({ error: result.error }, { status: 500 });
    case "not_found":
      return NextResponse.json({ error: "order not found at Zuppler" }, { status: 422 });
    case "unmapped":
      // 200 so retries stop; the mapping just needs adding in admin. The id is
      // logged because it is the only way to discover what to map it to.
      console.error(
        "Zuppler webhook: no restaurant mapped for zuppler_restaurant_id",
        result.zupplerRestaurantId,
        "- order_uuid", orderUuid, "(replayable once mapped)"
      );
      return NextResponse.json({ ok: false, error: "unmapped restaurant" });
    case "cancelled":
      return NextResponse.json({ ok: true, status: "cancelled", orderId: result.orderId });
    default:
      return NextResponse.json({ ok: true, ...result });
  }
}
