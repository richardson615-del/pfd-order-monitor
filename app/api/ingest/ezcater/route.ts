import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { verifyEzCaterSignature } from "@/lib/ezcater-signature";
import { ingestEzCaterNotification, type EzCaterNotification } from "@/lib/ezcater-ingest";
import { recordWebhookReceipt, type ReceiptStatus } from "@/lib/webhook-receipts";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * ezCater order-event webhook (Phase 2, Matt 2026-09-28).
 *
 *   POST /api/ingest/ezcater
 *   X-Ezcater-Signature: <timestamp>.<hex HMAC-SHA256 of "timestamp.body">
 *   Body: { id, parent_type: "Caterer", parent_id, entity_type: "Order",
 *           entity_id, key, created_at, occurred_at, updated_at, payload: null }
 *
 * Shapes from https://api.ezcater.io/subscribing-to-order-notifications and
 * /subscription-create, never guessed. The secret is the subscriber's
 * webhookSecret, stored when /admin/ezcater created the subscriber
 * (ezcater_subscriber); EZCATER_WEBHOOK_SECRET overrides it if ever set.
 *
 * Every receipt is recorded (source 'ezcater') BEFORE the signature is
 * checked, like the Zuppler route: a refused notification is the one most
 * worth having evidence of. A fetch failure answers 500 so ezCater retries;
 * an unmapped or inactive location answers 200 - nothing to retry, and the
 * receipt says why.
 */

async function webhookSecret(): Promise<string | null> {
  const env = process.env.EZCATER_WEBHOOK_SECRET?.trim();
  if (env) return env;
  const { data } = await supabaseAdmin().from("ezcater_subscriber").select("webhook_secret").limit(1).maybeSingle();
  return data?.webhook_secret ?? null;
}

export async function POST(req: NextRequest) {
  const userAgent = req.headers.get("user-agent");
  const rawBody = await req.text().catch(() => "");
  const receipt = (status: ReceiptStatus, httpStatus: number, extra: { orderUuid?: string | null; detail?: string | null } = {}) =>
    recordWebhookReceipt({ source: "ezcater", status, httpStatus, rawBody, userAgent, ...extra });

  const check = verifyEzCaterSignature(req.headers.get("x-ezcater-signature"), rawBody, await webhookSecret());
  if (check.ok === false) {
    const reason = "reason" in check ? check.reason : "rejected";
    console.error("ezCater webhook REJECTED (401) -", reason, "- an order event may have been dropped.");
    await receipt("unauthorized", 401, { detail: `signature ${reason}` });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: EzCaterNotification;
  try {
    body = JSON.parse(rawBody);
  } catch {
    await receipt("invalid_json", 400);
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const orderUuid = typeof body?.entity_id === "string" ? body.entity_id : null;
  const tag = `${body?.key ?? "?"} ${body?.parent_id ?? "?"}${"ageSeconds" in check && check.ageSeconds !== null ? ` age=${check.ageSeconds}s` : ""}${body?.id ? ` notification=${body.id}` : ""}`;
  const result = await ingestEzCaterNotification(body);
  const detail = [tag, result.detail].filter(Boolean).join(" | ");

  switch (result.status) {
    case "error":
      console.error("ezCater ingest failed:", detail);
      await receipt("ingest_error", 500, { orderUuid, detail });
      return NextResponse.json({ error: result.detail }, { status: 500 });
    case "not_found":
      await receipt("not_found", 200, { orderUuid, detail });
      return NextResponse.json({ ok: false, status: result.status });
    default:
      await receipt(result.status, 200, { orderUuid, detail });
      return NextResponse.json({ ok: true, status: result.status });
  }
}
