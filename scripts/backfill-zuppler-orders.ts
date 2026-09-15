/**
 * Backfills orders that bounced at the webhook because the receiving
 * restaurant wasn't yet registered in restaurant_zuppler_ids.
 *
 * scratch/webhook-receipts.json (a one-time export, not read here) showed
 * 792 webhook_receipts rows with status='unmapped' since 2026-09-08. This
 * script queries that same table live and, for every row whose
 * zuppler_restaurant_id IS now registered, replays the order_uuid through
 * the exact same fetchZupplerOrder()/mapZupplerGraphqlOrder() path the live
 * webhook uses (lib/zuppler-mapper.ts). No email parsing: Zuppler's own
 * GraphQL order API was confirmed (2026-09-15, against real Sep 8 order
 * uuids) to still serve a full order days after the original webhook
 * bounced, with no auth token and no expiry - so the original payload is
 * exactly reconstructable, not approximated from an emailed HTML ticket.
 *
 * Every inserted row is stamped ingested_via='replay_backfill' (migration
 * 033) so it is never mistaken for a live delivery. It deliberately does
 * NOT go through ingestOrder() / ingestZupplerOrderByUuid(): those queue a
 * print job, push a tablet alert and (for an email restaurant) send a
 * ticket email - all correct for an order arriving in real time, all wrong
 * for a five-day-old one. A backfilled order is inserted as 'completed'
 * with no delivery side effect of any kind.
 *
 * Cancellation guard: Zuppler's `state` field is checked directly on the
 * SAME replayed record - if Zuppler itself says an order was cancelled,
 * it is never inserted. No separate cancellation-email search is needed;
 * state is definitive and lives on the exact record being backfilled.
 *
 * Idempotent: dedupes on (source='zuppler', external_id=order_uuid), the
 * same key ingestOrder() uses - a webhook or poll that lands normally
 * before this runs is left untouched, and running this twice is a no-op.
 *
 * Usage:
 *   tsx scripts/backfill-zuppler-orders.ts [--production] [--write]
 * Without --write, nothing is inserted - only the plan is printed. Without
 * --production, targets whatever .env.local points at (dev).
 */
import { config } from "dotenv";
const isProduction = process.argv.includes("--production");
config({ path: isProduction ? ".env.production.local" : ".env.local" });
config();

import { createClient } from "@supabase/supabase-js";
import { fetchZupplerOrder, mapZupplerGraphqlOrder } from "../lib/zuppler-mapper";
import { moneyVariance } from "../lib/canonical";
import { resolveRestaurantByZupplerId } from "../lib/zuppler-ingest";

const WRITE = process.argv.includes("--write");
// Sep 8 2026 00:00 UTC: the start of the current payout week. Pre-Sep-8
// weeks were already settled by DataDreamers - not in scope for recovery.
const SINCE = "2026-09-08T00:00:00Z";

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.");
    process.exit(1);
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

interface PlanRow {
  order_uuid: string;
  restaurant_name: string;
  restaurant_id: string;
  zuppler_id: string;
  channel: string | null;
  received_at: string | null;
  customer_total: number | null;
  money_variance: number | null;
}

async function main() {
  const db = admin();
  console.log(`Mode: ${WRITE ? "WRITE" : "DRY RUN"}   Target: ${isProduction ? "PRODUCTION" : "dev"}\n`);

  const { data: receipts, error } = await db
    .from("webhook_receipts")
    .select("id, order_uuid, detail, received_at")
    .eq("status", "unmapped")
    .gte("received_at", SINCE)
    .order("received_at", { ascending: true })
    .limit(5000);
  if (error) throw error;

  const plan: PlanRow[] = [];
  const moneyFlagged: PlanRow[] = [];
  const skipped = {
    noUuid: 0,
    fetchError: [] as { order_uuid: string; error: string }[],
    cancelled: [] as { order_uuid: string; zuppler_id: string | null; state: string }[],
    stillUnregistered: [] as { order_uuid: string; zuppler_id: string | null }[],
    alreadyIngested: 0,
  };

  for (const r of receipts ?? []) {
    if (!r.order_uuid) {
      skipped.noUuid++;
      continue;
    }

    let mapped;
    try {
      mapped = mapZupplerGraphqlOrder(await fetchZupplerOrder(r.order_uuid));
    } catch (err: any) {
      skipped.fetchError.push({ order_uuid: r.order_uuid, error: err?.message ?? String(err) });
      continue;
    }
    if (!mapped.externalId) {
      skipped.fetchError.push({ order_uuid: r.order_uuid, error: "no order returned" });
      continue;
    }

    // Cancellation guard: Zuppler's own state on the record being replayed.
    if (mapped.state && /cancel/.test(mapped.state)) {
      skipped.cancelled.push({
        order_uuid: r.order_uuid,
        zuppler_id: mapped.zupplerRestaurantId,
        state: mapped.state,
      });
      continue;
    }

    const restaurant = await resolveRestaurantByZupplerId(db, mapped.zupplerRestaurantId);
    if (!restaurant) {
      skipped.stillUnregistered.push({ order_uuid: r.order_uuid, zuppler_id: mapped.zupplerRestaurantId });
      continue;
    }

    const { data: existing } = await db
      .from("orders")
      .select("id")
      .eq("source", "zuppler")
      .eq("external_id", mapped.externalId)
      .maybeSingle();
    if (existing) {
      skipped.alreadyIngested++;
      continue;
    }

    const variance = moneyVariance(mapped.canonical);
    const row: PlanRow = {
      order_uuid: r.order_uuid,
      restaurant_name: restaurant.name,
      restaurant_id: restaurant.id,
      zuppler_id: mapped.zupplerRestaurantId ?? "",
      channel: mapped.canonical.channelId ?? null,
      received_at: mapped.canonical.receivedAt,
      customer_total: mapped.canonical.customerTotal ?? null,
      money_variance: variance,
    };
    plan.push(row);
    if (variance != null && Math.abs(variance) > 0.01) moneyFlagged.push(row);

    if (WRITE) {
      const { error: insertError } = await db.from("orders").insert({
        source: "zuppler",
        external_id: mapped.externalId,
        restaurant_id: restaurant.id,
        gmail_message_id: null,
        order_number: mapped.canonical.orderNumber,
        ticket_restaurant_name: mapped.canonical.ticketRestaurantName ?? restaurant.name,
        order_type: mapped.canonical.orderType,
        due_time: mapped.canonical.dueTime,
        customer_name: mapped.canonical.customerName,
        customer_phone: mapped.canonical.customerPhone,
        customer_address: mapped.canonical.customerAddress,
        items: mapped.canonical.items,
        items_total: mapped.canonical.itemsTotal,
        tax: mapped.canonical.tax,
        service_fee: mapped.canonical.serviceFee,
        delivery_fee: mapped.canonical.deliveryFee,
        tip: mapped.canonical.tip,
        discount: mapped.canonical.discount,
        included_tax: mapped.canonical.includedTax,
        hidden_fee: mapped.canonical.hiddenFee,
        channel_id: mapped.canonical.channelId,
        customer_total: mapped.canonical.customerTotal,
        money_variance: variance,
        payment_type: mapped.canonical.paymentType,
        notes: mapped.canonical.notes,
        raw_payload: mapped.canonical.rawPayload,
        received_at: mapped.canonical.receivedAt,
        status: "completed",
        ingested_via: "replay_backfill",
      });
      if (insertError) {
        if (insertError.code === "23505") skipped.alreadyIngested++;
        else skipped.fetchError.push({ order_uuid: r.order_uuid, error: `insert: ${insertError.message}` });
      }
    }
  }

  console.log(`Unmapped receipts since ${SINCE}: ${receipts?.length ?? 0}\n`);
  console.log(`${WRITE ? "Inserted" : "Would insert"}: ${plan.length}`);
  for (const p of plan) {
    console.log(
      `  ${p.order_uuid}  ${p.restaurant_name} (zuppler ${p.zuppler_id})  ` +
        `channel=${p.channel ?? "?"}  ${p.received_at ?? "?"}  $${(p.customer_total ?? 0).toFixed(2)}` +
        (p.money_variance && Math.abs(p.money_variance) > 0.01 ? `  ** VARIANCE $${p.money_variance.toFixed(2)} **` : "")
    );
  }

  console.log(`\nSkipped - cancelled (Zuppler state): ${skipped.cancelled.length}`);
  for (const c of skipped.cancelled) console.log(`  ${c.order_uuid}  zuppler ${c.zuppler_id}  state=${c.state}`);

  console.log(`\nSkipped - restaurant still unregistered: ${skipped.stillUnregistered.length}`);
  const byZid = new Map<string, number>();
  for (const s of skipped.stillUnregistered) {
    const k = s.zuppler_id ?? "unknown";
    byZid.set(k, (byZid.get(k) ?? 0) + 1);
  }
  for (const [zid, count] of [...byZid.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${zid}: ${count}`);
  }

  console.log(`\nSkipped - already ingested (webhook/poll got there first): ${skipped.alreadyIngested}`);
  console.log(`Skipped - no order_uuid on the receipt: ${skipped.noUuid}`);
  console.log(`Skipped - fetch/insert error: ${skipped.fetchError.length}`);
  for (const e of skipped.fetchError.slice(0, 20)) console.log(`  ${e.order_uuid}: ${e.error}`);

  if (moneyFlagged.length) {
    console.log(`\n** ${moneyFlagged.length} row(s) inserted/planned with a non-zero money_variance - review before trusting the payout figure: **`);
    for (const m of moneyFlagged) console.log(`  ${m.order_uuid}  ${m.restaurant_name}  variance=$${m.money_variance!.toFixed(2)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
