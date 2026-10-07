import { supabaseAdmin } from "@/lib/supabase-server";
import { sendCancellationEmail } from "@/lib/canonical";
import { notifyRestaurant } from "@/lib/push";
import { cancelledPush } from "@/lib/crm-orders";

/**
 * Cancel an order in the kitchen, for the CRM's Cancel order (2026-10-07).
 * The same three steps the Zuppler and ezCater cancels take - status
 * cancelled, any ticket not yet printed pulled, the email restaurant told -
 * plus a push to the tablet, because a phone customer's cancel has no
 * channel of its own to reach the restaurant. printed_at is never cleared:
 * a ticket that came out of a printer is a fact, and the CRM is told so it
 * can decide about the money.
 */
export async function cancelOrderForCrm(order: { id: string; restaurant_id: string; order_number: string | null }, actor: string): Promise<{ was_printed: boolean; jobs_pulled: number; pushed: number }> {
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
  const push = await notifyRestaurant(order.restaurant_id, { ...cancelledPush(order.order_number), orderId: order.id }).catch(() => ({ sent: 0 }));
  if (before?.printed_at) {
    console.error("Phone order CANCELLED AFTER PRINTING - the kitchen may have started it:", JSON.stringify({ orderId: order.id, printed_at: before.printed_at, cancelled_at: now, actor }));
  }
  return { was_printed: Boolean(before?.printed_at), jobs_pulled: pulled?.length ?? 0, pushed: push.sent ?? 0 };
}
