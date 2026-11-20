/**
 * Pull in Zuppler orders whose only delivery we refused (2026-11-18, Perry's
 * Smokin Pig). Zuppler usually sends each order twice: once with our token and
 * once without. When only the unsigned copy comes, the webhook answers 401 and
 * the order is lost; the health check could name it but nothing fetched it.
 *
 * With ZUPPLER_ACCEPT_UNSIGNED on, the monitor's every-minute run takes each
 * refused delivery from the last 24 hours that named an order which is still
 * not in `orders`, and ingests it with ingestZupplerOrderByUuid: the order is
 * fetched from Zuppler's own API with our credentials, exactly as for a signed
 * call. Nothing from the refused body is used except the id. Off = nothing runs.
 */
import { supabaseAdmin } from "./supabase-server";
import { acceptUnsignedEnabled, isUuidShaped, orderUuidFromRawBody } from "./zuppler-webhook-auth";
import { ingestZupplerOrderByUuid } from "./zuppler-ingest";
import { recordWebhookReceipt } from "./webhook-receipts";

/** The signed copy usually lands seconds after the unsigned one; wait this long first. */
export const RECOVER_GRACE_MS = 2 * 60 * 1000;
export const RECOVER_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RECOVER_MAX_PER_RUN = 5;
export const RECOVER_AGENT = "monitor-recover";

export interface RefusedRow {
  order_uuid?: string | null;
  raw_body?: string | null;
  received_at?: string | null;
}

/** Pure: which refused orders to fetch now, oldest first, at most `max`. */
export function refusedToRecover(rows: RefusedRow[], inSystem: Set<string>, nowMs: number, max = RECOVER_MAX_PER_RUN): string[] {
  const picked: { uuid: string; at: number }[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const uuid = (r.order_uuid || orderUuidFromRawBody(r.raw_body) || "").trim();
    if (!isUuidShaped(uuid) || seen.has(uuid) || inSystem.has(uuid)) continue;
    const at = r.received_at ? Date.parse(r.received_at) : NaN;
    if (!Number.isFinite(at) || nowMs - at < RECOVER_GRACE_MS || nowMs - at > RECOVER_WINDOW_MS) continue;
    seen.add(uuid);
    picked.push({ uuid, at });
  }
  return picked.sort((a, b) => a.at - b.at).slice(0, max).map((p) => p.uuid);
}

export interface RecoverResult {
  enabled: boolean;
  tried: number;
  recovered: number;
  failed: number;
}

export async function recoverRefusedZupplerOrders(now = new Date(), env: Record<string, string | undefined> = process.env): Promise<RecoverResult> {
  if (!acceptUnsignedEnabled(env)) return { enabled: false, tried: 0, recovered: 0, failed: 0 };
  const admin = supabaseAdmin();
  const since = new Date(now.getTime() - RECOVER_WINDOW_MS).toISOString();
  const { data: refused, error } = await admin
    .from("webhook_receipts")
    .select("order_uuid, raw_body, received_at")
    .eq("source", "zuppler")
    .eq("status", "unauthorized")
    .gte("received_at", since);
  if (error || !refused?.length) return { enabled: true, tried: 0, recovered: 0, failed: 0 };
  const named = [...new Set(refused.map((r: RefusedRow) => (r.order_uuid || orderUuidFromRawBody(r.raw_body) || "").trim()).filter(isUuidShaped))];
  if (!named.length) return { enabled: true, tried: 0, recovered: 0, failed: 0 };
  const { data: have, error: haveErr } = await admin.from("orders").select("external_id").in("external_id", named);
  if (haveErr) return { enabled: true, tried: 0, recovered: 0, failed: 0 };
  const inSystem = new Set<string>((have ?? []).map((o: { external_id: string }) => String(o.external_id)));
  // One try per order: a not_found or unmapped answer would be the same next minute.
  const { data: tried } = await admin.from("webhook_receipts").select("order_uuid").eq("user_agent", RECOVER_AGENT).in("order_uuid", named);
  for (const t of tried ?? []) if (t.order_uuid) inSystem.add(String(t.order_uuid));
  const todo = refusedToRecover(refused, inSystem, now.getTime());
  let recovered = 0;
  let failed = 0;
  for (const uuid of todo) {
    const result = await ingestZupplerOrderByUuid(uuid);
    const ok = ["created", "updated", "duplicate", "cancelled"].includes(result.status);
    if (ok) recovered++;
    else failed++;
    await recordWebhookReceipt({
      status: result.status === "error" ? "ingest_error" : result.status,
      httpStatus: undefined,
      orderUuid: uuid,
      orderId: result.orderId ?? null,
      detail: `recovered by the monitor from a refused (unsigned) delivery${result.error ? `: ${result.error}` : ""}${result.status === "unmapped" ? ` - zuppler_restaurant_id ${result.zupplerRestaurantId}` : ""}`.slice(0, 500),
      userAgent: RECOVER_AGENT,
    });
  }
  return { enabled: true, tried: todo.length, recovered, failed };
}

/**
 * Orders dropped as "unmapped" whose listing has been registered since
 * (2026-11-20, Perry's Smokin Pig: the delivery listing 29897 was linked in
 * the CRM but never sent here, so order ddf5ebfc was turned away twice; the
 * listing was sent 20 minutes later and nothing fetched the order).
 *
 * Every minute the monitor takes each unmapped receipt from the last three
 * hours whose zuppler_restaurant_id is now in restaurant_zuppler_ids and whose
 * order is still not in `orders`, and ingests it the normal way - so the
 * kitchen gets its ticket and the CRM gets the order. Three hours, not a day:
 * this is a live ingest (print, alert, email), right for an order still being
 * cooked and wrong for yesterday's, which scripts/backfill-zuppler-orders.ts
 * adds silently. One try per order. Not tied to ZUPPLER_ACCEPT_UNSIGNED: the
 * id comes from our own receipt and the order from Zuppler's API.
 */
export const MAPPED_RECOVER_WINDOW_MS = 3 * 60 * 60 * 1000;
export const MAPPED_RECOVER_AGENT = "monitor-recover-mapped";

export interface UnmappedRow {
  order_uuid?: string | null;
  detail?: string | null;
  received_at?: string | null;
}

/** "zuppler_restaurant_id 29897" (the webhook's and the recovery's detail) -> "29897". */
export function zupplerIdFromDetail(detail: string | null | undefined): string | null {
  return /zuppler_restaurant_id\s+(\d+)/.exec(detail ?? "")?.[1] ?? null;
}

/** Pure: which dropped orders to fetch now that their listing is mapped, oldest first, at most `max`. */
export function unmappedToRecover(rows: UnmappedRow[], mappedIds: Set<string>, skip: Set<string>, nowMs: number, max = RECOVER_MAX_PER_RUN): string[] {
  const picked: { uuid: string; at: number }[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const uuid = (r.order_uuid ?? "").trim();
    const zid = zupplerIdFromDetail(r.detail);
    if (!isUuidShaped(uuid) || seen.has(uuid) || skip.has(uuid) || !zid || !mappedIds.has(zid)) continue;
    const at = r.received_at ? Date.parse(r.received_at) : NaN;
    if (!Number.isFinite(at) || nowMs - at > MAPPED_RECOVER_WINDOW_MS || at > nowMs) continue;
    seen.add(uuid);
    picked.push({ uuid, at });
  }
  return picked.sort((a, b) => a.at - b.at).slice(0, max).map((p) => p.uuid);
}

export async function recoverNewlyMappedZupplerOrders(now = new Date()): Promise<RecoverResult> {
  const none = { enabled: true, tried: 0, recovered: 0, failed: 0 };
  const admin = supabaseAdmin();
  const since = new Date(now.getTime() - MAPPED_RECOVER_WINDOW_MS).toISOString();
  const { data: dropped, error } = await admin
    .from("webhook_receipts")
    .select("order_uuid, detail, received_at")
    .eq("source", "zuppler")
    .eq("status", "unmapped")
    .gte("received_at", since);
  if (error || !dropped?.length) return none;
  const zids = [...new Set(dropped.map((r: UnmappedRow) => zupplerIdFromDetail(r.detail)).filter((x): x is string => !!x))];
  const uuids = [...new Set(dropped.map((r: UnmappedRow) => (r.order_uuid ?? "").trim()).filter(isUuidShaped))];
  if (!zids.length || !uuids.length) return none;
  const { data: mapped, error: mapErr } = await admin.from("restaurant_zuppler_ids").select("zuppler_restaurant_id").in("zuppler_restaurant_id", zids);
  if (mapErr || !mapped?.length) return none;
  const mappedIds = new Set<string>(mapped.map((m: { zuppler_restaurant_id: string }) => String(m.zuppler_restaurant_id)));
  const { data: have, error: haveErr } = await admin.from("orders").select("external_id").in("external_id", uuids);
  if (haveErr) return none;
  const skip = new Set<string>((have ?? []).map((o: { external_id: string }) => String(o.external_id)));
  const { data: tried } = await admin.from("webhook_receipts").select("order_uuid").eq("user_agent", MAPPED_RECOVER_AGENT).in("order_uuid", uuids);
  for (const t of tried ?? []) if (t.order_uuid) skip.add(String(t.order_uuid));
  const todo = unmappedToRecover(dropped, mappedIds, skip, now.getTime());
  let recovered = 0;
  let failed = 0;
  for (const uuid of todo) {
    const result = await ingestZupplerOrderByUuid(uuid);
    const ok = ["created", "updated", "duplicate", "cancelled"].includes(result.status);
    if (ok) recovered++;
    else failed++;
    await recordWebhookReceipt({
      status: result.status === "error" ? "ingest_error" : result.status,
      httpStatus: undefined,
      orderUuid: uuid,
      orderId: result.orderId ?? null,
      detail: `recovered by the monitor: its listing was registered after the order was dropped as unmapped${result.error ? `: ${result.error}` : ""}${result.status === "unmapped" ? ` - zuppler_restaurant_id ${result.zupplerRestaurantId}` : ""}`.slice(0, 500),
      userAgent: MAPPED_RECOVER_AGENT,
    });
  }
  return { enabled: true, tried: todo.length, recovered, failed };
}
