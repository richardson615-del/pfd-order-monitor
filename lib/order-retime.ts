import { supabaseAdmin } from "@/lib/supabase-server";
import { readyByFor, refuseReadyChange } from "@/lib/ready-timer";
import { runningLateLog } from "@/lib/cook-time";
import { recordCookTimeChange } from "@/lib/cook-time-data";

/**
 * Re-time ONE accepted order for the CRM (set_ready, CRM Ticket #1447,
 * 2026-11-10): dispatch moved a kitchen's ready time at the restaurant's
 * request. It is the tablet's Running late, made by the office:
 *
 *   - the same guard (refuseReadyChange "retime": accepted, not ready, not
 *     cancelled or completed), so the CRM can't re-time what the kitchen can't;
 *   - `minutes` counted from Accept, so ready_by = accepted_at + minutes;
 *   - the write can't overwrite READY (`ready_at IS NULL` on the update);
 *   - the same cook_time_log row, source "crm", actor = the CRM user.
 *
 * Nothing is pushed: the tablet and Partner app read ready_by on their next poll.
 */
export type RetimeResult =
  | { ok: true; ready_by: string | null; ready_minutes: number; before_ready_by: string | null }
  | { ok: false; status: 404 | 409 | 400; code: string; error: string };

export async function retimeOrderForCrm(orderId: string, minutes: number, actor: string): Promise<RetimeResult> {
  const admin = supabaseAdmin();
  const { data: timed } = await admin
    .from("orders")
    .select("id, restaurant_id, order_number, status, accepted_at, ready_by, ready_minutes, ready_at")
    .eq("id", orderId)
    .maybeSingle();
  if (!timed) return { ok: false, status: 404, code: "order_not_found", error: "order not found" };
  const refused = refuseReadyChange(timed, "retime");
  if (refused) return { ok: false, status: 409, ...refused };
  const { data: after, error } = await admin
    .from("orders")
    .update({ ready_minutes: minutes, ready_by: readyByFor(timed.accepted_at, minutes) })
    .eq("id", orderId)
    .is("ready_at", null)
    .select("ready_by, ready_minutes")
    .maybeSingle();
  if (error) return { ok: false, status: 400, code: "update_failed", error: error.message };
  // The kitchen tapped READY between the read and the write: nothing changed.
  if (!after) return { ok: false, status: 409, code: "already_ready", error: "this order is already ready" };
  await recordCookTimeChange(admin, runningLateLog(timed, after.ready_by, { source: "crm", actor }));
  return { ok: true, ready_by: after.ready_by ?? null, ready_minutes: after.ready_minutes ?? minutes, before_ready_by: timed.ready_by ?? null };
}
