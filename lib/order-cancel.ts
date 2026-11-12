import { displayOrderNo } from "./order-label";
import { supabaseAdmin } from "@/lib/supabase-server";
import { sendCancellationEmail } from "@/lib/canonical";
import { notifyRestaurant } from "@/lib/push";
import { cancelledPush, reopenedPush, reopenedStatus } from "@/lib/crm-orders";

/**
 * Cancel an order in the kitchen, for the CRM's Cancel order (2026-10-07).
 * The same three steps the Zuppler and ezCater cancels take - status
 * cancelled, any ticket not yet printed pulled, the email restaurant told -
 * plus a push to the tablet, because a phone customer's cancel has no
 * channel of its own to reach the restaurant. printed_at is never cleared:
 * a ticket that came out of a printer is a fact, and the CRM is told so it
 * can decide about the money.
 */
export async function cancelOrderForCrm(order: { id: string; restaurant_id: string; order_number: string | null; ticket_no?: number | null }, actor: string): Promise<{ was_printed: boolean; jobs_pulled: number; pushed: number }> {
  const admin = supabaseAdmin();
  const now = new Date().toISOString();
  const { data: before } = await admin.from("orders").select("printed_at").eq("id", order.id).maybeSingle();
  await admin.from("orders").update({ status: "cancelled", cancelled_at: now }).eq("id", order.id);
  const { data: pulled } = await admin
    .from("print_jobs")
    .update({ status: "failed", error: `order cancelled by ${actor}`, finished_at: now })
    .eq("order_id", order.id)
    .in("status", ["queued", "claimed"])
    .select("id");
  await sendCancellationEmail(order.id);
  const push = await notifyRestaurant(order.restaurant_id, { ...cancelledPush(displayOrderNo(order)), orderId: order.id }).catch(() => ({ sent: 0 }));
  if (before?.printed_at) {
    console.error("Phone order CANCELLED AFTER PRINTING - the kitchen may have started it:", JSON.stringify({ orderId: order.id, printed_at: before.printed_at, cancelled_at: now, actor }));
  }
  return { was_printed: Boolean(before?.printed_at), jobs_pulled: pulled?.length ?? 0, pushed: push.sent ?? 0 };
}

/**
 * The driver picked the order up (CRM action picked_up, 2026-11-09): completed,
 * as if the kitchen tapped Done. Guarded on status so a cancel or the
 * kitchen's own Done in between is never overwritten; completed_at keeps the
 * first stamp. Nothing printed is pulled - the food is already in the car.
 */
export async function completeOrderOnPickup(orderId: string): Promise<{ completed: boolean; completed_at: string | null }> {
  const admin = supabaseAdmin();
  const now = new Date().toISOString();
  const { data } = await admin
    .from("orders")
    .update({ status: "completed", completed_at: now })
    .eq("id", orderId)
    .not("status", "in", "(completed,cancelled)")
    .select("completed_at")
    .maybeSingle();
  if (data) return { completed: true, completed_at: data.completed_at ?? now };
  const { data: row } = await admin.from("orders").select("completed_at").eq("id", orderId).maybeSingle();
  return { completed: false, completed_at: row?.completed_at ?? null };
}

/**
 * Reopen a completed order (CRM action reopen, Matt 2026-11-10): back to the
 * furthest step it had reached before Done, completed_at cleared, and the tablet
 * pushed so it shows again. Guarded on status, so a second click or a cancel in
 * between changes nothing. printed_at, accepted_at and ready_at are kept: those
 * things happened.
 */
export async function reopenCompletedOrder(
  order: { id: string; restaurant_id: string; order_number: string | null; ticket_no?: number | null },
  actor: string
): Promise<{ reopened: boolean; status: string | null; pushed: number }> {
  const admin = supabaseAdmin();
  const { data: before } = await admin.from("orders").select("status, accepted_at, opened_at, printed_at").eq("id", order.id).maybeSingle();
  if (!before || before.status !== "completed") return { reopened: false, status: before?.status ?? null, pushed: 0 };
  const status = reopenedStatus(before);
  const { data } = await admin
    .from("orders")
    .update({ status, completed_at: null })
    .eq("id", order.id)
    .eq("status", "completed")
    .select("status")
    .maybeSingle();
  if (!data) return { reopened: false, status: null, pushed: 0 };
  console.log("Order reopened from the CRM:", JSON.stringify({ orderId: order.id, status, actor }));
  const push = await notifyRestaurant(order.restaurant_id, { ...reopenedPush(displayOrderNo(order)), orderId: order.id }).catch(() => ({ sent: 0 }));
  return { reopened: true, status, pushed: push.sent ?? 0 };
}
