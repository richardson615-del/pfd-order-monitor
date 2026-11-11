import { supabaseAdmin } from "./supabase-server";
import { ADVANCE_RELEASE_QUEUED_BY, ADVANCE_RELEASE_STALE_MS, advanceHoldMinutes, advanceReleaseDue } from "./advance-order";

export * from "./advance-order";

/**
 * The database half of the advance-order hold (CRM Ticket #1429). The rules,
 * and why an order can not be held and then never printed, are in
 * lib/advance-order.ts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface AdvanceReleaseResult {
  checked: number;
  released: number;
  restamped: number;
  errors: number;
}

/**
 * The minute sweep: queue the paper for every held order whose release time
 * has come. Never throws (the caller is the health cron); a failure for one
 * order is counted and the rest go on.
 */
export async function releaseAdvanceOrders(now: number = Date.now(), windowMinutes: number = advanceHoldMinutes()): Promise<AdvanceReleaseResult> {
  const out: AdvanceReleaseResult = { checked: 0, released: 0, restamped: 0, errors: 0 };
  if (windowMinutes <= 0) return out;
  const admin = supabaseAdmin();
  const nowIso = new Date(now).toISOString();

  // Released jobs still waiting for their printer keep their "asked for just now" stamp, so the age rule never expires them.
  try {
    const { data: waiting } = await admin.from("print_jobs").select("id").eq("queued_by", ADVANCE_RELEASE_QUEUED_BY).in("status", ["queued", "held"]).limit(200);
    if (waiting?.length) {
      const { error } = await admin
        .from("print_jobs")
        .update({ manual_reprint_at: nowIso })
        .in("id", waiting.map((j: any) => j.id));
      if (error) out.errors++;
      else out.restamped = waiting.length;
    }
  } catch (err) {
    out.errors++;
    console.error("advance hold: re-stamp failed -", err instanceof Error ? err.message : err);
  }

  let orders: any[] = [];
  try {
    const { data, error } = await admin
      .from("orders")
      .select("id, restaurant_id, source, due_time, received_at")
      .not("due_time", "is", null)
      .lte("due_time", new Date(now + windowMinutes * 60_000).toISOString())
      .gte("due_time", new Date(now - ADVANCE_RELEASE_STALE_MS).toISOString())
      .is("printed_at", null)
      .is("cancelled_at", null)
      .is("completed_at", null)
      .limit(300);
    if (error) throw new Error(error.message);
    orders = (data ?? []).filter((o: any) => o.source !== "test" && o.source !== "ezcater" && advanceReleaseDue(o, now, windowMinutes));
  } catch (err) {
    out.errors++;
    console.error("advance hold: could not read due orders -", err instanceof Error ? err.message : err);
    return out;
  }
  out.checked = orders.length;
  if (!orders.length) return out;

  // An order that already has a printer job (queued at ingest, released earlier, or reprinted by hand) is done here.
  const { data: jobs, error: jobsError } = await admin
    .from("print_jobs")
    .select("order_id")
    .in("order_id", orders.map((o) => o.id))
    .not("device_id", "is", null);
  if (jobsError) {
    out.errors++;
    console.error("advance hold: could not read existing jobs -", jobsError.message);
    return out;
  }
  const hasJob = new Set((jobs ?? []).map((j: any) => j.order_id));

  for (const o of orders) {
    if (hasJob.has(o.id)) continue;
    try {
      const { data: restaurant } = await admin.from("restaurants").select("id, print_method").eq("id", o.restaurant_id).maybeSingle();
      if (!restaurant || restaurant.print_method === "email") continue;
      const { data: devices } = await admin.from("print_devices").select("id").eq("restaurant_id", o.restaurant_id).eq("is_active", true);
      if (!devices?.length) continue;
      const { error } = await admin.from("print_jobs").insert(devices.map((d: any) => ({ order_id: o.id, device_id: d.id, queued_by: ADVANCE_RELEASE_QUEUED_BY, manual_reprint_at: nowIso })));
      if (error) throw new Error(error.message);
      out.released++;
      console.log("advance hold RELEASED", JSON.stringify({ order: o.id, due: o.due_time, printers: devices.length }));
    } catch (err) {
      out.errors++;
      console.error("advance hold: could not release", o.id, "-", err instanceof Error ? err.message : err);
    }
  }
  return out;
}
