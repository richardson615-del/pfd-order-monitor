import { NextRequest, NextResponse } from "next/server";
import { ingestZupplerOrderByUuid } from "@/lib/zuppler-ingest";
import { recordWebhookReceipt, fingerprint } from "@/lib/webhook-receipts";

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
  // Read the body FIRST, before the auth check, so a rejected receipt is
  // recorded with the payload that was refused. Two receipts arrived on
  // 2026-08-27 and produced no orders, and nothing anywhere could say which
  // rejection they hit - a live order being dropped left as much evidence as
  // nothing arriving at all.
  const userAgent = req.headers.get("user-agent");
  const rawBody = await req.text().catch(() => "");

  const secret = process.env.ZUPPLER_WEBHOOK_SECRET;
  // Zuppler sends the token in `api-token`, not `Authorization` - confirmed
  // from a real rejected receipt on 2026-08-28, whose recorded header list
  // named it. Until then every live order 401'd and the message said "token
  // mismatch", so the token was reset twice on both sides while the actual
  // cause was that nothing ever read the header carrying it.
  //
  // `authorization` stays accepted: it is what our own replays and any
  // manual curl use, and dropping it would break them for no gain.
  const authHeader = req.headers.get("authorization");
  const apiTokenHeader = req.headers.get("api-token");
  const presentedTokens = [
    apiTokenHeader?.trim(),
    authHeader?.replace(/^Bearer\s+/i, "").trim(),
  ].filter(Boolean) as string[];
  const ok = !!secret && presentedTokens.some((t) => t === secret);
  if (!ok) {
    // Loud. A 401 here means an order was dropped on the floor, which is
    // exactly the failure that once killed every live webhook silently while
    // Vercel held a token Zuppler did not have.
    console.error(
      "Zuppler webhook REJECTED (401) - a live order may have been dropped.",
      secret ? "Token mismatch." : "ZUPPLER_WEBHOOK_SECRET is not set.",
      "user-agent:", userAgent ?? "(none)"
    );
    // Two things a bare "token mismatch" cannot tell apart, and we have now
    // chased both blind: a stale secret on one side, or the token arriving
    // in a header we never look at. Record the header NAMES present and
    // fingerprints of each side - never the values.
    const presented = presentedTokens[0] ?? null;
    const headerNames = [...req.headers.keys()].sort().join(", ");
    await recordWebhookReceipt({
      status: "unauthorized", httpStatus: 401, rawBody, userAgent,
      detail: [
        secret ? "token mismatch" : "ZUPPLER_WEBHOOK_SECRET not set",
        `presented=${fingerprint(presented) ?? "NO AUTH HEADER"}`,
        `expected=${fingerprint(secret) ?? "unset"}`,
        `headers=[${headerNames}]`,
      ].join(" | "),
    });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    console.error("Zuppler webhook: body was not valid JSON - order dropped.");
    await recordWebhookReceipt({
      status: "invalid_json", httpStatus: 400, rawBody, userAgent,
    });
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const orderUuid = extractOrderUuid(body);
  if (!orderUuid) {
    console.error("Zuppler webhook: no order_uuid in payload - order dropped.");
    await recordWebhookReceipt({
      status: "no_order_uuid", httpStatus: 422, rawBody, userAgent,
    });
    return NextResponse.json({ error: "no order_uuid in payload" }, { status: 422 });
  }

  const result = await ingestZupplerOrderByUuid(orderUuid);
  const receipt = { orderUuid, rawBody, userAgent };

  switch (result.status) {
    case "error":
      // 500 so Zuppler retries - transient API failures self-heal.
      console.error("Zuppler ingest failed for", orderUuid, result.error);
      await recordWebhookReceipt({
        ...receipt, status: "ingest_error", httpStatus: 500, detail: result.error,
      });
      return NextResponse.json({ error: result.error }, { status: 500 });
    case "not_found":
      console.error("Zuppler webhook: order not found at Zuppler -", orderUuid);
      await recordWebhookReceipt({
        ...receipt, status: "not_found", httpStatus: 422,
      });
      return NextResponse.json({ error: "order not found at Zuppler" }, { status: 422 });
    case "unmapped":
      // 200 so retries stop; the mapping just needs adding in admin. The id is
      // logged because it is the only way to discover what to map it to.
      console.error(
        "Zuppler webhook: no restaurant mapped for zuppler_restaurant_id",
        result.zupplerRestaurantId,
        "- order_uuid", orderUuid, "(replayable once mapped)"
      );
      await recordWebhookReceipt({
        ...receipt, status: "unmapped", httpStatus: 200,
        detail: `zuppler_restaurant_id ${result.zupplerRestaurantId}`,
      });
      return NextResponse.json({ ok: false, error: "unmapped restaurant" });
    case "cancelled":
      await recordWebhookReceipt({
        ...receipt, status: "cancelled", httpStatus: 200, orderId: result.orderId,
      });
      return NextResponse.json({ ok: true, status: "cancelled", orderId: result.orderId });
    default:
      await recordWebhookReceipt({
        ...receipt,
        status: (result.status as any) === "updated" ? "updated"
              : (result.status as any) === "duplicate" ? "duplicate" : "created",
        httpStatus: 200, orderId: result.orderId,
      });
      return NextResponse.json({ ok: true, ...result });
  }
}
